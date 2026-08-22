/**
 * Pure logic for the offline write path: what each offline-capable write
 * command does to a locally mirrored note, and the queue record that will
 * carry the command to the server. See docs/pwa_design.md ("Note Data
 * Caching" → "The Write Path" and "Note Fields on Device").
 *
 * Everything here is a pure function of its arguments: no storage, no
 * network, no clock (callers pass the current time in). The write path in
 * data-layer.js commits the results — the note into the mirror and the
 * command into the queue — in one NoteStore transaction.
 *
 * Each apply function returns {note, command}:
 *
 * - note — the note as the mirror should hold it after the command, or null
 *   when there is nothing to mirror: deleting or recovering a note that is
 *   not in the mirror.
 * - command — the queue record, minus the update_queue_seq the store
 *   assigns: {note_id, command_type, payload, source_version_id}. The
 *   payload holds what the delivery call will send beyond the record's own
 *   top-level fields. source_version_id is not frozen into the payload
 *   because the fix-up passes may rewrite it after enqueue.
 *
 * The field rules mirror the server's handlers exactly, so that a locally
 * applied command and the server's eventual application of it agree:
 *
 * - version_id: 0 for new-note, incremented by edit-note, unchanged by
 *   delete-note and recover-deleted-note.
 * - modify_time: set by every command except delete-note, which leaves it
 *   unchanged (as the server does).
 * - delete_time: holds the purge time — the deletion plus the trash
 *   retention period — exactly as the server stores it, not the moment of
 *   deletion.
 * - undo_stack: edit-note pushes a diff that transforms the new title and
 *   body back into the old ones, and keeps at most DIFFS_TO_KEEP entries.
 *
 * source_version_id is the version the server will hold when the command is
 * delivered (docs/pwa_design.md → "Delivering Delayed Updates"): the
 * mirrored note's version at enqueue time, since every queued command
 * before this one will have been applied first. When the note is not
 * mirrored, the caller supplies the version the UI was working from.
 *
 * A note created or synthesized locally has user_id null: the client does
 * not know the user's id, and nothing reads it. The server's response
 * replaces the mirrored note on delivery, real user_id included.
 */

import { diffStrings, formatNoteDiff } from "./diff.js";

/** The command_type values used in queue records. */
export const NEW_NOTE = "new-note";
export const EDIT_NOTE = "edit-note";
export const DELETE_NOTE = "delete-note";
export const RECOVER_NOTE = "recover-deleted-note";

/** The note id scheme from docs/design_notes.md: 10 characters of base 64. */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~";
const ID_LENGTH = 10;

/** How many undo diffs a note keeps; must match the server's cap. */
const DIFFS_TO_KEEP = 50;

/** How long a deleted note stays in the trash; must match the server's SOFT_DELETE_DAYS. */
const SOFT_DELETE_DAYS = 30;

/** Generates a random note id. */
export function generateId() {
    const bytes = new Uint8Array(ID_LENGTH);
    crypto.getRandomValues(bytes);
    // 64 divides 256, so masking to 6 bits leaves the distribution uniform.
    return Array.from(bytes, (b) => ID_ALPHABET[b & 63]).join("");
}

/** The current moment as an RFC 3339 string, for locally applied commands. */
export function currentTimestamp() {
    return new Date().toISOString();
}

/**
 * Applies a new-note command. The note id is client-generated (generateId)
 * and passed in, so the caller can hand the same id to the mirror, the
 * queue, and the UI.
 */
export function applyNewNote({noteId, title, body, format}, now) {
    return {
        note: {
            user_id: null,
            note_id: noteId,
            version_id: 0,
            title: title,
            body: body,
            create_time: now,
            modify_time: now,
            format: format,
            undo_stack: [],
        },
        command: {
            note_id: noteId,
            command_type: NEW_NOTE,
            payload: {title: title, body: body, format: format},
            source_version_id: 0,
        },
    };
}

/**
 * Applies an edit-note command on top of the mirrored note. The edit is
 * applied against the mirror's version, not the version the UI edited
 * from: when the two disagree the mirror wins, which is the last-write-wins
 * behavior the design accepts locally in place of conflict copies.
 *
 * When the note is not mirrored (evicted, or never fetched), a note is
 * synthesized from the edit itself at version sourceVersionId + 1. Its true
 * create_time and undo history are unknowable here; the server's response
 * restores them when the command is delivered.
 */
export function applyEditNote(existingNote, {noteId, title, body, sourceVersionId}, now) {
    if (existingNote === undefined) {
        return {
            note: {
                user_id: null,
                note_id: noteId,
                version_id: sourceVersionId + 1,
                title: title,
                body: body,
                create_time: now,
                modify_time: now,
                format: "PlainText",
                undo_stack: [],
            },
            command: editCommand(noteId, title, body, sourceVersionId),
        };
    }
    const undoDiff = formatNoteDiff(
        diffStrings(title, existingNote.title),
        diffStrings(body, existingNote.body)
    );
    const undoStack = existingNote.undo_stack
        .concat(undoDiff === null ? [] : [undoDiff])
        .slice(-DIFFS_TO_KEEP);
    return {
        note: {
            ...existingNote,
            version_id: existingNote.version_id + 1,
            title: title,
            body: body,
            modify_time: now,
            undo_stack: undoStack,
        },
        command: editCommand(noteId, title, body, existingNote.version_id),
    };
}

/** The queue record for an edit, shared by both branches of applyEditNote. */
function editCommand(noteId, title, body, sourceVersionId) {
    return {
        note_id: noteId,
        command_type: EDIT_NOTE,
        payload: {title: title, body: body},
        source_version_id: sourceVersionId,
    };
}

/**
 * Applies a delete-note command: the mirrored note gains a delete_time (the
 * purge time, per the file header) and changes in no other way. sourceVersionId
 * is used only when the note is not mirrored (see the file header).
 */
export function applyDeleteNote(existingNote, {noteId, sourceVersionId}, now) {
    const purgeTime =
        new Date(Date.parse(now) + SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return {
        note: existingNote === undefined ? null : {...existingNote, delete_time: purgeTime},
        command: {
            note_id: noteId,
            command_type: DELETE_NOTE,
            payload: {},
            source_version_id: existingNote === undefined
                ? sourceVersionId
                : existingNote.version_id,
        },
    };
}

/**
 * Applies a recover-deleted-note command: the mirrored note loses its
 * delete_time and gets a fresh modify_time, so it takes its place at the
 * top of the note list. sourceVersionId is used only when the note is not
 * mirrored (see the file header).
 */
export function applyRecoverNote(existingNote, {noteId, sourceVersionId}, now) {
    let note = null;
    if (existingNote !== undefined) {
        note = {...existingNote, modify_time: now};
        delete note.delete_time;
    }
    return {
        note: note,
        command: {
            note_id: noteId,
            command_type: RECOVER_NOTE,
            payload: {},
            source_version_id: existingNote === undefined
                ? sourceVersionId
                : existingNote.version_id,
        },
    };
}
