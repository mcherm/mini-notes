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
 * mirror instead of failing (see OfflineDataSource).
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

import { apiFetch, extractErrorMessage, getApiBaseUrl, LoggedOutError } from "./api.js";
import {
    DELETE_NOTE, EDIT_NOTE, NEW_NOTE, RECOVER_NOTE,
    applyDeleteNote, applyEditNote, applyNewNote, applyRecoverNote,
    currentTimestamp, generateId,
} from "./commands.js";
import { openNoteStore } from "./store.js";
import { DELIVERY_IDLE, DELIVERY_RETRY, SyncEngine } from "./sync-engine.js";

/** Builds a `?continue_key=...` query suffix (empty string for the first page). */
function continueKeyQuery(continueKey, leadingChar) {
    if (continueKey === null) return "";
    return `${leadingChar}continue_key=${encodeURIComponent(continueKey)}`;
}

/** Builds the URL of a single note, for the endpoints keyed by note_id. */
function noteUrl(path, noteId) {
    return `${getApiBaseUrl()}${path}${encodeURIComponent(noteId)}`;
}

/**
 * Records a failure that the backend never got to describe — a request that
 * did not complete, or an answer that could not be read. Logs it, since the
 * browser error is otherwise swallowed by the catch that calls this, and
 * returns the string for the result's failureDetail field.
 */
function recordFailure(description, error) {
    console.warn(`data-layer: ${description}:`, error);
    return `${description}: ${error}`;
}

/** Builds the failure form of a read result. */
function readFailure(errorMessage, failureDetail, unreachable) {
    return {
        ok: false,
        errorMessage: errorMessage,
        failureDetail: failureDetail,
        unreachable: unreachable,
    };
}

/** Builds the delivered form of a write outcome. */
function writeDelivered(note, status, failureDetail) {
    return {
        outcome: "delivered",
        note: note,
        status: status,
        errorMessage: null,
        failureDetail: failureDetail,
        poisoned: false,
    };
}

/**
 * Builds the rejected form of a write outcome. note is the conflict note
 * from a 409 answer, and null for every other rejection.
 */
function writeRejected(status, errorMessage, failureDetail, note) {
    return {
        outcome: "rejected",
        note: note,
        status: status,
        errorMessage: errorMessage,
        failureDetail: failureDetail,
        poisoned: false,
    };
}

/**
 * Builds the queued form of a write outcome: the command is committed
 * locally and will be delivered later. note is the locally updated note,
 * or null for a command that could not update the mirror (deleting or
 * recovering a note that is not mirrored).
 */
function writeQueued(note) {
    return {
        outcome: "queued",
        note: note,
        status: null,
        errorMessage: null,
        failureDetail: null,
        poisoned: false,
    };
}

/**
 * Parses a response body as JSON. Resolves to {data, failureDetail}, where
 * exactly one of the two is set: a body that cannot be read (an empty body, a
 * gateway's HTML error page, a truncated response) yields the failureDetail
 * instead of the data.
 */
async function readJson(response, url) {
    try {
        return {data: await response.json(), failureDetail: null};
    } catch (e) {
        return {data: null, failureDetail: recordFailure(`could not read the response body from ${url}`, e)};
    }
}

/** Fetches one page of note headers from a list-style endpoint. */
async function fetchNoteHeaderPage(url) {
    let response;
    try {
        response = await apiFetch(url, {method: "GET"});
    } catch (e) {
        if (e instanceof LoggedOutError) throw e;
        return readFailure(null, recordFailure(`request to ${url} did not complete`, e), true);
    }
    if (!response.ok) {
        return readFailure(
            await extractErrorMessage(response), `HTTP ${response.status} from ${url}`, false);
    }
    const parsed = await readJson(response, url);
    if (parsed.failureDetail !== null) {
        return readFailure(null, parsed.failureDetail, false);
    }
    return {
        ok: true,
        noteHeaders: parsed.data.note_headers,
        continueKey: parsed.data.continue_key || null,
    };
}

/** Fetches a single note. */
async function fetchNote(url) {
    let response;
    try {
        response = await apiFetch(url, {method: "GET"});
    } catch (e) {
        if (e instanceof LoggedOutError) throw e;
        return readFailure(null, recordFailure(`request to ${url} did not complete`, e), true);
    }
    if (!response.ok) {
        return readFailure(
            await extractErrorMessage(response), `HTTP ${response.status} from ${url}`, false);
    }
    const parsed = await readJson(response, url);
    if (parsed.failureDetail !== null) {
        return readFailure(null, parsed.failureDetail, false);
    }
    return {ok: true, note: parsed.data.note};
}

/**
 * Sends one write command to the server and reports the outcome. The note is
 * read from the response when the server returned one (`destroy-note` doesn't,
 * and neither does any command answered by an older backend).
 */
async function sendWriteCommand(url, options) {
    let response;
    try {
        response = await apiFetch(url, options);
    } catch (e) {
        if (e instanceof LoggedOutError) throw e;
        return writeRejected(
            null, null, recordFailure(`request to ${url} did not complete`, e), null);
    }
    if (response.status === 409) {
        // A conflict answer's body is not an error message but the conflict
        // note the server created (docs/pwa_design.md → "Delivery Outcomes");
        // it rides on the outcome so the conflict fix-up can follow it.
        const parsed = await readJson(response, url);
        const note = (parsed.data !== null && parsed.data.note) ? parsed.data.note : null;
        return writeRejected(
            response.status, null, `HTTP ${response.status} from ${url}`, note);
    }
    if (!response.ok) {
        return writeRejected(
            response.status,
            await extractErrorMessage(response),
            `HTTP ${response.status} from ${url}`,
            null);
    }
    if (response.status === 204) {
        // No content by definition; the command carries no note back.
        return writeDelivered(null, response.status, null);
    }
    const parsed = await readJson(response, url);
    const note = (parsed.data !== null && parsed.data.note) ? parsed.data.note : null;
    return writeDelivered(note, response.status, parsed.failureDetail);
}

/** Sentinel resolved by raceAgainstTimeout when the timeout fires first. */
const FETCH_TIMED_OUT = Symbol("fetch timed out");

/**
 * Resolves with the promise's value — or with FETCH_TIMED_OUT when the
 * promise has not settled within timeoutMs. The promise keeps running
 * either way. Its eventual settlement is always observed here, so a fetch
 * abandoned to the timeout can never surface as an unhandled rejection.
 */
function raceAgainstTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(FETCH_TIMED_OUT), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/** Options for a write command that sends a JSON body. */
function jsonRequest(method, body) {
    return {
        method: method,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    };
}

/**
 * Passthrough implementation: every call goes straight to the server, exactly
 * as the UI code did before this layer existed. This is the implementation
 * used for a whole session in environments without usable local storage.
 */
class NetworkDataSource {
    getNotes(continueKey) {
        return fetchNoteHeaderPage(
            `${getApiBaseUrl()}/api/v1/notes${continueKeyQuery(continueKey, "?")}`);
    }

    getDeletedNotes(continueKey) {
        return fetchNoteHeaderPage(
            `${getApiBaseUrl()}/api/v1/deleted_notes${continueKeyQuery(continueKey, "?")}`);
    }

    searchNotes(searchString, continueKey) {
        const query = `search_string=${encodeURIComponent(searchString)}`;
        return fetchNoteHeaderPage(
            `${getApiBaseUrl()}/api/v1/note_search?${query}${continueKeyQuery(continueKey, "&")}`);
    }

    /**
     * raceTimeoutMs is part of the shared interface but means nothing here:
     * with no local copy to fall back to, the network is simply awaited.
     */
    getNote(noteId, raceTimeoutMs) {
        return fetchNote(noteUrl("/api/v1/notes/", noteId));
    }

    /**
     * noteId is either a client-generated id to create the note under (the
     * offline write path assigns ids up front), or null to let the server
     * generate one (used for tha passthrough mode write path).
     */
    newNote({noteId, title, body, format}) {
        const request = {title: title, body: body, format: format};
        if (noteId !== null) {
            request.note_id = noteId;
        }
        return sendWriteCommand(
            `${getApiBaseUrl()}/api/v1/notes`,
            jsonRequest("POST", request));
    }

    editNote({noteId, title, body, sourceVersionId}) {
        return sendWriteCommand(
            noteUrl("/api/v1/notes/", noteId),
            jsonRequest("PUT", {title: title, body: body, source_version_id: sourceVersionId}));
    }

    /**
     * sourceVersionId is part of the shared interface but is not sent: the
     * server derives everything it needs from the session and the note id.
     */
    deleteNote(noteId, sourceVersionId) {
        return sendWriteCommand(noteUrl("/api/v1/notes/", noteId), {method: "DELETE"});
    }

    /** sourceVersionId is not sent; see deleteNote. */
    recoverNote(noteId, sourceVersionId) {
        return sendWriteCommand(noteUrl("/api/v1/recover_note/", noteId), {method: "POST"});
    }

    destroyNote(noteId) {
        return sendWriteCommand(noteUrl("/api/v1/deleted_notes/", noteId), {method: "DELETE"});
    }

    /**
     * True when the server answers its unauthenticated health endpoint with
     * success — the test poisoned-command detection uses to tell being
     * offline from a command the server cannot process. Uses plain fetch,
     * not apiFetch: no session is involved, and a failing health check must
     * never route through the logout handling.
     */
    async checkHealth() {
        const url = `${getApiBaseUrl()}/api/v1/health-check`;
        try {
            const response = await fetch(url, {method: "GET"});
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    /** There is no mirror in this mode, so there is nothing to refresh. */
    async refreshMirror() {}

    /** There is no queue in this mode, so there is nothing to deliver. */
    async drainQueue(foregroundSeq) {
        return new Map();
    }

    /** There is no queue in this mode, so background rejections cannot occur. */
    setBackgroundRejectionHandler(handler) {}

    /** There is no queue in this mode, so background conflicts cannot occur. */
    setBackgroundConflictHandler(handler) {}

    /** There is no sync engine in this mode, so there is nothing to wake. */
    wakeSyncEngine() {}

    /** Nothing is stored locally in this mode, so there is nothing to wipe. */
    async wipeLocalData() {}
}

/**
 * Sends one queued command to the server through the network data source's
 * write methods, resolving with the write outcome. The request is built
 * from the queue record: the payload, plus the record's own note_id and
 * source_version_id — the latter read at delivery time, not enqueue time,
 * because the fix-up passes may rewrite it while the command waits.
 */
function deliverCommand(network, command) {
    switch (command.command_type) {
        case NEW_NOTE:
            return network.newNote({
                noteId: command.note_id,
                title: command.payload.title,
                body: command.payload.body,
                format: command.payload.format,
            });
        case EDIT_NOTE:
            return network.editNote({
                noteId: command.note_id,
                title: command.payload.title,
                body: command.payload.body,
                sourceVersionId: command.source_version_id,
            });
        case DELETE_NOTE:
            return network.deleteNote(command.note_id, command.source_version_id);
        case RECOVER_NOTE:
            return network.recoverNote(command.note_id, command.source_version_id);
        default:
            throw new Error(`unknown queued command type "${command.command_type}"`);
    }
}

/**
 * True when a write outcome is a transient failure — the server was never
 * reached (network error or timeout) or answered 5xx. A transient failure
 * leaves the command at the head of the queue for a later delivery pass;
 * every other rejection is definitive (docs/pwa_design.md → "Delivery
 * Outcomes"). A poisoned outcome is transient in form but definitive by
 * declaration: the command has already been given its last retry.
 */
function isTransientFailure(outcome) {
    return outcome.outcome === "rejected"
        && outcome.poisoned === false
        && (outcome.status === null || outcome.status >= 500);
}

/**
 * How many consecutive transient failures of one queued command trigger
 * the health check that begins poisoned-command detection
 * (docs/pwa_design.md → "Detecting a Poisoned Command").
 */
export const POISON_CHECK_THRESHOLD = 5;

/**
 * True when a note header agrees with a mirrored note: same version, same
 * modify time, and the same side of the active/trash divide as the list the
 * header came from.
 */
function headerMatchesNote(header, note, fromTrashList) {
    return header.version_id === note.version_id
        && header.modify_time === note.modify_time
        && fromTrashList === (note.delete_time !== undefined);
}

/**
 * Sort comparator putting the newest modify_time first. Modify times are
 * RFC 3339 strings in UTC, which order chronologically when compared as
 * strings.
 */
export function byModifyTimeNewestFirst(a, b) {
    if (a.modify_time < b.modify_time) return 1;
    if (a.modify_time > b.modify_time) return -1;
    return 0;
}

/** The note header a list endpoint would send for this note. */
function headerFromNote(note) {
    return {
        user_id: note.user_id,
        note_id: note.note_id,
        version_id: note.version_id,
        title: note.title,
        modify_time: note.modify_time,
        format: note.format,
    };
}

/**
 * The headers of the mirrored notes on one side of the active/trash divide,
 * newest first — the offline substitute for one of the server's two note
 * lists.
 */
function mirroredHeaders(notes, fromTrashList) {
    return notes
        .filter((note) => fromTrashList === (note.delete_time !== undefined))
        .sort(byModifyTimeNewestFirst)
        .map(headerFromNote);
}

/**
 * The headers of the mirrored active notes matching a search — the offline
 * substitute for a server-side search, matching its semantics: the search
 * string occurs somewhere in the title or body, compared case-insensitively;
 * trashed notes are not searched; and results come in note_id order, exactly
 * as the server returns them. Presentation order is the UI's concern — it
 * sorts search results itself, whichever implementation served them.
 */
function searchMirroredNotes(notes, searchString) {
    const searchLower = searchString.toLowerCase();
    return notes
        .filter((note) => note.delete_time === undefined)
        .filter((note) => note.title.toLowerCase().includes(searchLower)
            || note.body.toLowerCase().includes(searchLower))
        .map(headerFromNote);
}

/**
 * The implementation used when a working IndexedDB is available. Reads are
 * served by the network — it holds a NetworkDataSource and delegates to it
 * — with successful responses written through to the local mirror and
 * unreachable failures answered from it (docs/pwa_design.md → "The Read
 * Path"). Offline-capable writes run the other way around: the command is
 * committed locally first, mirror and queue in one transaction, and a
 * delivery pass then pushes the queue to the server (→ "The Write Path");
 * a command a pass leaves stuck is retried by the sync engine attached in
 * init() (→ "Delivering Delayed Updates").
 * Writes of server state into the mirror go through NoteStore's
 * read-barrier-guarded operations, and for reads a local-store failure
 * never changes a call's result: the network's answer stands.
 */
export class OfflineDataSource {
    constructor(store, network) {
        this.store = store;
        this.network = network;
        this.refreshInProgress = false;
        this.lastDrain = Promise.resolve();
        // Consecutive transient failures of the queued command at the head
        // of the queue, counted across delivery passes for poisoned-command
        // detection (deliverWithPoisonDetection). Held in memory only: a
        // relaunch starts the count over.
        this.headFailures = {seq: null, count: 0};
        // All three are attached after construction: the sync engine by
        // init(), the handlers by their set…Handler methods. Any of them
        // may stay null for a whole session (and does in tests).
        this.syncEngine = null;
        this.onBackgroundRejection = null;
        this.onBackgroundConflict = null;
    }

    /**
     * Registers the function called when a delivery pass hits a definitive
     * refusal of a command whose outcome no write call is awaiting; see
     * runDrainPass.
     */
    setBackgroundRejectionHandler(handler) {
        this.onBackgroundRejection = handler;
    }

    /**
     * Registers the function called when a delivery pass hits a conflict on
     * a command whose outcome no write call is awaiting; see
     * completeConflictBranch.
     */
    setBackgroundConflictHandler(handler) {
        this.onBackgroundConflict = handler;
    }

    /**
     * Resets the sync engine's retry backoff and triggers an immediate
     * delivery attempt — in the tab running the engine's loop, which is
     * not necessarily this one (html/sync-engine.js).
     */
    wakeSyncEngine() {
        if (this.syncEngine !== null) {
            this.syncEngine.wake();
        }
    }

    /**
     * Runs one local-store update, absorbing any failure, since a local
     * problem must not turn a successful network operation into a failed one.
     */
    async attemptLocalWrite(description, action) {
        try {
            await action();
        } catch (e) {
            recordFailure(description, e);
        }
    }

    /**
     * Brings the mirror in line with one page of note headers from the
     * active-notes or trash list. A mirrored note whose header shows a
     * different version, modify time, or trash status is evicted: the mirror
     * only ever holds notes whose full content was seen at exactly the state
     * the server reports, and an evicted note returns to the mirror the next
     * time its content is fetched. Headers for notes that are not mirrored
     * are ignored — a header carries no body to mirror.
     */
    async reconcileHeaders(noteHeaders, fromTrashList) {
        for (const header of noteHeaders) {
            const mirrored = await this.store.getNote(header.note_id);
            if (mirrored === undefined || headerMatchesNote(header, mirrored, fromTrashList)) {
                continue;
            }
            await this.store.deleteNoteFromServer(header.note_id);
        }
    }

    /**
     * Offline fallback for the header-list reads: when the server was
     * unreachable, the first page is answered from the mirror — every
     * mirrored note on the requested side of the active/trash divide,
     * newest first, in a single page with no continuation key. Every other
     * failure is returned unchanged: a failure the server answered with, an
     * unreachable *later* page (the mirror's complete list cannot continue
     * a partially delivered server listing), and the case where the mirror
     * itself cannot be read.
     */
    async serveHeadersFromMirror(networkFailure, continueKey, fromTrashList) {
        if (!networkFailure.unreachable || continueKey !== null) {
            return networkFailure;
        }
        try {
            const notes = await this.store.getAllNotes();
            console.log("data layer: serving the note list from the local mirror");
            return {ok: true, noteHeaders: mirroredHeaders(notes, fromTrashList), continueKey: null};
        } catch (e) {
            recordFailure("could not serve the note list from the mirror", e);
            return networkFailure;
        }
    }

    /**
     * Offline fallback for a single-note read: when the server was
     * unreachable and the note is mirrored, the mirrored copy is served.
     * Every other failure returns the network's failure unchanged: a
     * failure the server answered with, a note that is not in the mirror,
     * and the case where the mirror itself cannot be read.
     */
    async serveNoteFromMirror(networkFailure, noteId) {
        if (!networkFailure.unreachable) {
            return networkFailure;
        }
        try {
            const mirrored = await this.store.getNote(noteId);
            if (mirrored === undefined) {
                return networkFailure;
            }
            console.log(`data layer: serving note ${noteId} from the local mirror`);
            return {ok: true, note: mirrored};
        } catch (e) {
            recordFailure("could not serve a note from the mirror", e);
            return networkFailure;
        }
    }

    async getNotes(continueKey) {
        const result = await this.network.getNotes(continueKey);
        if (!result.ok) {
            return this.serveHeadersFromMirror(result, continueKey, false);
        }
        await this.attemptLocalWrite(
            "could not reconcile the mirror against active note headers",
            () => this.reconcileHeaders(result.noteHeaders, false)
        );
        return result;
    }

    async getDeletedNotes(continueKey) {
        const result = await this.network.getDeletedNotes(continueKey);
        if (!result.ok) {
            return this.serveHeadersFromMirror(result, continueKey, true);
        }
        await this.attemptLocalWrite(
            "could not reconcile the mirror against trash note headers",
            () => this.reconcileHeaders(result.noteHeaders, true)
        );
        return result;
    }

    /**
     * Offline fallback for search: when the server was unreachable, the
     * first page is answered by searching the mirror, with every match in a
     * single page. The same failures pass through unchanged as for
     * serveHeadersFromMirror.
     */
    async serveSearchFromMirror(networkFailure, searchString, continueKey) {
        if (!networkFailure.unreachable || continueKey !== null) {
            return networkFailure;
        }
        try {
            const notes = await this.store.getAllNotes();
            console.log("data layer: serving a search from the local mirror");
            return {
                ok: true,
                noteHeaders: searchMirroredNotes(notes, searchString),
                continueKey: null,
            };
        } catch (e) {
            recordFailure("could not serve a search from the mirror", e);
            return networkFailure;
        }
    }

    /**
     * Served by the network when it answers; search pages are not used to
     * maintain the mirror.
     */
    async searchNotes(searchString, continueKey) {
        const result = await this.network.searchNotes(searchString, continueKey);
        if (!result.ok) {
            return this.serveSearchFromMirror(result, searchString, continueKey);
        }
        return result;
    }

    /**
     * The network read of a single note, with its mirror bookkeeping: a
     * fetched note is written through to the mirror, and an unreachable
     * failure is served from it.
     */
    async readNoteFromNetwork(noteId) {
        const result = await this.network.getNote(noteId, null);
        if (!result.ok) {
            return this.serveNoteFromMirror(result, noteId);
        }
        await this.attemptLocalWrite(
            "could not mirror a fetched note",
            () => this.store.putNoteFromServer(result.note)
        );
        return result;
    }

    /**
     * Reads a note, racing the network against raceTimeoutMs (Mechanism 1,
     * docs/pwa_design.md → "Update on Edit"). Normally the network settles
     * in time and its result stands, exactly as for the other reads. When
     * it has not settled within raceTimeoutMs and the note is mirrored, the
     * mirrored copy is served so that a connection that hangs — rather than
     * failing fast — cannot stall opening a note; the abandoned fetch still
     * finishes in the background, updating the mirror for later reads. When
     * the note is not mirrored (or the mirror cannot be read), there is
     * nothing to serve and the network is waited out after all. Pass null
     * as raceTimeoutMs to wait for the network with no time limit.
     *
     * Always resolves to a read result ({ok: true, note} or the failure
     * shape), despite the mixed-looking returns: as in any async function,
     * a returned plain object becomes the resolution value, and a returned
     * promise (networkRead) is adopted — the caller's promise settles with
     * that promise's eventual result, never with the promise itself.
     */
    async getNote(noteId, raceTimeoutMs) {
        const networkRead = this.readNoteFromNetwork(noteId);
        if (raceTimeoutMs === null) {
            return networkRead;
        }
        const raced = await raceAgainstTimeout(networkRead, raceTimeoutMs);
        if (raced !== FETCH_TIMED_OUT) {
            return raced;
        }
        let mirrored;
        try {
            mirrored = await this.store.getNote(noteId);
        } catch (e) {
            recordFailure("could not read the mirror while racing a slow note fetch", e);
            mirrored = undefined;
        }
        if (mirrored === undefined) {
            return networkRead;
        }
        console.log(`data layer: fetch timed out; serving note ${noteId} from the local mirror`);
        return {ok: true, note: mirrored};
    }

    /**
     * Commits one offline-capable write command locally and reports the
     * outcome of its first delivery attempt (docs/pwa_design.md → "The
     * Write Path"). A queued outcome additionally wakes the sync engine:
     * the command is still in the queue, and enqueueing is one of the
     * events that resets the engine's backoff.
     */
    async commitAndDeliver(localNote, command) {
        const outcome = await this.commitAndAttempt(localNote, command);
        if (outcome.outcome === "queued") {
            this.wakeSyncEngine();
        }
        return outcome;
    }

    /**
     * The commit and first delivery attempt behind commitAndDeliver. The
     * mirror update and the queue append happen in one transaction; if
     * that fails, nothing was committed and the write is rejected. The
     * delivery pass that follows sends the whole queue in order, so the
     * new command's own attempt happens only after every earlier command
     * has delivered; when the pass stops before reaching it, or the
     * command's own delivery fails transiently, the command is safely
     * queued and the outcome says so.
     */
    async commitAndAttempt(localNote, command) {
        let seq;
        try {
            seq = await this.store.commitLocalWrite(localNote, command);
        } catch (e) {
            return writeRejected(
                null, null,
                recordFailure(`could not commit a ${command.command_type} locally`, e),
                null);
        }
        let outcomes;
        try {
            outcomes = await this.drainQueue(seq);
        } catch (e) {
            if (e instanceof LoggedOutError) throw e;
            recordFailure("the delivery pass after a local commit failed", e);
            return writeQueued(localNote);
        }
        const attempted = outcomes.get(seq);
        if (attempted === undefined || isTransientFailure(attempted)) {
            return writeQueued(localNote);
        }
        return attempted;
    }

    /**
     * Shared prologue of the writes that modify an existing note: reads the
     * mirrored copy for buildWrite (a commands.js apply function) to work
     * from, then commits and delivers what it built.
     */
    async writeAgainstMirror(noteId, buildWrite) {
        let existing;
        try {
            existing = await this.store.getNote(noteId);
        } catch (e) {
            return writeRejected(
                null, null,
                recordFailure("could not read the mirror to apply a write", e),
                null);
        }
        const {note, command} = buildWrite(existing);
        return this.commitAndDeliver(note, command);
    }

    /**
     * Creates the note locally under a client-generated id (unless the
     * caller supplied one) and queues the new-note command. The note has
     * its permanent id immediately, so the UI and any later queued
     * commands can reference it before the server has seen the note.
     */
    newNote({noteId, title, body, format}) {
        const assignedId = noteId === null ? generateId() : noteId;
        const {note, command} = applyNewNote(
            {noteId: assignedId, title: title, body: body, format: format},
            currentTimestamp());
        return this.commitAndDeliver(note, command);
    }

    /**
     * Applies the edit to the mirrored note and queues the edit-note
     * command. The mirror's version wins over sourceVersionId when the two
     * disagree — the local layer resolves concurrent offline edits by
     * last-write-wins rather than conflict copies.
     */
    editNote({noteId, title, body, sourceVersionId}) {
        return this.writeAgainstMirror(noteId, (existing) => applyEditNote(
            existing,
            {noteId: noteId, title: title, body: body, sourceVersionId: sourceVersionId},
            currentTimestamp()));
    }

    deleteNote(noteId, sourceVersionId) {
        return this.writeAgainstMirror(noteId, (existing) => applyDeleteNote(
            existing,
            {noteId: noteId, sourceVersionId: sourceVersionId},
            currentTimestamp()));
    }

    recoverNote(noteId, sourceVersionId) {
        return this.writeAgainstMirror(noteId, (existing) => applyRecoverNote(
            existing,
            {noteId: noteId, sourceVersionId: sourceVersionId},
            currentTimestamp()));
    }

    async destroyNote(noteId) {
        const outcome = await this.network.destroyNote(noteId);
        if (outcome.outcome === "delivered") {
            await this.attemptLocalWrite(
                "could not remove a destroyed note from the mirror",
                () => this.store.deleteNoteFromServer(noteId)
            );
        }
        return outcome;
    }

    /**
     * One delivery pass over the update queue (docs/pwa_design.md →
     * "Delivering Delayed Updates"): repeatedly deliver the command at the
     * head of the queue — never more than one in flight — until the queue
     * is empty or a delivery fails transiently, which leaves that command
     * at the head for a later pass — unless the failure is escalated into
     * a poisoned declaration (deliverWithPoisonDetection), which removes
     * the command like a definitive refusal. A delivered command is completed
     * through the store: removed from the queue, with the server's
     * returned note written to the mirror unless later commands for that
     * note remain. A command answered with a conflict is completed through
     * the conflict fix-up (completeConflictBranch). Any other definitively
     * refused command is removed and repaired through the store's removal
     * fix-up, and the refusal is logged.
     *
     * Passes never overlap: a call while a pass is running waits for that
     * pass to finish, then runs a full pass of its own. Resolves with a
     * Map from update_queue_seq to the write outcome of every command this
     * pass attempted — how the write path learns the fate of a command it
     * just enqueued (a seq absent from the Map was not attempted, so that
     * command is still queued). The pass rejects if a delivery throws
     * (LoggedOutError: the session is gone, and the logout path wipes the
     * queue) or the store's bookkeeping fails.
     *
     * foregroundSeq is the seq of the just-enqueued command whose outcome
     * the caller of the write is already awaiting, or null when there is
     * none: a definitive refusal of any *other* command is reported to
     * the background-rejection handler, since no caller would otherwise
     * hear of it.
     */
    drainQueue(foregroundSeq) {
        const run = () => this.runDrainPass(foregroundSeq);
        const pass = this.lastDrain.then(run, run);
        this.lastDrain = pass.catch(() => undefined);
        return pass;
    }

    /** The body of one drainQueue pass; see drainQueue. */
    async runDrainPass(foregroundSeq) {
        const outcomes = new Map();
        while (true) {
            const command = await this.store.peekCommand();
            if (command === null) {
                return outcomes;
            }
            const outcome = await this.deliverWithPoisonDetection(command);
            outcomes.set(command.update_queue_seq, outcome);
            if (isTransientFailure(outcome)) {
                return outcomes;
            }
            if (outcome.outcome === "delivered") {
                await this.store.completeDeliveredCommand(
                    command.update_queue_seq, command.note_id, outcome.note);
            } else if (outcome.status === 409 && outcome.note !== null) {
                await this.completeConflictBranch(command, outcome.note, foregroundSeq);
            } else {
                const description = outcome.poisoned
                    ? `a queued ${command.command_type} for note ${command.note_id} kept `
                        + `failing with the server reachable; it was declared poisoned and dropped`
                    : `the server refused a queued ${command.command_type} for note `
                        + `${command.note_id}; the command was dropped`;
                recordFailure(description, outcome.failureDetail);
                if (command.update_queue_seq !== foregroundSeq) {
                    this.reportBackgroundRejection(command, outcome);
                }
                await this.store.removeFailedCommand(
                    command.update_queue_seq, command.note_id);
            }
        }
    }

    /**
     * Delivers the head command once, escalating persistent transient
     * failure into poisoned-command detection (docs/pwa_design.md →
     * "Detecting a Poisoned Command"). Transient failures of the same
     * command are counted across delivery passes; from the
     * POISON_CHECK_THRESHOLDth on, each failure triggers a health check to
     * tell being offline from a command the server cannot process. When
     * the health check fails, the device really is offline: the failure
     * stays transient and the retry loop keeps backing off. When it
     * succeeds, the command is retried once more; if that retry also fails
     * transiently, the command is declared poisoned. Resolves with the
     * outcome of the last delivery attempt made, marked poisoned: true on
     * a declaration — the caller then removes the command like a
     * definitive refusal.
     */
    async deliverWithPoisonDetection(command) {
        const outcome = await deliverCommand(this.network, command);
        if (!isTransientFailure(outcome)) {
            this.headFailures = {seq: null, count: 0};
            return outcome;
        }
        if (this.headFailures.seq !== command.update_queue_seq) {
            this.headFailures = {seq: command.update_queue_seq, count: 0};
        }
        this.headFailures.count += 1;
        if (this.headFailures.count < POISON_CHECK_THRESHOLD) {
            return outcome;
        }
        if (!(await this.network.checkHealth())) {
            return outcome;
        }
        const retry = await deliverCommand(this.network, command);
        this.headFailures = {seq: null, count: 0};
        if (!isTransientFailure(retry)) {
            return retry;
        }
        return {...retry, poisoned: true};
    }

    /**
     * Completes a queued command the server answered with a conflict: the
     * server created a conflict note holding the command's content, and the
     * note's queued branch of history continues there (docs/pwa_design.md →
     * "Fix-up Pass: Conflict"). The store's fix-up re-addresses the later
     * queued commands and the mirror entry to the conflict note; the
     * server's own copy of the conflict note is then written to the mirror,
     * unless the re-addressed commands are still ahead of it (the read
     * barrier skips it). A conflict on a command whose outcome no write
     * call is awaiting is reported to the background-conflict handler; the
     * foreground command's caller learns of it from its own outcome, as
     * for rejections.
     */
    async completeConflictBranch(command, conflictNote, foregroundSeq) {
        console.log(
            `data layer: a queued ${command.command_type} for note ${command.note_id} `
                + `conflicted; its queued changes continue on note ${conflictNote.note_id}`);
        await this.store.completeConflictCommand(
            command.update_queue_seq, command.note_id, conflictNote.note_id);
        await this.store.putNoteFromServer(conflictNote);
        if (command.update_queue_seq !== foregroundSeq) {
            this.reportBackgroundConflict(command, conflictNote);
        }
    }

    /**
     * Hands a background definitive refusal to the registered handler, if
     * any. A handler failure is logged and absorbed: reporting a refusal
     * must not be able to stop the delivery pass that found it.
     */
    reportBackgroundRejection(command, outcome) {
        if (this.onBackgroundRejection === null) {
            return;
        }
        try {
            this.onBackgroundRejection(command, outcome);
        } catch (e) {
            recordFailure("the background-rejection handler failed", e);
        }
    }

    /**
     * Hands a background conflict to the registered handler, if any. As for
     * reportBackgroundRejection, a handler failure is logged and absorbed.
     */
    reportBackgroundConflict(command, conflictNote) {
        if (this.onBackgroundConflict === null) {
            return;
        }
        try {
            this.onBackgroundConflict(command, conflictNote);
        } catch (e) {
            recordFailure("the background-conflict handler failed", e);
        }
    }

    /**
     * The sync engine's delivery attempt (html/sync-engine.js): one pass
     * over the queue, then a report of whether the engine may go idle. A
     * rejected session reports an idle queue — the forced logout is
     * wiping it. Any other failure propagates, which the engine treats
     * as a retry.
     */
    async attemptQueueDelivery() {
        try {
            await this.drainQueue(null);
        } catch (e) {
            if (e instanceof LoggedOutError) {
                return DELIVERY_IDLE;
            }
            throw e;
        }
        const head = await this.store.peekCommand();
        return head === null ? DELIVERY_IDLE : DELIVERY_RETRY;
    }

    /**
     * Collects every header from one of the server's paged note lists by
     * following continuation keys to the end. Resolves with the combined
     * header array, or with null when any page fails — a partial listing
     * must not be acted on, since a note missing from it would look
     * deleted.
     */
    async collectAllHeaders(fetchPage) {
        const headers = [];
        let continueKey = null;
        do {
            const result = await fetchPage(continueKey);
            if (!result.ok) {
                return null;
            }
            headers.push(...result.noteHeaders);
            continueKey = result.continueKey;
        } while (continueKey !== null);
        return headers;
    }

    /**
     * One pass of the background refresh (docs/pwa_design.md →
     * "Background Updates"): fetches the server's complete active and trash
     * lists, refetches and mirrors every note that is new or differs from
     * its mirrored copy, and removes mirrored notes the server no longer
     * lists. This is also what populates an empty mirror. A note with
     * queued commands is skipped (the read barrier); a note whose refetch
     * fails is skipped, without stopping the pass.
     *
     * Never rejects, and never runs concurrently with itself: a call while
     * a pass is already running resolves immediately, and any failure ends
     * the pass quietly — the next pass starts over.
     */
    async refreshMirror() {
        if (this.refreshInProgress) {
            return;
        }
        this.refreshInProgress = true;
        try {
            await this.runRefreshPass();
        } catch (e) {
            if (!(e instanceof LoggedOutError)) {
                recordFailure("the mirror refresh pass failed", e);
            }
        } finally {
            this.refreshInProgress = false;
        }
    }

    /** The body of refreshMirror, free to throw. */
    async runRefreshPass() {
        const activeHeaders =
            await this.collectAllHeaders((ck) => this.network.getNotes(ck));
        if (activeHeaders === null) {
            return;
        }
        const trashedHeaders =
            await this.collectAllHeaders((ck) => this.network.getDeletedNotes(ck));
        if (trashedHeaders === null) {
            return;
        }
        const listed = activeHeaders.map((header) => ({header: header, fromTrashList: false}))
            .concat(trashedHeaders.map((header) => ({header: header, fromTrashList: true})));

        for (const {header, fromTrashList} of listed) {
            const mirrored = await this.store.getNote(header.note_id);
            if (mirrored !== undefined && headerMatchesNote(header, mirrored, fromTrashList)) {
                continue;
            }
            if (await this.store.hasQueuedCommands(header.note_id)) {
                continue;
            }
            const result = await this.network.getNote(header.note_id, null);
            if (!result.ok) {
                continue;
            }
            await this.store.putNoteFromServer(result.note);
        }

        const serverNoteIds = new Set(listed.map(({header}) => header.note_id));
        for (const mirrored of await this.store.getAllNotes()) {
            if (!serverNoteIds.has(mirrored.note_id)) {
                await this.store.deleteNoteFromServer(mirrored.note_id);
            }
        }
    }

    /** Erases the mirror and the queue. Never rejects; a failure is logged. */
    wipeLocalData() {
        return this.attemptLocalWrite(
            "could not wipe local note data",
            () => this.store.wipe()
        );
    }
}

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
     */
    getNotes(continueKey) {
        return dataSource.getNotes(continueKey);
    },

    /** Reads one page of the user's deleted (trashed) note headers. See getNotes. */
    getDeletedNotes(continueKey) {
        return dataSource.getDeletedNotes(continueKey);
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
