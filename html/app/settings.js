/**
 * The settings dialog: navigation between its sections, and importing notes.
 */

import {
    clearInlineAlert,
    clearProgressBox,
    completeProgressBox,
    showInlineAlert,
    showProgressBox,
} from "../lib/alerts.js";
import {
    apiFetch,
    extractErrorMessage,
    FALLBACK_ERROR_MESSAGE,
    getApiBaseUrl,
    LoggedOutError,
} from "../lib/api.js";
import { hideShadowBox, showShadowBox } from "../lib/dialogs.js";
import { loadNoteHeaders } from "./note-list.js";

/** Selects a settings nav item and shows its corresponding settings-text. */
function selectSettingsNavItem(navItem) {
    const currentActive = document.querySelector("settings-nav-item.active");
    if (currentActive) currentActive.classList.remove("active");
    navItem.classList.add("active");

    const currentText = document.querySelector("settings-text.active");
    if (currentText) currentText.classList.remove("active");
    const targetId = navItem.dataset.target;
    const targetText = document.getElementById(targetId);
    if (targetText) targetText.classList.add("active");
}

/** Imports notes from the selected file by POSTing its raw bytes to the API. */
async function importNotes(file) {
    clearInlineAlert("#import-alert");
    showProgressBox("#import-progress", "Importing...");
    let response;
    try {
        const bytes = await file.arrayBuffer();
        const url = `${getApiBaseUrl()}/api/v1/note_import?filename=${encodeURIComponent(file.name)}`;
        response = await apiFetch(url, {
            method: "POST",
            body: bytes,
        });
    } catch (e) {
        clearProgressBox("#import-progress");
        if (e instanceof LoggedOutError) {
            // apiFetch already handled the 401 and triggered logout.
            return;
        }
        showInlineAlert("#import-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        clearProgressBox("#import-progress");
        showInlineAlert("#import-alert", null, await extractErrorMessage(response));
        return;
    }
    const data = await response.json();
    completeProgressBox("#import-progress", `Done: ${data.notes_created} created, ${data.notes_updated} updated.`);
    await loadNoteHeaders(null);
}

/** Handles a settings button click by showing the app-settings shadow box.
 * Clears any progress-box content inside the settings panel so stale
 * "Done…" messages from a previous visit don't reappear on a fresh open. */
function actionSettingsBtn() {
    document.querySelectorAll("app-settings progress-box").forEach(clearProgressBox);
    showShadowBox("app-settings-dialog");
}

/** Handles the close button click in the settings shadow box by dismissing it. */
function actionCloseSettingsBtn() {
    hideShadowBox("app-settings-dialog");
}

/** Handles a click on the settings nav list by selecting the clicked item. */
function actionSettingsNavClick(event) {
    const navItem = event.target.closest("settings-nav-item");
    if (!navItem) return;
    selectSettingsNavItem(navItem);
}

/** Shows the import button when a file is selected; clears any prior status. */
function actionImportFileChange(event) {
    document.querySelector("import-actions").classList.toggle("visible", event.target.files.length > 0);
    clearProgressBox("#import-progress");
    clearInlineAlert("#import-alert");
}

/** Imports notes from the file currently selected in the file input. */
async function actionImportNotesBtn() {
    const file = document.querySelector("#import-notes-file").files[0];
    if (file) await importNotes(file);
}

/** Registers the settings dialog's listeners. */
export function registerSettingsListeners() {
    document.querySelectorAll(".settings-btn").forEach(btn => {
        btn.addEventListener("click", actionSettingsBtn);
    });
    document.querySelector("#close-settings-btn").addEventListener("click", actionCloseSettingsBtn);
    document.querySelector("settings-nav-list").addEventListener("click", actionSettingsNavClick);
    document.querySelector("#import-notes-file").addEventListener("change", actionImportFileChange);
    document.querySelector("#import-notes-btn").addEventListener("click", actionImportNotesBtn);
}
