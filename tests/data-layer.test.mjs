/**
 * Tests for html/data-layer.js's OfflineDataSource: the write-through of
 * server responses into the local mirror. The network side is a stub that
 * returns canned results; the store side is a real NoteStore over the fake
 * backend, so these tests also exercise the read barrier end to end.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { OfflineDataSource } from "../html/data-layer.js";
import { NoteStore, NOTES_STORE } from "../html/store.js";
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
        assert.equal(await source.getNote("note_00001"), result);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("a failed fetch leaves the mirror alone", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const result = {ok: false, errorMessage: null, failureDetail: "HTTP 500"};
        const source = new OfflineDataSource(store, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001"), result);
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

describe("write write-through", () => {
    test("a delivered write's returned note replaces the mirrored copy", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const returned = makeNote("note_00001", 4);
        const outcome = deliveredOutcome(returned);
        const source = new OfflineDataSource(store, networkAnswering("editNote", outcome));
        const result = await source.editNote({
            noteId: "note_00001",
            title: returned.title,
            body: returned.body,
            sourceVersionId: 3,
        });
        assert.equal(result, outcome);
        assert.equal((await store.getNote("note_00001")).version_id, 4);
    });

    test("a rejected write leaves the mirror alone", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const outcome = {
            outcome: "rejected",
            note: null,
            status: 409,
            errorMessage: "note has been modified",
            failureDetail: "HTTP 409",
        };
        const source = new OfflineDataSource(store, networkAnswering("editNote", outcome));
        assert.equal(
            await source.editNote({noteId: "note_00001", title: "t", body: "b", sourceVersionId: 3}),
            outcome
        );
        assert.equal((await store.getNote("note_00001")).version_id, 3);
    });

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

describe("failure isolation", () => {
    test("a local-store failure does not change the network's answer", async () => {
        const brokenStore = {
            putNoteFromServer: async () => {
                throw new Error("local storage failed");
            },
        };
        const result = {ok: true, note: makeNote("note_00001", 3)};
        const source = new OfflineDataSource(brokenStore, networkAnswering("getNote", result));
        assert.equal(await source.getNote("note_00001"), result);
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
