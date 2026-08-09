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

    /** There is no mirror in this mode, so there is nothing to refresh. */
    async refreshMirror() {}

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
 * The implementation used when a working IndexedDB is available. Every call
 * is served by the network — it holds a NetworkDataSource and delegates to
 * it — and a successful response is then written through to the local
 * mirror, keeping the mirror an accurate copy of what the server holds.
 * When the server is unreachable, the offline-capable reads are served from
 * the mirror instead (docs/pwa_design.md → "The Read Path"). All mirror
 * updates go through NoteStore's read-barrier-guarded operations, and a
 * local-store failure never changes a call's result: the network's answer
 * stands.
 */
export class OfflineDataSource {
    constructor(store, network) {
        this.store = store;
        this.network = network;
        this.refreshInProgress = false;
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
