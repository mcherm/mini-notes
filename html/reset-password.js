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

/** Reads user_id and token from the URL into the hidden form fields. */
function loadParamsFromUrl() {
    const params = new URLSearchParams(window.location.search);
    document.querySelector("#reset-user-id").value = params.get("user_id") || "";
    document.querySelector("#reset-token").value = params.get("token") || "";
}

/** Displays an error message inside the reset-error element. */
function showResetError(message) {
    document.querySelector("#reset-error").textContent = message;
}

// ========== Actions ==========

/** Sends the password-reset change request. Redirects to the login page on
 * success; displays an error inline on failure. */
async function actionResetSubmitBtn() {
    showResetError("");
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
        showResetError("Network error. Please try again.");
        return;
    }
    if (response.ok) {
        window.location.href = "/index.html";
        return;
    }
    let errorMessage;
    try {
        const data = await response.json();
        if (data.error) {
            errorMessage = data.error;
        }
    } catch (e) {
        // Body wasn't JSON — fall back to the default message.
        errorMessage = "Failed to reset password.";
    }
    showResetError(errorMessage);
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    loadParamsFromUrl();
    document.querySelector("#reset-submit-btn").addEventListener("click", actionResetSubmitBtn);
});
