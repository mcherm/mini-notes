"use strict";

// ========== Configuration ==========

/** Returns the API base URL, choosing prod or dev based on the current hostname. */
function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === "mini-notes.com") {
        return "https://api.mini-notes.com";
    } else {
        return "https://dev-api.mini-notes.com";
    }
}

// ========== API Calls ==========

/** Sends login request to the API with the entered email and password. */
async function login() {
    const email = document.querySelector("#email-entry").value;
    const password = document.querySelector("#password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/user_login`;
    const response = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email, password: password}),
        credentials: "include",
    });
    const data = await response.json();
    console.log("Login response:", JSON.stringify(data, null, 2));
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#login-btn").addEventListener("click", login);
});
