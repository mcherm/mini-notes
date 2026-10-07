/**
 * Entry point for the notes page (index.html). Wires up the modules in app/
 * and lib/, and holds the page-wide behavior: startup, stale-tab detection,
 * and the periodic and connectivity-driven sync triggers.
 */

import { registerAlertListeners } from "./lib/alerts.js";
import { getApiBaseUrl, setSessionExpiredHandler } from "./lib/api.js";
import { registerDialogListeners } from "./lib/dialogs.js";
import { dataLayer } from "./data/data-layer.js";
import { registerAccountListeners, stateUpdateForLogout } from "./app/account.js";
import {
    actionBackgroundConflict,
    actionBackgroundRejection,
    loadNote,
    registerNoteEditorListeners,
    renderNote,
    saveNoteIfChanged,
} from "./app/note-editor.js";
import {
    loadNoteHeaders,
    loadTrashNoteHeaders,
    registerNoteListListeners,
} from "./app/note-list.js";
import { registerSettingsListeners } from "./app/settings.js";
import { isLoggedIn, setCurrentNote, setIntendedNoteIfUnchanged, state } from "./app/state.js";

// ========== Constants ==========

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * How often the background pass keeping the local mirror in step with the
 * server runs while the app stays open. Deliberately long: the pass only
 * catches changes made from other devices, which the app also picks up
 * when a note is opened and on the stale-tab refresh.
 */
const MIRROR_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ========== State ==========

/** When the tab was last known to be in use; see checkAndRefreshIfStale. */
let lastActiveTime = Date.now();

// ========== Stale Tab Detection ==========

/** Refreshes state after the tab has been inactive for a long time. */
async function refreshAfterStale() {
    console.log("Refreshing stale tab");
    const priorIntended = state.intendedCurrentNoteId;
    await saveNoteIfChanged();
    const selectedNoteId = state.currentNote ? state.currentNote.note_id : null;
    await (state.trashView ? loadTrashNoteHeaders(null) : loadNoteHeaders(null));
    if (selectedNoteId) {
        const stillExists = state.noteHeaders.some(h => h.note_id === selectedNoteId);
        if (stillExists) {
            if (setIntendedNoteIfUnchanged(priorIntended, selectedNoteId)) {
                await loadNote(selectedNoteId);
            }
        } else if (setIntendedNoteIfUnchanged(priorIntended, null)) {
            setCurrentNote(null);
            renderNote();
            document.getElementById("main-page").classList.remove("showing-note");
        }
    }
}

/** Checks if enough time has passed since last active and refreshes if so. */
async function checkAndRefreshIfStale() {
    if (!isLoggedIn()) return;
    const elapsed = Date.now() - lastActiveTime;
    if (elapsed > STALE_THRESHOLD_MS) {
        // Returning to the tab fires both "focus" and "visibilitychange",
        // each of which lands here. Mark the tab active (synchronously,
        // before any await) so the second event sees a fresh timestamp and
        // skips instead of launching a duplicate refresh.
        lastActiveTime = Date.now();
        await refreshAfterStale();
    }
}

function actionOnVisibilityChange() {
    if (document.visibilityState === "hidden") {
        lastActiveTime = Date.now();
    } else if (document.visibilityState === "visible") {
        checkAndRefreshIfStale();
    }
}

function actionOnWindowFocus() {
    checkAndRefreshIfStale();
}

function actionOnWindowBlur() {
    lastActiveTime = Date.now();
}

// ========== Startup and Sync ==========

/**
 * Prepares the data layer, then loads the first page of notes. Kicked off
 * (not awaited) from the DOMContentLoaded handler so that event listeners are
 * all registered before anything waits on the network.
 */
async function startUp() {
    await dataLayer.init();
    dataLayer.setBackgroundRejectionHandler(actionBackgroundRejection);
    dataLayer.setBackgroundConflictHandler(actionBackgroundConflict);
    await loadNoteHeaders(null);
    // The launch-time queue delivery and mirror refresh. The load above
    // settles the login question first: a 401 has flipped the logged-in
    // class off by now. Not awaited: neither ever rejects, and startup
    // must not wait.
    if (isLoggedIn()) {
        deliverThenRefresh();
    }
}

/**
 * The launch-time local-store housekeeping: delivers any write commands
 * queued in an earlier session, then refreshes the mirror. Delivery runs
 * first so the refresh compares the mirror against the server's state
 * with those commands applied.
 */
async function deliverThenRefresh() {
    await dataLayer.drainQueue();
    dataLayer.refreshMirror();
}

/** Runs the periodic mirror refresh, skipped when logged out or hidden. */
function actionMirrorRefreshTimer() {
    if (!isLoggedIn() || document.visibilityState === "hidden") return;
    dataLayer.refreshMirror();
}

/** Wakes the sync engine when the browser regains connectivity. */
function actionOnline() {
    dataLayer.wakeSyncEngine();
}

// ========== Initialization ==========

// Route apiFetch's handling of a rejected session into this page's logout.
setSessionExpiredHandler(stateUpdateForLogout);

/** Registers every listener on the page, then starts the app. */
function actionDOMContentLoaded() {
    registerDialogListeners();
    registerAlertListeners();
    registerAccountListeners();
    registerNoteListListeners();
    registerNoteEditorListeners();
    registerSettingsListeners();
    document.addEventListener("visibilitychange", actionOnVisibilityChange);
    window.addEventListener("focus", actionOnWindowFocus);
    window.addEventListener("blur", actionOnWindowBlur);
    window.addEventListener("online", actionOnline);
    setInterval(actionMirrorRefreshTimer, MIRROR_REFRESH_INTERVAL_MS);

    // Fix any links to work in both dev & prod environments
    document.querySelectorAll("a").forEach(a => {
        if (a.href.startsWith("https://api.mini-notes.com/")) {
            a.href = a.href.replace("https://api.mini-notes.com", getApiBaseUrl());
        }
    });

    startUp();
}

document.addEventListener("DOMContentLoaded", actionDOMContentLoaded);
