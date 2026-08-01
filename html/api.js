/**
 * Shared HTTP plumbing for talking to the Mini-Notes API.
 *
 * Note data is not requested through this module by UI code directly — that
 * goes through data-layer.js, which is built on top of these functions. UI
 * code calls apiFetch itself only for the commands that have no offline
 * support by design: the user, session, admin, import and export commands.
 */

/** Thrown by apiFetch when a 401 triggers logout, to abort the caller's flow. */
export class LoggedOutError extends Error {
    constructor() { super("Session expired — logged out"); }
}

/**
 * Message displayed when there's no parseable backend `error` body
 * (network failure, gateway error page, malformed response).
 */
export const FALLBACK_ERROR_MESSAGE = "Error in operation.";

/** Returns the API base URL, choosing prod or dev based on the current hostname. */
export function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === "mini-notes.com") {
        return "https://api.mini-notes.com";
    } else {
        return "https://dev-api.mini-notes.com";
    }
}

/**
 * Called when the server rejects the session, just before apiFetch throws
 * LoggedOutError. Registered by the page (see setSessionExpiredHandler); a
 * registered hook rather than a direct call is what keeps this module free of
 * any dependency on the UI.
 */
let sessionExpiredHandler = null;

/** Registers the function apiFetch calls when the server rejects the session. */
export function setSessionExpiredHandler(handler) {
    sessionExpiredHandler = handler;
}

/** Wrapper around fetch that adds credentials and handles 401 by logging out. */
export async function apiFetch(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    if (response.status === 401) {
        if (sessionExpiredHandler !== null) {
            sessionExpiredHandler();
        }
        throw new LoggedOutError();
    }
    return response;
}

/**
 * Reads the backend's user-facing error message from a non-OK response.
 * Returns the fallback string if the body can't be parsed or has no
 * `error` field.
 */
export async function extractErrorMessage(response) {
    try {
        const data = await response.json();
        if (data && typeof data.error === "string" && data.error.length > 0) {
            return data.error;
        }
    } catch (e) {
        // Body wasn't JSON — fall through to fallback.
    }
    return FALLBACK_ERROR_MESSAGE;
}
