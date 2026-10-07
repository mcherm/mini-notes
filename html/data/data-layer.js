/**
 * The single data-access interface for note data.
 *
 * UI code never reads or writes notes over the network itself; it calls the
 * `dataLayer` object exported here. Behind that interface sits one of two
 * implementations, chosen by feature detection in `init()`: the
 * `OfflineDataSource`, which serves every call from the network and writes
 * successful responses through to a local mirror, or the passthrough
 * `NetworkDataSource` for environments without usable local storage. See
 * docs/pwa_design.md ("Note Data Caching").
 *
 * The commands with no offline support by design are not part of this
 * interface: export, import, and every user, session and admin command. Their
 * callers use apiFetch from api.js directly.
 *
 * ## Result shapes
 *
 * Read methods resolve to `{ok: true, ...the data}` on success, or to
 * `{ok: false, errorMessage, failureDetail, unreachable}` on failure —
 * `unreachable` is true when the request never completed (the server could
 * not be reached), and false when the server answered, whether with an
 * error status or a body that could not be read. When the server is
 * unreachable, the offline implementation serves reads from the local
 * mirror instead of failing (see OfflineDataSource). The first page of a
 * note list is also served from the mirror when the server answered with an
 * error; a list page served from the mirror carries `fromMirror: true`.
 *
 * Write methods resolve to an outcome object `{outcome, note, status,
 * errorMessage, failureDetail, poisoned}`, where outcome is one of:
 *
 * - `"delivered"` — the server accepted the command; `note` is what it
 *   returned (null for a command whose response carries no note).
 * - `"queued"` — the command was committed locally and will be delivered
 *   later. Only the offline implementation can produce this; `note` is the
 *   locally updated note.
 * - `"rejected"` — the command definitively failed and will not be retried,
 *   either because the server refused it or because the device could not
 *   commit it locally. `status` holds the HTTP status when a server refused
 *   it, and null when the failure was local or the request never completed.
 *   For a conflict (409), `note` carries the conflict note the server
 *   created; for every other rejection `note` is null.
 *
 * `poisoned` is true on the rejected outcome of a queued command that was
 * declared poisoned: its delivery kept failing transiently even though the
 * server's health endpoint answered, so it was removed undelivered
 * (docs/pwa_design.md → "Detecting a Poisoned Command"). On every other
 * outcome `poisoned` is false.
 *
 * A failure carries two strings, and they are not interchangeable:
 *
 * - `errorMessage` is copy meant for the user: the backend's `error` field
 *   when the server answered, and **null** when it did not. The layer never
 *   invents user-facing wording on the backend's behalf; a caller seeing null
 *   supplies its own, which is how each call site keeps its specific phrasing
 *   ("Failed to save changes to note.", and so on).
 * - `failureDetail` says what actually went wrong, for diagnosis rather than
 *   display: the HTTP status, or the browser error behind a request that never
 *   completed or an answer that could not be read. It is always set on a
 *   failure, so nothing this layer learns is discarded at this boundary. It is
 *   also set on a `delivered` outcome whose body was unreadable — the one case
 *   where an accepted command reports no note.
 *
 * A 401 is never reported as a result: apiFetch logs the user out and throws
 * LoggedOutError, which passes through this layer to the caller.
 */

import { LoggedOutError } from "../lib/api.js";
import { NetworkDataSource, recordFailure } from "./network-source.js";
import { OfflineDataSource } from "./offline-source.js";
import { openNoteStore } from "./store.js";
import { SyncEngine } from "./sync-engine.js";

/** The implementation selected by init(); null until then. */
let dataSource = null;

/**
 * The data-access interface used by UI code. Every method delegates to the
 * implementation selected for this session by init().
 */
export const dataLayer = {
    /**
     * Selects the implementation to use for this session; must be awaited
     * before any other method is called. Offline note storage is used
     * whenever a working IndexedDB is present — proven by opening it and
     * performing a trivial write rather than by asking about API support —
     * and the Web Locks API exists for the sync engine's election;
     * otherwise the session runs online-only. The choice is not revisited
     * until the next launch. In offline mode this also starts the sync
     * engine, whose start is the launch-time delivery attempt in the tab
     * that wins the election.
     */
    async init() {
        const network = new NetworkDataSource();
        try {
            if (navigator.locks === undefined) {
                throw new Error("the Web Locks API is unavailable");
            }
            const store = await openNoteStore();
            const offline = new OfflineDataSource(store, network);
            offline.syncEngine = new SyncEngine(
                navigator.locks, () => offline.attemptQueueDelivery());
            dataSource = offline;
            offline.syncEngine.start();
            console.log("data layer: offline note storage is active");
        } catch (e) {
            dataSource = network;
            console.warn("data layer: local note storage is unavailable; running online-only:", e);
        }
    },

    /**
     * Reads one page of the user's active note headers, newest first. Pass
     * null as continueKey for the first page, or the continueKey from a
     * previous result for the page after it.
     * Resolves to {ok: true, noteHeaders, continueKey} — where continueKey is
     * null when there are no further pages — or {ok: false, errorMessage}.
     * In offline mode a first page that the server could not supply is
     * served from the mirror, marked fromMirror: true, and a
     * first page from the server shows notes with queued commands as the
     * mirror has them.
     */
    getNotes(continueKey) {
        return dataSource.getNotes(continueKey);
    },

    /** Reads one page of the user's deleted (trashed) note headers. See getNotes. */
    getDeletedNotes(continueKey) {
        return dataSource.getDeletedNotes(continueKey);
    },

    /**
     * Reads note headers from the local mirror alone, without the network:
     * the trashed notes when fromTrashList is true, the active ones
     * otherwise, newest first, at most limit of them (null for all).
     * Resolves with the header array, or with null when there is no mirror
     * (online-only mode) or it cannot be read. Never rejects.
     */
    getCachedNotes(fromTrashList, limit) {
        return dataSource.getCachedNotes(fromTrashList, limit);
    },

    /** Reads one page of note headers matching searchString. See getNotes. */
    searchNotes(searchString, continueKey) {
        return dataSource.searchNotes(searchString, continueKey);
    },

    /**
     * Reads a single note, active or deleted.
     * Resolves to {ok: true, note} or {ok: false, errorMessage}.
     * raceTimeoutMs bounds how long the caller can be left waiting when a
     * locally mirrored copy could be served instead: when the network has
     * not answered within that many milliseconds and the note is mirrored,
     * the mirrored copy is returned. Pass null for no time limit. In
     * online-only mode there is no mirror and the value is ignored.
     */
    getNote(noteId, raceTimeoutMs) {
        return dataSource.getNote(noteId, raceTimeoutMs);
    },

    /** Creates a note. Resolves to a write outcome (see the file header). */
    newNote({title, body, format}) {
        return dataSource.newNote({noteId: null, title: title, body: body, format: format});
    },

    /**
     * Replaces a note's title and body. sourceVersionId is the version the
     * edit was made against; the server answers 409 when it no longer matches.
     * Resolves to a write outcome.
     */
    editNote({noteId, title, body, sourceVersionId}) {
        return dataSource.editNote({
            noteId: noteId,
            title: title,
            body: body,
            sourceVersionId: sourceVersionId,
        });
    },

    /**
     * Moves a note to the trash. sourceVersionId is the note's version as
     * the caller last saw it; the offline implementation records it on the
     * queued command when the note is not mirrored. Resolves to a write
     * outcome.
     */
    deleteNote(noteId, sourceVersionId) {
        return dataSource.deleteNote(noteId, sourceVersionId);
    },

    /**
     * Restores a note from the trash. sourceVersionId is as for deleteNote.
     * Resolves to a write outcome.
     */
    recoverNote(noteId, sourceVersionId) {
        return dataSource.recoverNote(noteId, sourceVersionId);
    },

    /** Permanently destroys a trashed note. Resolves to a write outcome. */
    destroyNote(noteId) {
        return dataSource.destroyNote(noteId);
    },

    /**
     * Runs one pass of the background refresh that keeps the local mirror
     * in step with the server (and populates it in the first place); a
     * no-op in online-only mode. The UI calls this at launch, after login,
     * and periodically. Resolves when the pass is finished and never
     * rejects, so it is safe to invoke without awaiting.
     */
    refreshMirror() {
        return dataSource.refreshMirror();
    },

    /**
     * Attempts delivery of any queued write commands, in order, stopping at
     * the first transient failure; a no-op in online-only mode. The UI
     * calls this at launch so that commands queued in an earlier session
     * are delivered. Resolves when the pass is finished and never rejects,
     * so it is safe to invoke without awaiting.
     */
    async drainQueue() {
        try {
            await dataSource.drainQueue(null);
        } catch (e) {
            if (!(e instanceof LoggedOutError)) {
                recordFailure("the queue delivery pass failed", e);
            }
        }
    },

    /**
     * Resets the sync engine's retry backoff and triggers an immediate
     * delivery attempt, in whichever tab runs the engine; a no-op in
     * online-only mode. The UI calls this on the browser's `online`
     * event.
     */
    wakeSyncEngine() {
        dataSource.wakeSyncEngine();
    },

    /**
     * Registers the function called when a queued command is definitively
     * refused during a background delivery pass — a failure no write call
     * is left awaiting, so this handler is the only way the user hears of
     * it. The handler receives (command, outcome): the queue record and
     * the write outcome the server answered with. A no-op in online-only
     * mode, where nothing is ever queued.
     */
    setBackgroundRejectionHandler(handler) {
        dataSource.setBackgroundRejectionHandler(handler);
    },

    /**
     * Registers the function called when a queued command meets an edit
     * conflict during a background delivery pass. The local fix-up has
     * already run when the handler is called: the note's queued changes and
     * its mirror entry continue under the conflict note. The handler
     * receives (command, conflictNote): the queue record and the conflict
     * note the server created — its cue to move the UI off the original
     * note if it is showing. A no-op in online-only mode, where nothing is
     * ever queued.
     */
    setBackgroundConflictHandler(handler) {
        dataSource.setBackgroundConflictHandler(handler);
    },

    /**
     * Erases all locally stored note data; called at logout, including the
     * forced logout when the server rejects the session. Never rejects: a
     * failure to wipe is logged. Safe to call before init() has finished — a
     * session that never selected an implementation has stored nothing.
     */
    async wipeLocalData() {
        if (dataSource !== null) {
            await dataSource.wipeLocalData();
        }
    },
};
