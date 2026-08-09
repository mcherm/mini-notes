/**
 * Tests for html/store.js's NoteStore, run against the in-memory fake backend
 * in fake-backend.mjs. The real IndexedDB backend is browser-only and is
 * verified manually in DevTools.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { NoteStore, NOTES_STORE, QUEUE_STORE } from "../html/store.js";
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

/** A queue record as the write path enqueues it (minus the assigned seq). */
function makeCommand(noteId, sourceVersionId) {
    return {
        note_id: noteId,
        command_type: "edit-note",
        payload: {title: "new title", body: "new body"},
        source_version_id: sourceVersionId,
    };
}

let backend;
let store;

beforeEach(() => {
    backend = new FakeBackend();
    store = new NoteStore(backend);
});

describe("probeWrite", () => {
    test("leaves no residue in the notes store", async () => {
        await store.probeWrite();
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });
});

describe("the mirror", () => {
    test("getNote resolves undefined for a note that is not mirrored", async () => {
        assert.equal(await store.getNote("absent_note"), undefined);
    });

    test("putNoteFromServer stores a note that getNote returns", async () => {
        const note = makeNote("note_00001", 3);
        assert.equal(await store.putNoteFromServer(note), true);
        assert.deepEqual(await store.getNote("note_00001"), note);
    });

    test("putNoteFromServer replaces the existing copy of the same note", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.putNoteFromServer(makeNote("note_00001", 4));
        const mirrored = await store.getNote("note_00001");
        assert.equal(mirrored.version_id, 4);
        assert.equal(backend.contents(NOTES_STORE).length, 1);
    });

    test("putNoteFromServer stores a copy, not a reference", async () => {
        const note = makeNote("note_00001", 3);
        await store.putNoteFromServer(note);
        note.title = "mutated after the put";
        assert.equal((await store.getNote("note_00001")).title, "Title of note_00001");
    });

    test("the read barrier skips the put when the note has queued commands", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.enqueueCommand(makeCommand("note_00001", 3));
        assert.equal(await store.putNoteFromServer(makeNote("note_00001", 9)), false);
        assert.equal((await store.getNote("note_00001")).version_id, 3);
    });

    test("the read barrier ignores queued commands for other notes", async () => {
        await store.enqueueCommand(makeCommand("note_other", 1));
        assert.equal(await store.putNoteFromServer(makeNote("note_00001", 3)), true);
    });

    test("the read barrier lifts once the note's commands are removed", async () => {
        const seq = await store.enqueueCommand(makeCommand("note_00001", 3));
        await store.removeCommand(seq);
        assert.equal(await store.putNoteFromServer(makeNote("note_00001", 4)), true);
    });

    test("deleteNoteFromServer removes a mirrored note", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        assert.equal(await store.deleteNoteFromServer("note_00001"), true);
        assert.equal(await store.getNote("note_00001"), undefined);
    });

    test("the read barrier skips the delete when the note has queued commands", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.enqueueCommand(makeCommand("note_00001", 3));
        assert.equal(await store.deleteNoteFromServer("note_00001"), false);
        assert.notEqual(await store.getNote("note_00001"), undefined);
    });

    test("deleteNoteFromServer of a note that is not mirrored succeeds", async () => {
        assert.equal(await store.deleteNoteFromServer("absent_note"), true);
    });
});

describe("the update queue", () => {
    test("peekCommand resolves null when the queue is empty", async () => {
        assert.equal(await store.peekCommand(), null);
    });

    test("enqueueCommand assigns increasing sequence numbers from 1", async () => {
        assert.equal(await store.enqueueCommand(makeCommand("note_00001", 1)), 1);
        assert.equal(await store.enqueueCommand(makeCommand("note_00002", 5)), 2);
        assert.equal(await store.enqueueCommand(makeCommand("note_00001", 2)), 3);
    });

    test("the stored record carries its assigned sequence number", async () => {
        await store.enqueueCommand(makeCommand("note_00001", 1));
        const head = await store.peekCommand();
        assert.equal(head.update_queue_seq, 1);
        assert.equal(head.note_id, "note_00001");
    });

    test("enqueueCommand does not modify the caller's record", async () => {
        const command = makeCommand("note_00001", 1);
        await store.enqueueCommand(command);
        assert.equal("update_queue_seq" in command, false);
    });

    test("peekCommand returns the oldest command, and removal advances it", async () => {
        await store.enqueueCommand(makeCommand("note_00001", 1));
        await store.enqueueCommand(makeCommand("note_00002", 5));
        const first = await store.peekCommand();
        assert.equal(first.update_queue_seq, 1);
        await store.removeCommand(first.update_queue_seq);
        assert.equal((await store.peekCommand()).update_queue_seq, 2);
    });

    test("removeCommand removes only the given command", async () => {
        await store.enqueueCommand(makeCommand("note_00001", 1));
        await store.enqueueCommand(makeCommand("note_00001", 2));
        await store.enqueueCommand(makeCommand("note_00001", 3));
        await store.removeCommand(2);
        const remaining = await store.queuedCommandsForNote("note_00001");
        assert.deepEqual(remaining.map((c) => c.update_queue_seq), [1, 3]);
    });

    test("hasQueuedCommands tracks the note's commands across their lifecycle", async () => {
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
        const first = await store.enqueueCommand(makeCommand("note_00001", 1));
        const second = await store.enqueueCommand(makeCommand("note_00001", 2));
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
        await store.removeCommand(first);
        assert.equal(await store.hasQueuedCommands("note_00001"), true);
        await store.removeCommand(second);
        assert.equal(await store.hasQueuedCommands("note_00001"), false);
    });

    test("queuedCommandsForNote returns that note's commands in delivery order", async () => {
        await store.enqueueCommand(makeCommand("note_aaaaa", 1));
        await store.enqueueCommand(makeCommand("note_bbbbb", 7));
        await store.enqueueCommand(makeCommand("note_aaaaa", 2));
        await store.enqueueCommand(makeCommand("note_bbbbb", 8));
        const commands = await store.queuedCommandsForNote("note_aaaaa");
        assert.deepEqual(commands.map((c) => c.update_queue_seq), [1, 3]);
        assert.deepEqual(commands.map((c) => c.source_version_id), [1, 2]);
    });
});

describe("wipe", () => {
    test("empties both the mirror and the queue", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        await store.enqueueCommand(makeCommand("note_00002", 1));
        await store.wipe();
        assert.deepEqual(backend.contents(NOTES_STORE), []);
        assert.deepEqual(backend.contents(QUEUE_STORE), []);
        assert.equal(await store.getNote("note_00001"), undefined);
        assert.equal(await store.peekCommand(), null);
    });
});

/**
 * Self-tests of the fake's transaction behavior. NoteStore's correctness
 * arguments lean on these properties of IndexedDB, so the fake must uphold
 * them for the tests above to mean anything.
 */
describe("the fake backend's transaction contract", () => {
    test("a callback that throws rolls back every write it made", async () => {
        await store.putNoteFromServer(makeNote("note_00001", 3));
        const failing = backend.transaction(
            [NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                await stores[NOTES_STORE].put(makeNote("note_00002", 1));
                await stores[QUEUE_STORE].put(makeCommand("note_00002", 1));
                throw new Error("something went wrong mid-transaction");
            }
        );
        await assert.rejects(failing, /mid-transaction/);
        assert.equal(backend.contents(NOTES_STORE).length, 1);
        assert.deepEqual(backend.contents(QUEUE_STORE), []);
    });

    test("a readonly transaction refuses writes", async () => {
        const failing = backend.transaction(
            [NOTES_STORE], "readonly",
            (stores) => stores[NOTES_STORE].put(makeNote("note_00001", 1))
        );
        await assert.rejects(failing, /readonly/);
        assert.deepEqual(backend.contents(NOTES_STORE), []);
    });

    test("a store handle is dead once its transaction finishes", async () => {
        let escaped;
        await backend.transaction(
            [NOTES_STORE], "readonly",
            async (stores) => {
                escaped = stores[NOTES_STORE];
            }
        );
        await assert.rejects(escaped.get("note_00001"), /finished/);
    });

    test("transactions do not interleave", async () => {
        const log = [];
        const logging = (label) => backend.transaction(
            [NOTES_STORE], "readwrite",
            async (stores) => {
                log.push(`${label} start`);
                await stores[NOTES_STORE].put(makeNote(`note_${label}`, 1));
                log.push(`${label} end`);
            }
        );
        await Promise.all([logging("one"), logging("two")]);
        assert.deepEqual(log, ["one start", "one end", "two start", "two end"]);
    });
});
