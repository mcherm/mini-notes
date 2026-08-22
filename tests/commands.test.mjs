/**
 * Tests for html/commands.js: the pure logic that applies each
 * offline-capable write command to a locally mirrored note and builds the
 * corresponding queue record.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    DELETE_NOTE, EDIT_NOTE, NEW_NOTE, RECOVER_NOTE,
    applyDeleteNote, applyEditNote, applyNewNote, applyRecoverNote,
    currentTimestamp, generateId,
} from "../html/commands.js";
import { applyNoteDiff } from "../html/diff.js";

const NOW = "2026-08-22T15:00:00.000Z";

/** A mirrored note, shaped as the server returns it. */
function makeNote(fields) {
    return {
        user_id: "user_000001",
        note_id: "note_00001",
        version_id: 3,
        title: "Old title",
        body: "Old body",
        create_time: "2026-08-01T10:00:00Z",
        modify_time: "2026-08-09T10:00:00Z",
        format: "PlainText",
        undo_stack: [],
        ...fields,
    };
}

describe("generateId", () => {
    test("produces 10 characters from the id alphabet", () => {
        const id = generateId();
        assert.match(id, /^[0-9a-zA-Z_~]{10}$/);
    });

    test("produces different ids on different calls", () => {
        assert.notEqual(generateId(), generateId());
    });
});

describe("currentTimestamp", () => {
    test("produces an RFC 3339 UTC timestamp", () => {
        const ts = currentTimestamp();
        assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
        assert.ok(!Number.isNaN(Date.parse(ts)));
    });
});

describe("applyNewNote", () => {
    const input = {noteId: "abcdefghij", title: "A title", body: "A body", format: "PlainText"};

    test("builds the note per the field table", () => {
        const {note} = applyNewNote(input, NOW);
        assert.deepEqual(note, {
            user_id: null,
            note_id: "abcdefghij",
            version_id: 0,
            title: "A title",
            body: "A body",
            create_time: NOW,
            modify_time: NOW,
            format: "PlainText",
            undo_stack: [],
        });
    });

    test("builds the queue record", () => {
        const {command} = applyNewNote(input, NOW);
        assert.deepEqual(command, {
            note_id: "abcdefghij",
            command_type: NEW_NOTE,
            payload: {title: "A title", body: "A body", format: "PlainText"},
            source_version_id: 0,
        });
    });
});

describe("applyEditNote on a mirrored note", () => {
    const edit = {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3};

    test("replaces title and body, increments the version, sets modify_time", () => {
        const {note} = applyEditNote(makeNote({}), edit, NOW);
        assert.equal(note.title, "New title");
        assert.equal(note.body, "New body");
        assert.equal(note.version_id, 4);
        assert.equal(note.modify_time, NOW);
    });

    test("leaves user_id, create_time, and format as they were", () => {
        const {note} = applyEditNote(makeNote({}), edit, NOW);
        assert.equal(note.user_id, "user_000001");
        assert.equal(note.create_time, "2026-08-01T10:00:00Z");
        assert.equal(note.format, "PlainText");
    });

    test("builds the queue record with the mirror's version as source", () => {
        const {command} = applyEditNote(makeNote({}), edit, NOW);
        assert.deepEqual(command, {
            note_id: "note_00001",
            command_type: EDIT_NOTE,
            payload: {title: "New title", body: "New body"},
            source_version_id: 3,
        });
    });

    test("the mirror's version wins over a stale UI sourceVersionId", () => {
        const {note, command} = applyEditNote(
            makeNote({version_id: 7}),
            {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3},
            NOW
        );
        assert.equal(command.source_version_id, 7);
        assert.equal(note.version_id, 8);
    });

    test("pushes an undo diff that restores the old title and body", () => {
        const {note} = applyEditNote(makeNote({}), edit, NOW);
        assert.equal(note.undo_stack.length, 1);
        const undone = applyNoteDiff(
            {title: note.title, body: note.body}, note.undo_stack[0], false);
        assert.deepEqual(undone, {title: "Old title", body: "Old body"});
    });

    test("keeps earlier undo entries, oldest first", () => {
        const existing = makeNote({undo_stack: ["t:[New\\|Old]5", "b:[New\\|Old]4"]});
        const {note} = applyEditNote(existing, edit, NOW);
        assert.equal(note.undo_stack.length, 3);
        assert.deepEqual(note.undo_stack.slice(0, 2), ["t:[New\\|Old]5", "b:[New\\|Old]4"]);
    });

    test("pushes no diff when title and body are unchanged, but still bumps the version", () => {
        const {note} = applyEditNote(
            makeNote({}),
            {noteId: "note_00001", title: "Old title", body: "Old body", sourceVersionId: 3},
            NOW
        );
        assert.deepEqual(note.undo_stack, []);
        assert.equal(note.version_id, 4);
    });

    test("caps the undo stack at 50, dropping the oldest entries", () => {
        const fullStack = Array.from({length: 50}, (unused, i) => `b:[a\\|b]${i}`);
        const {note} = applyEditNote(makeNote({undo_stack: fullStack}), edit, NOW);
        assert.equal(note.undo_stack.length, 50);
        assert.equal(note.undo_stack[0], "b:[a\\|b]1");
        const undone = applyNoteDiff(
            {title: note.title, body: note.body}, note.undo_stack[49], false);
        assert.deepEqual(undone, {title: "Old title", body: "Old body"});
    });

    test("does not mutate the existing note", () => {
        const existing = makeNote({});
        applyEditNote(existing, edit, NOW);
        assert.deepEqual(existing, makeNote({}));
    });
});

describe("applyEditNote when the note is not mirrored", () => {
    const edit = {noteId: "note_00001", title: "New title", body: "New body", sourceVersionId: 3};

    test("synthesizes the note from the edit itself", () => {
        const {note} = applyEditNote(undefined, edit, NOW);
        assert.deepEqual(note, {
            user_id: null,
            note_id: "note_00001",
            version_id: 4,
            title: "New title",
            body: "New body",
            create_time: NOW,
            modify_time: NOW,
            format: "PlainText",
            undo_stack: [],
        });
    });

    test("builds the queue record from the UI's sourceVersionId", () => {
        const {command} = applyEditNote(undefined, edit, NOW);
        assert.deepEqual(command, {
            note_id: "note_00001",
            command_type: EDIT_NOTE,
            payload: {title: "New title", body: "New body"},
            source_version_id: 3,
        });
    });
});

describe("applyDeleteNote", () => {
    const request = {noteId: "note_00001", sourceVersionId: 3};

    test("sets delete_time to the purge time and changes nothing else", () => {
        const {note} = applyDeleteNote(makeNote({}), request, NOW);
        assert.deepEqual(note, makeNote({delete_time: "2026-09-21T15:00:00.000Z"}));
    });

    test("builds the queue record with the mirror's version as source", () => {
        const {command} = applyDeleteNote(makeNote({version_id: 7}), request, NOW);
        assert.deepEqual(command, {
            note_id: "note_00001",
            command_type: DELETE_NOTE,
            payload: {},
            source_version_id: 7,
        });
    });

    test("when the note is not mirrored: no note, source from the UI", () => {
        const {note, command} = applyDeleteNote(undefined, request, NOW);
        assert.equal(note, null);
        assert.equal(command.source_version_id, 3);
    });

    test("does not mutate the existing note", () => {
        const existing = makeNote({});
        applyDeleteNote(existing, request, NOW);
        assert.deepEqual(existing, makeNote({}));
    });
});

describe("applyRecoverNote", () => {
    const request = {noteId: "note_00001", sourceVersionId: 3};

    test("removes delete_time, sets modify_time, and changes nothing else", () => {
        const {note} = applyRecoverNote(
            makeNote({delete_time: "2026-09-10T10:00:00Z"}), request, NOW);
        assert.ok(!("delete_time" in note));
        assert.deepEqual(note, makeNote({modify_time: NOW}));
    });

    test("builds the queue record with the mirror's version as source", () => {
        const {command} = applyRecoverNote(makeNote({version_id: 7}), request, NOW);
        assert.deepEqual(command, {
            note_id: "note_00001",
            command_type: RECOVER_NOTE,
            payload: {},
            source_version_id: 7,
        });
    });

    test("when the note is not mirrored: no note, source from the UI", () => {
        const {note, command} = applyRecoverNote(undefined, request, NOW);
        assert.equal(note, null);
        assert.equal(command.source_version_id, 3);
    });

    test("does not mutate the existing note", () => {
        const existing = makeNote({delete_time: "2026-09-10T10:00:00Z"});
        applyRecoverNote(existing, request, NOW);
        assert.deepEqual(existing, makeNote({delete_time: "2026-09-10T10:00:00Z"}));
    });
});
