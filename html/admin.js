"use strict";

/** Thrown by apiFetch when a 401 triggers logout, to abort the caller's flow. */
class LoggedOutError extends Error {
    constructor() { super("Session expired — logged out"); }
}

// ========== Constants ==========


// ========== Utilities ==========

function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === "mini-notes.com") {
        return "https://api.mini-notes.com";
    } else {
        return "https://dev-api.mini-notes.com";
    }
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    if (response.status === 401) {
        throw new LoggedOutError();
    }
    return response;
}

function showShadowBox(id) {
    const el = document.getElementById(id);
    el.style.display = "flex";
}

function hideShadowBox(id) {
    const el = document.getElementById(id);
    el.style.display = "none";
}

/**
 * Message displayed when there's no parseable backend `error` body
 * (network failure, gateway error page, malformed response).
 */
const FALLBACK_ERROR_MESSAGE = "Error in operation.";

/**
 * Reads the backend's user-facing error message from a non-OK response.
 * Returns the fallback string if the body can't be parsed or has no
 * `error` field.
 */
async function extractErrorMessage(response) {
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

/**
 * Tracks the auto-clear input listener (if any) attached to each
 * inline-alert by showInlineAlert. Keyed by the alert element so we can
 * detach the listener again from clearInlineAlert.
 */
const _inlineAlertAutoClear = new Map();

/**
 * Displays a message in an inline-alert. If formSelector is provided,
 * attaches a one-shot input listener so the message clears the next
 * time the user types in that form; pass null to skip the auto-clear
 * mechanic (appropriate for non-form contexts like dialog bodies).
 */
function showInlineAlert(alertSelector, formSelector, message) {
    clearInlineAlert(alertSelector);
    const alert = document.querySelector(alertSelector);
    alert.textContent = message;
    if (formSelector) {
        const form = document.querySelector(formSelector);
        const onInput = () => {
            alert.textContent = "";
            form.removeEventListener("input", onInput);
            _inlineAlertAutoClear.delete(alert);
        };
        form.addEventListener("input", onInput);
        _inlineAlertAutoClear.set(alert, { form, onInput });
    }
}

/** Clears an inline-alert and any auto-clear listener. */
function clearInlineAlert(alertSelector) {
    const alert = document.querySelector(alertSelector);
    const tracked = _inlineAlertAutoClear.get(alert);
    if (tracked) {
        tracked.form.removeEventListener("input", tracked.onInput);
        _inlineAlertAutoClear.delete(alert);
    }
    alert.textContent = "";
}

// ========== Actions ==========

/** IDs of the inputs populated by the site-data load (cleared on entry, set on success). */
const SITE_DATA_FIELD_IDS = [
    "user-count-display",
    "user-size-display",
    "session-count-display",
    "session-size-display",
    "note-count-display",
    "note-size-display",
];

async function actionSiteDataBtn() {
    clearInlineAlert("#site-data-alert");
    SITE_DATA_FIELD_IDS.forEach((id) => {
        document.getElementById(id).value = "";
    });
    showShadowBox("site-data-display-dialog");
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/admin/site_data`);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showInlineAlert("#site-data-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        showInlineAlert("#site-data-alert", null, await extractErrorMessage(response));
        return;
    }
    const data = await response.json();
    const siteData = data.site_data;
    document.getElementById("user-count-display").value = siteData.user_count;
    document.getElementById("user-size-display").value = siteData.user_size;
    document.getElementById("session-count-display").value = siteData.session_count;
    document.getElementById("session-size-display").value = siteData.session_size;
    document.getElementById("note-count-display").value = siteData.note_count;
    document.getElementById("note-size-display").value = siteData.note_size;
}

function actionCloseSiteDataShadowboxBtn() {
    hideShadowBox("site-data-display-dialog");
}

function actionDismissShadowBox(event) {
    if (event.target === event.currentTarget) {
        hideShadowBox(event.currentTarget.id);
    }
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#site-data-btn").addEventListener("click", actionSiteDataBtn);
    document.querySelector("#close-site-data-shadowbox-btn").addEventListener("click", actionCloseSiteDataShadowboxBtn);
    document.querySelectorAll("shadow-box").forEach(sb => {
        sb.addEventListener("click", actionDismissShadowBox);
    });
});
