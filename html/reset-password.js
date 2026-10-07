/**
 * Entry point for the password-reset page (reset-password.html), reached
 * from the link in a password-reset email.
 */

import { clearInlineAlert, showInlineAlert } from "./lib/alerts.js";
import { extractErrorMessage, FALLBACK_ERROR_MESSAGE, getApiBaseUrl } from "./lib/api.js";
import { registerDialogListeners } from "./lib/dialogs.js";

// ========== Utilities ==========

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
    } catch (_err) {
        showInlineAlert("#reset-alert", "form.reset-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        window.location.href = "/index.html";
        return;
    }
    showInlineAlert("#reset-alert", "form.reset-form", await extractErrorMessage(response));
}

// ========== Initialization ==========

/** Fills in the form from the URL and registers every listener on the page. */
function actionDOMContentLoaded() {
    loadParamsFromUrl();
    registerDialogListeners();
    document.querySelector("#reset-submit-btn").addEventListener("click", actionResetSubmitBtn);
}

document.addEventListener("DOMContentLoaded", actionDOMContentLoaded);
