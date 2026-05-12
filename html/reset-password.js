"use strict";

// ========== Utilities ==========

function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === "mini-notes.com") {
        return "https://api.mini-notes.com";
    } else {
        return "https://dev-api.mini-notes.com";
    }
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
 * Displays a message in an inline-alert and arranges for it to clear
 * itself the next time the user types in the surrounding form. The
 * listener is attached only while a message is shown and removes itself
 * after firing once — no per-keystroke work in the common case where no
 * error is displayed.
 *
 * alertSelector: the inline-alert element to write to.
 * formSelector:  the form (or other ancestor) on which to listen for
 *                input bubbling up from any field within it.
 */
function showInlineAlert(alertSelector, formSelector, message) {
    clearInlineAlert(alertSelector);
    const alert = document.querySelector(alertSelector);
    alert.textContent = message;
    const form = document.querySelector(formSelector);
    const onInput = () => {
        alert.textContent = "";
        form.removeEventListener("input", onInput);
        _inlineAlertAutoClear.delete(alert);
    };
    form.addEventListener("input", onInput);
    _inlineAlertAutoClear.set(alert, { form, onInput });
}

/**
 * Clears an inline-alert and removes any auto-clear input listener
 * previously attached by showInlineAlert.
 */
function clearInlineAlert(alertSelector) {
    const alert = document.querySelector(alertSelector);
    const tracked = _inlineAlertAutoClear.get(alert);
    if (tracked) {
        tracked.form.removeEventListener("input", tracked.onInput);
        _inlineAlertAutoClear.delete(alert);
    }
    alert.textContent = "";
}

/** Reads user_id and token from the URL into the hidden form fields. */
function loadParamsFromUrl() {
    const params = new URLSearchParams(window.location.search);
    document.querySelector("#reset-user-id").value = params.get("user_id") || "";
    document.querySelector("#reset-token").value = params.get("token") || "";
}

// ========== Actions ==========

/**
 * Sends the password-reset change request. Redirects to the login page on
 * success; displays an error in the inline-alert on failure.
 */
async function actionResetSubmitBtn() {
    clearInlineAlert("#reset-alert");
    const userId = document.querySelector("#reset-user-id").value;
    const token = document.querySelector("#reset-token").value;
    const newPassword = document.querySelector("#new-password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/pwd_reset/change_pwd`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                user_id: userId,
                token: token,
                new_password: newPassword,
            }),
        });
    } catch (e) {
        showInlineAlert("#reset-alert", "reset-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        window.location.href = "/index.html";
        return;
    }
    showInlineAlert("#reset-alert", "reset-form", await extractErrorMessage(response));
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    loadParamsFromUrl();
    document.querySelector("#reset-submit-btn").addEventListener("click", actionResetSubmitBtn);
});
