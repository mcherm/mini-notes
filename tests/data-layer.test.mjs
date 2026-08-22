/**
 * Tests for html/data-layer.js's OfflineDataSource: the write-through of
 * server responses into the local mirror, and the serving of reads from the
 * mirror when the server is unreachable. The network side is a stub that
 * returns canned results; the store side is a real NoteStore over the fake
 * backend, so these tests also exercise the read barrier end to end.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { LoggedOutError } from "../html/api.js";
import { DELETE_NOTE, EDIT_NOTE, NEW_NOTE, RECOVER_NOTE } from "../html/commands.js";
import { OfflineDataSource } from "../html/data-layer.js";
import { NoteStore, NOTES_STORE } from "../html/store.js";
import { DELIVERY_IDLE, DELIVERY_RETRY } from "../html/sync-engine.js";
import { FakeBackend } from "./fake-backend.mjs";

/** A full note object, shaped as the server returns it. */
function makeNote(noteId, versionId) {
    return {
        user_id: "user_000001",
        note_id: noteId,
        version_id: versionId,
        title: `Title of ${noteId}`,
        body: `Body of ${noteId}`,
        create_time: "2026-08-01T10:00:00Z",
        modify_time: "2026-08-09T10:00:00Z",
        format: "PlainText",
        undo_stack: [],
    };
}

/** The note header the server's list endpoints would send for a note. */
function headerFor(note) {
    return {
        user_id: note.user_id,
        note_id: note.note_id,
        version_id: note.version_id,
        title: note.title,
        modify_time: note.modify_time,
        format: note.format,
    };
}

/** A network stub answering the one method a test exercises. */
function networkAnswering(methodName, result) {
    return {[methodName]: async () => result};
}

/** A successful write outcome, as sendWriteCommand builds one. */
function deliveredOutcome(note) {
    return {outcome: "delivered", note: note, status: 200, errorMessage: null, failureDetail: null};
}

/** A rejected write outcome, as sendWriteCommand builds one. */
function rejectedOutcome(status) {
    return {
        outcome: "rejected",
        note: null,
        status: status,
        errorMessage: status === null ? null : "the server explained the problem",
        failureDetail: status === null ? "request did not complete" : `HTTP ${status}`,
    };
}

/**
 * A network stub for delivery passes: answers each write method from a
 * list of scripted outcomes, in order, and records the calls it receives.
 */
function deliveryNetwork(script) {
    const network = {calls: []};
    for (const [method, outcomes] of Object.entries(script)) {
        const remaining = [...outcomes];
        network[method] = async (...args) => {
            network.calls.push({method: method, args: args});
            if (remaining.length === 0) {
                throw new Error(`no scripted outcome left for ${method}`);
            }
            return remaining.shift();
        };
    }
    return network;
}

/** A read failure as the fetch helpers build one when the server is unreachable. */
function unreachableFailure() {
    return {
        ok: false,
        errorMessage: null,
        failureDetail: "request did not complete: TypeError: Failed to fetch",
        unreachable: true,
    };
}

/** A read failure as the fetch helpers build one when the server answered with an error. */
function httpFailure(status) {
    return {
        ok: false,
        errorMessage: "the server explained the problem",
        failureDetail: `HTTP ${status}`,
        unreachable: false,
    };
}

let backend;
let store;

beforeEach(() => {
    backend = new FakeBackend();
    store = new NoteStore(backend);
});

describe("read write-through", () => {
    test("a fetched note is mirrored, and the result passes through unchanged", async () => {
        const note = makeNote("note_00001", 3);
        const result = {ok: true, note: note};
        const source = new OfflineDataSource(store, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001", null), result);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("a failed fetch leaves the mirror alone", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const result = httpFailure(500);
        const source = new OfflineDataSource(store, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001", null), result);
        assert.equal((await store.getNote("note_00001")).version_id, 3);
    });

    test("search results are not written through", async () => {
        const result = {ok: true, noteHeaders: [headerFor(makeNote("note_00001", 9))], continueKey: null};
        const source = new OfflineDataSource(store, networkAnswering("searchNotes", result));
        assert.equal(await source.searchNotes("Title", null), result);
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });
});

describe("header reconciliation", () => {
    /** Runs getNotes (or getDeletedNotes) answering with the given headers. */
    async function reconcile(headers, fromTrashList) {
        const method = fromTrashList ? "getDeletedNotes" : "getNotes";
        const result = {ok: true, noteHeaders: headers, continueKey: null};
        const source = new OfflineDataSource(store, networkAnswering(method, result));
        assert.equal(await source[method](null), result);
    }

    test("a header that matches the mirrored note leaves it in place", async () => {
        const note = makeNote("note_00001", 3);
        await store.putNoteFromServer(note);
        await reconcile([headerFor(note)], false);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("a header with a different version evicts the mirrored note", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await reconcile([headerFor(makeNote("note_00001", 4))], false);
        assert.equal(await store.getNote("note_00001"), undefined);
    });

    test("a header with a different modify time evicts the mirrored note", async () => {
        const note = makeNote("note_00001", 3);
        await store.putNoteFromServer(note);
        const changed = headerFor(note);
        changed.modify_time = "2026-08-09T11:30:00Z";
        await reconcile([changed], false);
        assert.equal(await store.getNote("note_00001"), undefined);
    });

    test("a trash-list header evicts a note mirrored as active", async () => {
        const note = makeNote("note_00001", 3);
        await store.putNoteFromServer(note);
        await reconcile([headerFor(note)], true);
        assert.equal(await store.getNote("note_00001"), undefined);
    });

    test("an active-list header evicts a note mirrored as trashed", async () => {
        const note = makeNote("note_00001", 3);
        note.delete_time = "2026-08-08T12:00:00Z";
        await store.putNoteFromServer(note);
        await reconcile([headerFor(note)], false);
        assert.equal(await store.getNote("note_00001"), undefined);
    });

    test("a trash-list header that matches a trashed note leaves it in place", async () => {
        const note = makeNote("note_00001", 3);
        note.delete_time = "2026-08-08T12:00:00Z";
        await store.putNoteFromServer(note);
        await reconcile([headerFor(note)], true);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("headers for notes that are not mirrored are ignored", async () => {
        await reconcile([headerFor(makeNote("note_00001", 3))], false);
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });
});

describe("offline read fallback", () => {
    /** Mirrors three notes: two active (note 2 modified later) and one trashed. */
    async function mirrorThreeNotes() {
        const active1 = makeNote("note_00001", 3);
        active1.modify_time = "2026-08-07T10:00:00Z";
        const active2 = makeNote("note_00002", 5);
        active2.modify_time = "2026-08-08T10:00:00Z";
        const trashed = makeNote("note_00003", 1);
        trashed.delete_time = "2026-08-09T10:00:00Z";
        await store.putNoteFromServer(active1);
        await store.putNoteFromServer(active2);
        await store.putNoteFromServer(trashed);
        return {active1, active2, trashed};
    }

    test("an unreachable getNotes serves the mirrored active notes, newest first", async () => {
        const {active1, active2} = await mirrorThreeNotes();
        const source = new OfflineDataSource(
            store, networkAnswering("getNotes", unreachableFailure()));
        assert.deepEqual(await source.getNotes(null), {
            ok: true,
            noteHeaders: [headerFor(active2), headerFor(active1)],
            continueKey: null,
        });
    });

    test("an unreachable getDeletedNotes serves the mirrored trashed notes", async () => {
        const {trashed} = await mirrorThreeNotes();
        const source = new OfflineDataSource(
            store, networkAnswering("getDeletedNotes", unreachableFailure()));
        assert.deepEqual(await source.getDeletedNotes(null), {
            ok: true,
            noteHeaders: [headerFor(trashed)],
            continueKey: null,
        });
    });

    test("an unreachable later page is not served from the mirror", async () => {
        await mirrorThreeNotes();
        const failure = unreachableFailure();
        const source = new OfflineDataSource(store, networkAnswering("getNotes", failure));
        assert.equal(await source.getNotes("a-continuation-key"), failure);
    });

    test("a list failure the server answered with is not served from the mirror", async () => {
        await mirrorThreeNotes();
        const failure = httpFailure(500);
        const source = new OfflineDataSource(store, networkAnswering("getNotes", failure));
        assert.equal(await source.getNotes(null), failure);
    });

    test("an unreachable getNote serves the mirrored note", async () => {
        const note = makeNote("note_00001", 3);
        await store.putNoteFromServer(note);
        const source = new OfflineDataSource(
            store, networkAnswering("getNote", unreachableFailure()));
        assert.deepEqual(await source.getNote("note_00001", null), {ok: true, note: note});
    });

    test("an unreachable getNote for an unmirrored note returns the failure", async () => {
        const failure = unreachableFailure();
        const source = new OfflineDataSource(store, networkAnswering("getNote", failure));
        assert.equal(await source.getNote("note_00001", null), failure);
    });

    test("a mirror read failure returns the network's failure", async () => {
        const brokenStore = {
            getAllNotes: async () => {
                throw new Error("local storage failed");
            },
        };
        const failure = unreachableFailure();
        const source = new OfflineDataSource(brokenStore, networkAnswering("getNotes", failure));
        assert.equal(await source.getNotes(null), failure);
    });
});

describe("offline search fallback", () => {
    /** Mirrors notes with distinct titles and bodies for matching against. */
    async function mirrorSearchableNotes() {
        const inTitle = makeNote("note_00001", 1);
        inTitle.title = "Shopping List";
        inTitle.modify_time = "2026-08-07T10:00:00Z";
        const inBody = makeNote("note_00002", 1);
        inBody.body = "remember the shopping bags";
        inBody.modify_time = "2026-08-08T10:00:00Z";
        const unrelated = makeNote("note_00003", 1);
        const trashed = makeNote("note_00004", 1);
        trashed.title = "Old Shopping Notes";
        trashed.delete_time = "2026-08-09T10:00:00Z";
        for (const note of [inTitle, inBody, unrelated, trashed]) {
            await store.putNoteFromServer(note);
        }
        return {inTitle, inBody};
    }

    test("an unreachable search matches titles and bodies case-insensitively, in note_id order", async () => {
        const {inTitle, inBody} = await mirrorSearchableNotes();
        const source = new OfflineDataSource(
            store, networkAnswering("searchNotes", unreachableFailure()));
        assert.deepEqual(await source.searchNotes("sHoPpInG", null), {
            ok: true,
            noteHeaders: [headerFor(inTitle), headerFor(inBody)],
            continueKey: null,
        });
    });

    test("a trashed note is not searched even when it matches", async () => {
        await mirrorSearchableNotes();
        const source = new OfflineDataSource(
            store, networkAnswering("searchNotes", unreachableFailure()));
        assert.deepEqual(await source.searchNotes("old", null), {
            ok: true,
            noteHeaders: [],
            continueKey: null,
        });
    });

    test("matching is case-insensitive for non-ASCII letters", async () => {
        const note = makeNote("note_00001", 1);
        note.body = "the CAFÉ on the corner";
        await store.putNoteFromServer(note);
        const source = new OfflineDataSource(
            store, networkAnswering("searchNotes", unreachableFailure()));
        assert.deepEqual(await source.searchNotes("café", null), {
            ok: true,
            noteHeaders: [headerFor(note)],
            continueKey: null,
        });
    });

    test("an unreachable later search page is not served from the mirror", async () => {
        await mirrorSearchableNotes();
        const failure = unreachableFailure();
        const source = new OfflineDataSource(store, networkAnswering("searchNotes", failure));
        assert.equal(await source.searchNotes("shopping", "a-continuation-key"), failure);
    });

    test("a search failure the server answered with is not served from the mirror", async () => {
        await mirrorSearchableNotes();
        const failure = httpFailure(500);
        const source = new OfflineDataSource(store, networkAnswering("searchNotes", failure));
        assert.equal(await source.searchNotes("shopping", null), failure);
    });
});

describe("note fetch timeout race", () => {
    /** A promise plus its settlement controls, for stubbing a slow network. */
    function slowNetworkRead() {
        const control = {};
        control.promise = new Promise((resolve, reject) => {
            control.resolve = resolve;
            control.reject = reject;
        });
        return control;
    }

    /** Waits one macrotask, letting all pending promise callbacks run. */
    function settle() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Waits long enough that a raceTimeoutMs of 1 has certainly fired. */
    function outwaitTimeout() {
        return new Promise((resolve) => setTimeout(resolve, 20));
    }

    test("a fetch that beats the timeout is served and mirrored, as usual", async () => {
        const note = makeNote("note_00001", 3);
        const result = {ok: true, note: note};
        const source = new OfflineDataSource(store, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001", 1000), result);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("a slow fetch is answered from the mirror, and still updates it on arrival", async () => {
        const mirrored = makeNote("note_00001", 3);
        await store.putNoteFromServer(mirrored);
        const slow = slowNetworkRead();
        const source = new OfflineDataSource(store, {getNote: () => slow.promise});
        assert.deepEqual(await source.getNote("note_00001", 1), {ok: true, note: mirrored});
        slow.resolve({ok: true, note: makeNote("note_00001", 4)});
        await settle();
        assert.equal((await store.getNote("note_00001")).version_id, 4);
    });

    test("a slow fetch with no mirrored copy is waited out", async () => {
        const slow = slowNetworkRead();
        const source = new OfflineDataSource(store, {getNote: () => slow.promise});
        const read = source.getNote("note_00001", 1);
        await outwaitTimeout();
        const note = makeNote("note_00001", 3);
        slow.resolve({ok: true, note: note});
        assert.deepEqual(await read, {ok: true, note: note});
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("a rejection after the mirror won the race is not left unhandled", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const slow = slowNetworkRead();
        const source = new OfflineDataSource(store, {getNote: () => slow.promise});
        const result = await source.getNote("note_00001", 1);
        assert.equal(result.ok, true);
        // An escaped rejection would crash the test run.
        slow.reject(new Error("session rejected while the fetch was abandoned"));
        await settle();
    });
});

describe("mirror refresh pass", () => {
    /** One page of note headers, shaped as the list reads resolve. */
    function headerPage(pages, continueKey) {
        const index = continueKey === null ? 0 : Number(continueKey);
        const isLastPage = index === pages.length - 1;
        return {
            ok: true,
            noteHeaders: pages[index],
            continueKey: isLastPage ? null : String(index + 1),
        };
    }

    /**
     * A network stub for refresh passes. activePages and trashedPages are
     * arrays of pages, each page an array of headers; notes maps note_id to
     * the note getNote answers with (absent means a 404). The note ids
     * fetched through getNote are recorded in fetchedNoteIds.
     */
    function refreshNetwork({activePages, trashedPages, notes}) {
        const network = {
            fetchedNoteIds: [],
            getNotes: async (ck) => headerPage(activePages, ck),
            getDeletedNotes: async (ck) => headerPage(trashedPages, ck),
            getNote: async (noteId, raceTimeoutMs) => {
                network.fetchedNoteIds.push(noteId);
                const note = notes[noteId];
                return note !== undefined ? {ok: true, note: note} : httpFailure(404);
            },
        };
        return network;
    }

    test("populates an empty mirror, trashed bodies included", async () => {
        const active = makeNote("note_0000a", 1);
        const trashed = makeNote("note_0000b", 4);
        trashed.delete_time = "2026-08-08T12:00:00Z";
        const network = refreshNetwork({
            activePages: [[headerFor(active)]],
            trashedPages: [[headerFor(trashed)]],
            notes: {[active.note_id]: active, [trashed.note_id]: trashed},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(backend.contents(NOTES_STORE), [active, trashed]);
    });

    test("a note matching its mirrored copy is not refetched", async () => {
        const note = makeNote("note_0000a", 3);
        await store.putNoteFromServer(note);
        const network = refreshNetwork({
            activePages: [[headerFor(note)]],
            trashedPages: [[]],
            notes: {},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(network.fetchedNoteIds, []);
        assert.deepEqual(await store.getNote(note.note_id), note);
    });

    test("a note with a new version is refetched and replaced", async () => {
        await store.putNoteFromServer(makeNote("note_0000a", 3));
        const newer = makeNote("note_0000a", 4);
        const network = refreshNetwork({
            activePages: [[headerFor(newer)]],
            trashedPages: [[]],
            notes: {[newer.note_id]: newer},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.equal((await store.getNote("note_0000a")).version_id, 4);
    });

    test("a note that moved to the trash is refetched", async () => {
        const active = makeNote("note_0000a", 3);
        await store.putNoteFromServer(active);
        const trashed = makeNote("note_0000a", 3);
        trashed.delete_time = "2026-08-08T12:00:00Z";
        const network = refreshNetwork({
            activePages: [[]],
            trashedPages: [[headerFor(trashed)]],
            notes: {[trashed.note_id]: trashed},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.equal(
            (await store.getNote("note_0000a")).delete_time, "2026-08-08T12:00:00Z");
    });

    test("a mirrored note the server no longer lists is removed", async () => {
        await store.putNoteFromServer(makeNote("note_0000d", 2));
        const network = refreshNetwork({activePages: [[]], trashedPages: [[]], notes: {}});
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });

    test("every page of a multi-page list is collected", async () => {
        const first = makeNote("note_0000a", 1);
        const second = makeNote("note_0000b", 1);
        const network = refreshNetwork({
            activePages: [[headerFor(first)], [headerFor(second)]],
            trashedPages: [[]],
            notes: {[first.note_id]: first, [second.note_id]: second},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(backend.contents(NOTES_STORE), [first, second]);
    });

    test("a failed list read ends the pass with the mirror untouched", async () => {
        const survivor = makeNote("note_0000d", 2);
        await store.putNoteFromServer(survivor);
        const network = refreshNetwork({
            activePages: [[headerFor(makeNote("note_0000a", 1))]],
            trashedPages: [[]],
            notes: {},
        });
        network.getDeletedNotes = async () => unreachableFailure();
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(network.fetchedNoteIds, []);
        assert.deepEqual(backend.contents(NOTES_STORE), [survivor]);
    });

    test("a note whose refetch fails is skipped and the pass continues", async () => {
        await store.putNoteFromServer(makeNote("note_0000d", 2));
        const fetchable = makeNote("note_0000b", 1);
        const network = refreshNetwork({
            activePages: [[headerFor(makeNote("note_0000a", 1)), headerFor(fetchable)]],
            trashedPages: [[]],
            notes: {[fetchable.note_id]: fetchable},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(backend.contents(NOTES_STORE), [fetchable]);
    });

    test("a note with queued commands is skipped without refetching", async () => {
        const local = makeNote("note_0000a", 3);
        await store.putNoteFromServer(local);
        await store.enqueueCommand({
            note_id: local.note_id,
            command_type: "edit-note",
            payload: {},
            source_version_id: 3,
        });
        const newer = makeNote("note_0000a", 9);
        const network = refreshNetwork({
            activePages: [[headerFor(newer)]],
            trashedPages: [[]],
            notes: {[newer.note_id]: newer},
        });
        await new OfflineDataSource(store, network).refreshMirror();
        assert.deepEqual(network.fetchedNoteIds, []);
        assert.equal((await store.getNote(local.note_id)).version_id, 3);
    });

    test("a call while a pass is running resolves without starting another", async () => {
        let releaseFirstPage = null;
        let getNotesCalls = 0;
        const network = {
            getNotes: () => {
                getNotesCalls += 1;
                return new Promise((resolve) => {
                    releaseFirstPage =
                        () => resolve({ok: true, noteHeaders: [], continueKey: null});
                });
            },
            getDeletedNotes: async (ck) => ({ok: true, noteHeaders: [], continueKey: null}),
            getNote: async (noteId, raceTimeoutMs) => {
                throw new Error("no note should be fetched");
            },
        };
        const source = new OfflineDataSource(store, network);
        const firstPass = source.refreshMirror();
        await source.refreshMirror();
        assert.equal(getNotesCalls, 1);
        releaseFirstPage();
        await firstPass;
    });

    test("a rejected session ends the pass quietly", async () => {
        const network = {
            getNotes: async (ck) => {
                throw new LoggedOutError("session rejected");
            },
        };
        await new OfflineDataSource(store, network).refreshMirror();
    });
});

describe("write write-through", () => {
    test("a delivered destroy removes the note from the mirror", async () => {
        const note = makeNote("note_00001", 3);
        note.delete_time = "2026-08-08T12:00:00Z";
        await store.putNoteFromServer(note);
        const outcome = deliveredOutcome(null);
        const source = new OfflineDataSource(store, networkAnswering("destroyNote", outcome));
        assert.equal(await source.destroyNote("note_00001"), outcome);
        assert.equal(await store.getNote("note_00001"), undefined);
    });
});

/** A queued edit-note record, as the write path enqueues one. */
function editCommand(noteId, sourceVersionId) {
    return {
        note_id: noteId,
        command_type: EDIT_NOTE,
        payload: {title: `Title of ${noteId}`, body: `Body of ${noteId}`},
        source_version_id: sourceVersionId,
    };
}

describe("queue delivery", () => {
    /** Waits one macrotask, letting all pending promise callbacks run. */
    function settle() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    test("an empty queue resolves an empty map without touching the network", async () => {
        const network = deliveryNetwork({});
        const source = new OfflineDataSource(store, network);
        assert.deepEqual(await source.drainQueue(null), new Map());
        assert.deepEqual(network.calls, []);
    });

    test("each command type builds its network call from the queue record", async () => {
        await store.commitLocalWrite(makeNote("note_new11", 0), {
            note_id: "note_new11",
            command_type: NEW_NOTE,
            payload: {title: "New title", body: "New body", format: "PlainText"},
            source_version_id: 0,
        });
        await store.commitLocalWrite(makeNote("note_edit1", 5), editCommand("note_edit1", 4));
        await store.commitLocalWrite(makeNote("note_del11", 2), {
            note_id: "note_del11",
            command_type: DELETE_NOTE,
            payload: {},
            source_version_id: 2,
        });
        await store.commitLocalWrite(makeNote("note_rec11", 2), {
            note_id: "note_rec11",
            command_type: RECOVER_NOTE,
            payload: {},
            source_version_id: 2,
        });
        const network = deliveryNetwork({
            newNote: [deliveredOutcome(makeNote("note_new11", 0))],
            editNote: [deliveredOutcome(makeNote("note_edit1", 5))],
            deleteNote: [deliveredOutcome(makeNote("note_del11", 2))],
            recoverNote: [deliveredOutcome(makeNote("note_rec11", 2))],
        });
        await new OfflineDataSource(store, network).drainQueue(null);
        assert.deepEqual(network.calls, [
            {method: "newNote", args: [{
                noteId: "note_new11", title: "New title", body: "New body", format: "PlainText"}]},
            {method: "editNote", args: [{
                noteId: "note_edit1",
                title: "Title of note_edit1",
                body: "Body of note_edit1",
                sourceVersionId: 4,
            }]},
            {method: "deleteNote", args: ["note_del11", 2]},
            {method: "recoverNote", args: ["note_rec11", 2]},
        ]);
    });

    test("a delivered command is removed and the server's note is mirrored", async () => {
        const seq = await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const serverNote = makeNote("note_00001", 4);
        serverNote.title = "as the server stored it";
        const outcome = deliveredOutcome(serverNote);
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [outcome]}));
        const outcomes = await source.drainQueue(null);
        assert.equal(outcomes.get(seq), outcome);
        assert.deepEqual(await store.getNote("note_00001"), serverNote);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
    });

    test("a transient failure stops the pass, leaving the queue as it was", async () => {
        const first = await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        await store.commitLocalWrite(
            makeNote("note_00002", 2), editCommand("note_00002", 1));
        const network = deliveryNetwork({editNote: [rejectedOutcome(null)]});
        const outcomes = await new OfflineDataSource(store, network).drainQueue(null);
        assert.equal(network.calls.length, 1);
        assert.deepEqual([...outcomes.keys()], [first]);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
        assert.equal(await store.hasQueuedCommands("note_00002"), true);
    });

    test("a 5xx answer is a transient failure", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const network = deliveryNetwork({editNote: [rejectedOutcome(503)]});
        await new OfflineDataSource(store, network).drainQueue(null);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
        assert.notEqual(await store.getNote("note_00001"), undefined);
    });

    test("a definitive refusal drops the command, evicts the note, and continues", async () => {
        const refused = await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const delivered = await store.commitLocalWrite(
            makeNote("note_00002", 2), editCommand("note_00002", 1));
        const network = deliveryNetwork({
            editNote: [rejectedOutcome(400), deliveredOutcome(makeNote("note_00002", 2))],
        });
        const outcomes = await new OfflineDataSource(store, network).drainQueue(null);
        assert.deepEqual([...outcomes.keys()], [refused, delivered]);
        assert.equal(await store.getNote("note_00001"), undefined);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
        assert.notEqual(await store.getNote("note_00002"), undefined);
        assert.equal(await store.hasQueuedCommands("note_00002"), false);
    });

    test("a 409 is handled as a definitive refusal", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const network = deliveryNetwork({editNote: [rejectedOutcome(409)]});
        await new OfflineDataSource(store, network).drainQueue(null);
        assert.equal(await store.getNote("note_00001"), undefined);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
    });

    test("the server's note is not mirrored while later commands for it remain", async () => {
        const localNote = makeNote("note_00001", 5);
        await store.commitLocalWrite(makeNote("note_00001", 4), editCommand("note_00001", 3));
        await store.commitLocalWrite(localNote, editCommand("note_00001", 4));
        const network = deliveryNetwork({
            editNote: [deliveredOutcome(makeNote("note_00001", 4)), rejectedOutcome(null)],
        });
        await new OfflineDataSource(store, network).drainQueue(null);
        assert.deepEqual(await store.getNote("note_00001"), localNote);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
    });

    test("a drain started during a pass waits, then runs its own pass", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        let release = null;
        let deliveries = 0;
        const network = {
            editNote: () => {
                deliveries += 1;
                return new Promise((resolve) => {
                    release = () => resolve(deliveredOutcome(makeNote("note_00001", 4)));
                });
            },
        };
        const source = new OfflineDataSource(store, network);
        const firstPass = source.drainQueue(null);
        const secondPass = source.drainQueue(null);
        await settle();
        assert.equal(deliveries, 1);
        release();
        assert.equal((await firstPass).size, 1);
        // The second pass ran after the first and found the queue empty.
        assert.equal((await secondPass).size, 0);
        assert.equal(deliveries, 1);
    });

    test("a LoggedOutError from a delivery rejects the pass", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const network = {
            editNote: async () => {
                throw new LoggedOutError("session rejected");
            },
        };
        const source = new OfflineDataSource(store, network);
        await assert.rejects(source.drainQueue(null), LoggedOutError);
        // The queue is untouched: wiping it is the logout path's job.
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
    });
});

describe("the sync engine's hooks", () => {
    /** A fake sync engine recording its wake() calls. */
    function fakeEngine() {
        const engine = {wakes: 0};
        engine.wake = () => { engine.wakes += 1; };
        return engine;
    }

    test("attemptQueueDelivery reports idle for an empty queue, without touching the network", async () => {
        const network = deliveryNetwork({});
        const source = new OfflineDataSource(store, network);
        assert.equal(await source.attemptQueueDelivery(), DELIVERY_IDLE);
        assert.deepEqual(network.calls, []);
    });

    test("attemptQueueDelivery delivers the queue, then reports idle", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [deliveredOutcome(makeNote("note_00001", 4))]}));
        assert.equal(await source.attemptQueueDelivery(), DELIVERY_IDLE);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
    });

    test("attemptQueueDelivery reports retry when a command fails transiently", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [rejectedOutcome(null)]}));
        assert.equal(await source.attemptQueueDelivery(), DELIVERY_RETRY);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
    });

    test("attemptQueueDelivery reports idle on a rejected session", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const network = {
            editNote: async () => {
                throw new LoggedOutError("session rejected");
            },
        };
        const source = new OfflineDataSource(store, network);
        assert.equal(await source.attemptQueueDelivery(), DELIVERY_IDLE);
    });

    test("attemptQueueDelivery propagates any other failure, for the engine's backoff", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const network = {
            editNote: async () => {
                throw new Error("the pass broke");
            },
        };
        const source = new OfflineDataSource(store, network);
        await assert.rejects(source.attemptQueueDelivery(), /the pass broke/);
    });

    test("a queued write outcome wakes the sync engine", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 4));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [rejectedOutcome(null)]}));
        source.syncEngine = fakeEngine();
        const outcome = await source.editNote(
            {noteId: "note_00001", title: "t", body: "b", sourceVersionId: 4});
        assert.equal(outcome.outcome, "queued");
        assert.equal(source.syncEngine.wakes, 1);
    });

    test("a delivered write outcome does not wake the sync engine", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 4));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [deliveredOutcome(makeNote("note_00001", 5))]}));
        source.syncEngine = fakeEngine();
        const outcome = await source.editNote(
            {noteId: "note_00001", title: "t", body: "b", sourceVersionId: 4});
        assert.equal(outcome.outcome, "delivered");
        assert.equal(source.syncEngine.wakes, 0);
    });
});

describe("background rejection reporting", () => {
    test("a refusal during a background pass is reported to the handler", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [rejectedOutcome(400)]}));
        const reported = [];
        source.setBackgroundRejectionHandler(
            (command, outcome) => reported.push({command: command, outcome: outcome}));
        await source.drainQueue(null);
        assert.equal(reported.length, 1);
        assert.equal(reported[0].command.note_id, "note_00001");
        assert.equal(reported[0].outcome.status, 400);
    });

    test("the foreground command's refusal is not reported: its caller hears it", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 4));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [rejectedOutcome(400)]}));
        const reported = [];
        source.setBackgroundRejectionHandler((command, outcome) => reported.push(command));
        const outcome = await source.editNote(
            {noteId: "note_00001", title: "t", body: "b", sourceVersionId: 4});
        assert.equal(outcome.outcome, "rejected");
        assert.deepEqual(reported, []);
    });

    test("an earlier command refused during a foreground write is reported", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        await store.putNoteFromServer(makeNote("note_00002", 2));
        const source = new OfflineDataSource(store, deliveryNetwork({
            editNote: [rejectedOutcome(400), deliveredOutcome(makeNote("note_00002", 3))],
        }));
        const reported = [];
        source.setBackgroundRejectionHandler((command, outcome) => reported.push(command));
        const outcome = await source.editNote(
            {noteId: "note_00002", title: "t", body: "b", sourceVersionId: 2});
        assert.equal(outcome.outcome, "delivered");
        assert.equal(reported.length, 1);
        assert.equal(reported[0].note_id, "note_00001");
    });

    test("a throwing handler does not stop the pass", async () => {
        await store.commitLocalWrite(
            makeNote("note_00001", 4), editCommand("note_00001", 3));
        await store.commitLocalWrite(
            makeNote("note_00002", 2), editCommand("note_00002", 1));
        const source = new OfflineDataSource(store, deliveryNetwork({
            editNote: [rejectedOutcome(400), deliveredOutcome(makeNote("note_00002", 2))],
        }));
        source.setBackgroundRejectionHandler(() => {
            throw new Error("the handler broke");
        });
        const outcomes = await source.drainQueue(null);
        assert.equal(outcomes.size, 2);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
        assert.equal(await store.hasQueuedCommands("note_00002"), false);
    });
});

describe("the offline write path", () => {
    const NOTE_ID_PATTERN = /^[0-9a-zA-Z_~]{10}$/;

    test("a delivered edit reports delivered, and the server's note is mirrored", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const serverNote = makeNote("note_00001", 4);
        serverNote.title = "as the server stored it";
        const outcome = deliveredOutcome(serverNote);
        const network = deliveryNetwork({editNote: [outcome]});
        const source = new OfflineDataSource(store, network);
        const result = await source.editNote(
            {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3});
        assert.equal(result, outcome);
        assert.deepEqual(await store.getNote("note_00001"), serverNote);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
        // The delivery was built from the mirror's version.
        assert.equal(network.calls[0].args[0].sourceVersionId, 3);
    });

    test("an edit with the server unreachable reports queued with the local note", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const network = deliveryNetwork({editNote: [rejectedOutcome(null)]});
        const source = new OfflineDataSource(store, network);
        const result = await source.editNote(
            {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3});
        assert.equal(result.outcome, "queued");
        assert.equal(result.note.version_id, 4);
        assert.equal(result.note.title, "New title");
        assert.deepEqual(await store.getNote("note_00001"), result.note);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
    });

    test("a server refusal reports rejected, dropping the command and the mirror entry", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const outcome = rejectedOutcome(400);
        const source = new OfflineDataSource(store, deliveryNetwork({editNote: [outcome]}));
        const result = await source.editNote(
            {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3});
        assert.equal(result, outcome);
        assert.equal(await store.getNote("note_00001"), undefined);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
    });

    test("a 409 reports rejected with its status, for the caller's conflict flow", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const source = new OfflineDataSource(
            store, deliveryNetwork({editNote: [rejectedOutcome(409)]}));
        const result = await source.editNote(
            {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3});
        assert.equal(result.outcome, "rejected");
        assert.equal(result.status, 409);
    });

    test("newNote generates the id and sends it with the create", async () => {
        const serverNote = makeNote("note_00001", 0);
        const network = deliveryNetwork({newNote: [deliveredOutcome(serverNote)]});
        const source = new OfflineDataSource(store, network);
        const result = await source.newNote(
            {noteId: null, title: "A title", body: "A body", format: "PlainText"});
        assert.equal(result.outcome, "delivered");
        const sent = network.calls[0].args[0];
        assert.match(sent.noteId, NOTE_ID_PATTERN);
        assert.equal(sent.title, "A title");
    });

    test("newNote with the server unreachable reports queued with the local note", async () => {
        const network = deliveryNetwork({newNote: [rejectedOutcome(null)]});
        const source = new OfflineDataSource(store, network);
        const result = await source.newNote(
            {noteId: null, title: "A title", body: "A body", format: "PlainText"});
        assert.equal(result.outcome, "queued");
        assert.match(result.note.note_id, NOTE_ID_PATTERN);
        assert.equal(result.note.version_id, 0);
        assert.equal(result.note.user_id, null);
        assert.deepEqual(await store.getNote(result.note.note_id), result.note);
        const queued = await store.queuedCommandsForNote(result.note.note_id);
        assert.equal(queued.length, 1);
        assert.equal(queued[0].command_type, NEW_NOTE);
    });

    test("a queued delete marks the mirrored note deleted", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const source = new OfflineDataSource(
            store, deliveryNetwork({deleteNote: [rejectedOutcome(null)]}));
        const result = await source.deleteNote("note_00001", 3);
        assert.equal(result.outcome, "queued");
        assert.notEqual((await store.getNote("note_00001")).delete_time, undefined);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
    });

    test("a queued delete of an unmirrored note enqueues alone, with a null note", async () => {
        const source = new OfflineDataSource(
            store, deliveryNetwork({deleteNote: [rejectedOutcome(null)]}));
        const result = await source.deleteNote("note_00001", 7);
        assert.equal(result.outcome, "queued");
        assert.equal(result.note, null);
        assert.equal(await store.getNote("note_00001"), undefined);
        const queued = await store.queuedCommandsForNote("note_00001");
        assert.equal(queued.length, 1);
        assert.equal(queued[0].source_version_id, 7);
    });

    test("a queued recover clears the mirrored note's delete_time", async () => {
        const trashed = makeNote("note_00001", 3);
        trashed.delete_time = "2026-09-10T10:00:00Z";
        await store.putNoteFromServer(trashed);
        const source = new OfflineDataSource(
            store, deliveryNetwork({recoverNote: [rejectedOutcome(null)]}));
        const result = await source.recoverNote("note_00001", 3);
        assert.equal(result.outcome, "queued");
        assert.equal("delete_time" in (await store.getNote("note_00001")), false);
    });

    test("a write behind a stuck command reports queued without being attempted", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.putNoteFromServer(makeNote("note_00002", 5));
        const network = deliveryNetwork(
            {editNote: [rejectedOutcome(null), rejectedOutcome(null)]});
        const source = new OfflineDataSource(store, network);
        await source.editNote(
            {noteId: "note_00001", title: "t1", body: "b1", sourceVersionId: 3});
        const result = await source.editNote(
            {noteId: "note_00002", title: "t2", body: "b2", sourceVersionId: 5});
        assert.equal(result.outcome, "queued");
        // Both delivery attempts were for the stuck head command, never for note 2.
        assert.deepEqual(network.calls.map((c) => c.args[0].noteId),
            ["note_00001", "note_00001"]);
        assert.equal(await store.hasQueuedCommands("note_00002"), true);
    });

    test("a write drains the backlog: earlier commands deliver first, then its own", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.putNoteFromServer(makeNote("note_00002", 5));
        const serverFirst = makeNote("note_00001", 4);
        const serverSecond = makeNote("note_00002", 6);
        const network = deliveryNetwork({editNote: [
            rejectedOutcome(null),
            deliveredOutcome(serverFirst),
            deliveredOutcome(serverSecond),
        ]});
        const source = new OfflineDataSource(store, network);
        await source.editNote(
            {noteId: "note_00001", title: "t1", body: "b1", sourceVersionId: 3});
        const result = await source.editNote(
            {noteId: "note_00002", title: "t2", body: "b2", sourceVersionId: 5});
        assert.equal(result.outcome, "delivered");
        assert.equal(result.note, serverSecond);
        assert.deepEqual(await store.getNote("note_00001"), serverFirst);
        assert.deepEqual(await store.getNote("note_00002"), serverSecond);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
        assert.equal(await store.hasQueuedCommands("note_00002"), false);
    });

    test("a failed local commit reports rejected with no queued command", async () => {
        const brokenStore = {
            getNote: async () => undefined,
            commitLocalWrite: async () => {
                throw new Error("local storage failed");
            },
        };
        const source = new OfflineDataSource(brokenStore, deliveryNetwork({}));
        const result = await source.editNote(
            {noteId: "note_00001", title: "t", body: "b", sourceVersionId: 3});
        assert.equal(result.outcome, "rejected");
        assert.equal(result.status, null);
        assert.equal(result.errorMessage, null);
        assert.match(result.failureDetail, /local storage failed/);
    });

    test("a LoggedOutError during delivery passes through to the caller", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const network = {
            editNote: async () => {
                throw new LoggedOutError("session rejected");
            },
        };
        const source = new OfflineDataSource(store, network);
        await assert.rejects(
            source.editNote(
                {noteId: "note_00001", title: "t", body: "b", sourceVersionId: 3}),
            LoggedOutError
        );
    });
});

describe("failure isolation", () => {
    test("a local-store failure does not change the network's answer", async () => {
        const brokenStore = {
            putNoteFromServer: async () => {
                throw new Error("local storage failed");
            },
        };
        const result = {ok: true, note: makeNote("note_00001", 3)};
        const source = new OfflineDataSource(brokenStore, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001", null), result);
    });

    test("wipeLocalData empties the store", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const source = new OfflineDataSource(store, {});
        await source.wipeLocalData();
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });

    test("wipeLocalData never rejects", async () => {
        const brokenStore = {
            wipe: async () => {
                throw new Error("local storage failed");
            },
        };
        const source = new OfflineDataSource(brokenStore, {});
        await source.wipeLocalData();
    });
});
