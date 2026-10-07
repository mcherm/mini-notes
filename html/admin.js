/**
 * Entry point for the admin page (admin.html): an online-only operational
 * tool showing site-wide data.
 */

import { clearInlineAlert, showInlineAlert } from "./lib/alerts.js";
import {
    apiFetch,
    extractErrorMessage,
    FALLBACK_ERROR_MESSAGE,
    getApiBaseUrl,
    LoggedOutError,
} from "./lib/api.js";
import { hideShadowBox, registerDialogListeners, showShadowBox } from "./lib/dialogs.js";

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

/** Appends one row to the users-detail table from a FullUserInfo record.
 * Cells are set via textContent (never innerHTML) since email is user-supplied. */
function appendUserDetailRow(tbody, fullUserInfo) {
    const user = fullUserInfo.user;
    const detail = fullUserInfo.user_detail;
    const cells = [
        user.email,
        user.user_type,
        detail.notes,
        detail.notes_in_trash,
        detail.invalid_notes,
        detail.most_recent_edit ? detail.most_recent_edit.substring(0, 10) : "no notes",
        detail.busiest_note ?? "no notes",
        user.create_time.substring(0, 10),
        user.user_id,
    ];
    const row = document.createElement("tr");
    for (const value of cells) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
    }
    tbody.appendChild(row);
}

async function actionUsersDetailBtn() {
    clearInlineAlert("#users-detail-alert");
    const tbody = document.getElementById("users-detail-tbody");
    tbody.replaceChildren();
    document.getElementById("orphan-note-count-display").value = "";
    document.getElementById("invalid-user-count-display").value = "";
    showShadowBox("users-detail-display-dialog");
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/admin/users_detail`);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showInlineAlert("#users-detail-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        showInlineAlert("#users-detail-alert", null, await extractErrorMessage(response));
        return;
    }
    const data = await response.json();
    for (const fullUserInfo of data.users) {
        appendUserDetailRow(tbody, fullUserInfo);
    }
    document.getElementById("orphan-note-count-display").value = data.orphan_note_count;
    document.getElementById("invalid-user-count-display").value = data.invalid_user_count;
}

function actionCloseUsersDetailShadowboxBtn() {
    hideShadowBox("users-detail-display-dialog");
}

// ========== Initialization ==========

/** Registers every listener on the page. */
function actionDOMContentLoaded() {
    registerDialogListeners();
    document.querySelector("#site-data-btn").addEventListener("click", actionSiteDataBtn);
    document.querySelector("#close-site-data-shadowbox-btn").addEventListener("click", actionCloseSiteDataShadowboxBtn);
    document.querySelector("#users-detail-btn").addEventListener("click", actionUsersDetailBtn);
    document.querySelector("#close-users-detail-shadowbox-btn").addEventListener("click", actionCloseUsersDetailShadowboxBtn);
}

document.addEventListener("DOMContentLoaded", actionDOMContentLoaded);
