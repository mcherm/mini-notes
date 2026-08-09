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
 * `{ok: false, errorMessage, failureDetail}` on failure.
 *
 * Write methods resolve to an outcome object `{outcome, note, status,
 * errorMessage, failureDetail}`, where outcome is one of:
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
import { openNoteStore } from "./store.js";

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
function readFailure(errorMessage, failureDetail) {
    return {ok: false, errorMessage: errorMessage, failureDetail: failureDetail};
}

/** Builds the delivered form of a write outcome. */
function writeDelivered(note, status, failureDetail) {
    return {
        outcome: "delivered",
        note: note,
        status: status,
        errorMessage: null,
        failureDetail: failureDetail,
    };
}

/** Builds the rejected form of a write outcome. */
function writeRejected(status, errorMessage, failureDetail) {
    return {
        outcome: "rejected",
        note: null,
        status: status,
        errorMessage: errorMessage,
        failureDetail: failureDetail,
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
        return readFailure(null, recordFailure(`request to ${url} did not complete`, e));
    }
    if (!response.ok) {
        return readFailure(await extractErrorMessage(response), `HTTP ${response.status} from ${url}`);
    }
    const parsed = await readJson(response, url);
    if (parsed.failureDetail !== null) {
        return readFailure(null, parsed.failureDetail);
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
        return readFailure(null, recordFailure(`request to ${url} did not complete`, e));
    }
    if (!response.ok) {
        return readFailure(await extractErrorMessage(response), `HTTP ${response.status} from ${url}`);
    }
    const parsed = await readJson(response, url);
    if (parsed.failureDetail !== null) {
        return readFailure(null, parsed.failureDetail);
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
        return writeRejected(null, null, recordFailure(`request to ${url} did not complete`, e));
    }
    if (!response.ok) {
        return writeRejected(
            response.status,
            await extractErrorMessage(response),
            `HTTP ${response.status} from ${url}`);
    }
    if (response.status === 204) {
        // No content by definition; the command carries no note back.
        return writeDelivered(null, response.status, null);
    }
    const parsed = await readJson(response, url);
    const note = (parsed.data !== null && parsed.data.note) ? parsed.data.note : null;
    return writeDelivered(note, response.status, parsed.failureDetail);
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

    getNote(noteId) {
        return fetchNote(noteUrl("/api/v1/notes/", noteId));
    }

    newNote({title, body, format}) {
        return sendWriteCommand(
            `${getApiBaseUrl()}/api/v1/notes`,
            jsonRequest("POST", {title: title, body: body, format: format}));
    }

    editNote({noteId, title, body, sourceVersionId}) {
        return sendWriteCommand(
            noteUrl("/api/v1/notes/", noteId),
            jsonRequest("PUT", {title: title, body: body, source_version_id: sourceVersionId}));
    }

    deleteNote(noteId) {
        return sendWriteCommand(noteUrl("/api/v1/notes/", noteId), {method: "DELETE"});
    }

    recoverNote(noteId) {
        return sendWriteCommand(noteUrl("/api/v1/recover_note/", noteId), {method: "POST"});
    }

    destroyNote(noteId) {
        return sendWriteCommand(noteUrl("/api/v1/deleted_notes/", noteId), {method: "DELETE"});
    }

    /** Nothing is stored locally in this mode, so there is nothing to wipe. */
    async wipeLocalData() {}
}

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
 * The implementation used when a working IndexedDB is available. Every call
 * is served by the network — it holds a NetworkDataSource and delegates to
 * it — and a successful response is then written through to the local
 * mirror, keeping the mirror an accurate copy of what the server holds. All
 * mirror updates go through NoteStore's read-barrier-guarded operations, and
 * a local-store failure never changes a call's result: the network's answer
 * stands.
 */
export class OfflineDataSource {
    constructor(store, network) {
        this.store = store;
        this.network = network;
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
     * Write-through shared by the commands whose delivery returns the
     * updated note: the returned note replaces the mirrored copy. An outcome
     * without a note (a rejected command, or a delivered response whose body
     * was unreadable) leaves the mirror alone.
     */
    async mirrorWriteOutcome(outcome) {
        if (outcome.outcome === "delivered" && outcome.note !== null) {
            await this.attemptLocalWrite(
                "could not mirror the note returned by a write",
                () => this.store.putNoteFromServer(outcome.note)
            );
        }
        return outcome;
    }

    async getNotes(continueKey) {
        const result = await this.network.getNotes(continueKey);
        if (result.ok) {
            await this.attemptLocalWrite(
                "could not reconcile the mirror against active note headers",
                () => this.reconcileHeaders(result.noteHeaders, false)
            );
        }
        return result;
    }

    async getDeletedNotes(continueKey) {
        const result = await this.network.getDeletedNotes(continueKey);
        if (result.ok) {
            await this.attemptLocalWrite(
                "could not reconcile the mirror against trash note headers",
                () => this.reconcileHeaders(result.noteHeaders, true)
            );
        }
        return result;
    }

    /** Served by the network; search pages are not used to maintain the mirror. */
    searchNotes(searchString, continueKey) {
        return this.network.searchNotes(searchString, continueKey);
    }

    async getNote(noteId) {
        const result = await this.network.getNote(noteId);
        if (result.ok) {
            await this.attemptLocalWrite(
                "could not mirror a fetched note",
                () => this.store.putNoteFromServer(result.note)
            );
        }
        return result;
    }

    async newNote({title, body, format}) {
        return this.mirrorWriteOutcome(
            await this.network.newNote({title: title, body: body, format: format})
        );
    }

    async editNote({noteId, title, body, sourceVersionId}) {
        return this.mirrorWriteOutcome(
            await this.network.editNote({
                noteId: noteId,
                title: title,
                body: body,
                sourceVersionId: sourceVersionId,
            })
        );
    }

    async deleteNote(noteId) {
        return this.mirrorWriteOutcome(await this.network.deleteNote(noteId));
    }

    async recoverNote(noteId) {
        return this.mirrorWriteOutcome(await this.network.recoverNote(noteId));
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
     * whenever a working IndexedDB is present, proven by opening it and
     * performing a trivial write rather than by asking about API support;
     * otherwise the session runs online-only. The choice is not revisited
     * until the next launch.
     */
    async init() {
        const network = new NetworkDataSource();
        try {
            const store = await openNoteStore();
            dataSource = new OfflineDataSource(store, network);
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
     */
    getNote(noteId) {
        return dataSource.getNote(noteId);
    },

    /** Creates a note. Resolves to a write outcome (see the file header). */
    newNote({title, body, format}) {
        return dataSource.newNote({title: title, body: body, format: format});
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

    /** Moves a note to the trash. Resolves to a write outcome. */
    deleteNote(noteId) {
        return dataSource.deleteNote(noteId);
    },

    /** Restores a note from the trash. Resolves to a write outcome. */
    recoverNote(noteId) {
        return dataSource.recoverNote(noteId);
    },

    /** Permanently destroys a trashed note. Resolves to a write outcome. */
    destroyNote(noteId) {
        return dataSource.destroyNote(noteId);
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
