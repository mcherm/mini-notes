/**
 * The network side of the data layer: requests to the backend's note
 * endpoints, and the builders for the result and outcome shapes documented
 * in data-layer.js. NetworkDataSource is the passthrough implementation of
 * the data-access interface; OfflineDataSource delegates its network work to
 * one.
 */

import { apiFetch, extractErrorMessage, getApiBaseUrl, LoggedOutError } from "../lib/api.js";

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
export function recordFailure(description, error) {
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
export function writeRejected(status, errorMessage, failureDetail, note) {
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
export function writeQueued(note) {
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
        const note = (parsed.data?.note) ? parsed.data.note : null;
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
    const note = (parsed.data?.note) ? parsed.data.note : null;
    return writeDelivered(note, response.status, parsed.failureDetail);
}

/** Sentinel resolved by raceAgainstTimeout when the timeout fires first. */
export const FETCH_TIMED_OUT = Symbol("fetch timed out");

/**
 * Resolves with the promise's value — or with FETCH_TIMED_OUT when the
 * promise has not settled within timeoutMs. The promise keeps running
 * either way. Its eventual settlement is always observed here, so a fetch
 * abandoned to the timeout can never surface as an unhandled rejection.
 */
export function raceAgainstTimeout(promise, timeoutMs) {
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
export class NetworkDataSource {
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
    getNote(noteId, _raceTimeoutMs) {
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
    deleteNote(noteId, _sourceVersionId) {
        return sendWriteCommand(noteUrl("/api/v1/notes/", noteId), {method: "DELETE"});
    }

    /** sourceVersionId is not sent; see deleteNote. */
    recoverNote(noteId, _sourceVersionId) {
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
        } catch (_err) {
            return false;
        }
    }

    /** There is no mirror in this mode, so there are no cached notes to read. */
    async getCachedNotes(_fromTrashList, _limit) {
        return null;
    }

    /** There is no mirror in this mode, so there is nothing to refresh. */
    async refreshMirror() {}

    /** There is no queue in this mode, so there is nothing to deliver. */
    async drainQueue(_foregroundSeq) {
        return new Map();
    }

    /** There is no queue in this mode, so background rejections cannot occur. */
    setBackgroundRejectionHandler(_handler) {}

    /** There is no queue in this mode, so background conflicts cannot occur. */
    setBackgroundConflictHandler(_handler) {}

    /** There is no sync engine in this mode, so there is nothing to wake. */
    wakeSyncEngine() {}

    /** Nothing is stored locally in this mode, so there is nothing to wipe. */
    async wipeLocalData() {}
}
