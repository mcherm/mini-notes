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

// ========== Actions ==========

async function actionSiteDataBtn() {
    const url = `${getApiBaseUrl()}/api/v1/admin/site_data`;
    const response = await apiFetch(url);
    if (!response.ok) return;
    const data = await response.json();
    const siteData = data.site_data;
    document.getElementById("user-count-display").value = siteData.user_count;
    document.getElementById("user-size-display").value = siteData.user_size;
    document.getElementById("session-count-display").value = siteData.session_count;
    document.getElementById("session-size-display").value = siteData.session_size;
    document.getElementById("note-count-display").value = siteData.note_count;
    document.getElementById("note-size-display").value = siteData.note_size;
    showShadowBox("site-data-display-dialog");
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
