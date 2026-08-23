import {
    apiFetch,
    extractErrorMessage,
    FALLBACK_ERROR_MESSAGE,
    getApiBaseUrl,
    LoggedOutError,
    setSessionExpiredHandler,
} from "./api.js";
import { CONFLICT_TITLE_PREFIX } from "./commands.js";
import { byModifyTimeNewestFirst, dataLayer } from "./data-layer.js";
import { applyNoteDiff } from "./diff.js";

// ========== Constants ==========

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STALE_UNFOCUSED_EDIT_MS = 60 * 1000; // 1 minute
/**
 * How long a note fetch may run before the locally mirrored copy (if any)
 * is served instead. Tuned to usually leave the server enough time to
 * answer — including a cold start — without making a user on a hanging
 * connection wait long enough to feel stuck.
 */
const NOTE_FETCH_TIMEOUT_MS = 3 * 1000;
/**
 * How often the background pass keeping the local mirror in step with the
 * server runs while the app stays open. Deliberately long: the pass only
 * catches changes made from other devices, which the app also picks up
 * when a note is opened and on the stale-tab refresh.
 */
const MIRROR_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ========== State ==========

let noteHeaders = [];
let currentNote = null;
let redo_stack = [];
let intendedCurrentNoteId = null;
let continuationKey = null;
let isLoadingNotes = false;
let searchDebounceTimer = null;
let lastActiveTime = Date.now();
let autoTitleActive = false;
let unfocusedEditsPending = false;
let unfocusedEditDebounceTimer = null;
/** Promise for the save currently in flight, or null when none is. */
let saveInFlight = null;
/** Boolean, where true means we are viewing the trash rather than normal notes. */
let trashView = false;
/** Queue of alerts; first one is visible */
const floatingAlertMessages = [];

/** Returns true if the user is currently logged in. */
function isLoggedIn() {
    return document.body.classList.contains("logged-in");
}

/** Sets the logged-in state by toggling the body class. */
function setLoggedIn(value) {
    document.body.classList.toggle("logged-in", value);
}

// ========== Shadow Box ==========

const shadowBoxDismissCallbacks = new Map();

/** Shows a shadow-box modal by id. onDismiss is called when the box is dismissed. */
function showShadowBox(id, onDismiss) {
    const el = document.getElementById(id);
    el.style.display = "flex";
    if (onDismiss) {
        shadowBoxDismissCallbacks.set(id, onDismiss);
    }
}

/** Hides a shadow-box modal by id, invoking its dismiss callback if one was registered. */
function hideShadowBox(id) {
    const el = document.getElementById(id);
    el.style.display = "none";
    const callback = shadowBoxDismissCallbacks.get(id);
    if (callback) {
        shadowBoxDismissCallbacks.delete(id);
        callback();
    }
}

// ========== DOM Helpers ==========

/** Creates a <note-slug> element from a NoteHeader object. */
function createNoteSlug(noteHeader, isActive) {
    const slug = document.createElement("note-slug");
    slug.textContent = noteHeader.title;
    slug.dataset.noteId = noteHeader.note_id;
    if (isActive) {
        slug.className = "active";
    }
    return slug;
}

/**
 * Returns true if the given noteSlug currently matches the given noteHeader.
 * This is used to avoid deleting and re-creating things that are already correct.
 */
function noteHeaderMatchesSlug(noteHeader, noteSlug) {
    return noteSlug.textContent === noteHeader.title;
}

// ========== State Changes ==========

/**
 * Sets the current note to be displayed (set to null to display no note). Does
 * not automatically render it, you have to call renderNote() separately. DOES
 * set the redo_stack to [] every time.
 */
function setCurrentNote(note) {
    currentNote = note;
    redo_stack = [];
}

/**
 * Sets which note the UI intends to display. Call this synchronously in
 * response to a user action (before any await). Never call this after an
 * await without using setIntendedNoteIfUnchanged() instead.
 */
function setIntendedNote(noteId) {
    intendedCurrentNoteId = noteId;
}

/**
 * Sets the intended note only if no other action has changed it since the
 * caller last checked. Use this after an await to avoid clobbering a user
 * action that occurred during the async gap. Returns true if the value was
 * set, false if it was stale (meaning the caller should stop updating the UI).
 */
function setIntendedNoteIfUnchanged(expectedValue, newNoteId) {
    if (intendedCurrentNoteId !== expectedValue) return false;
    intendedCurrentNoteId = newNoteId;
    return true;
}

/** If unfocused edits are pending, save immediately and clear the timer. */
function saveUnfocusedEditsIfPending() {
    if (!unfocusedEditsPending) return;
    unfocusedEditsPending = false;
    clearTimeout(unfocusedEditDebounceTimer);
    unfocusedEditDebounceTimer = null;
    saveNoteIfChanged();
}

/** Starts or restarts the debounce timer for saving unfocused edits. */
function restartUnfocusedEditTimer() {
    clearTimeout(unfocusedEditDebounceTimer);
    unfocusedEditDebounceTimer = setTimeout(() => {
        unfocusedEditDebounceTimer = null;
        if (unfocusedEditsPending) {
            unfocusedEditsPending = false;
            saveNoteIfChanged();
        }
    }, STALE_UNFOCUSED_EDIT_MS);
}

/** Call this when the state of the application should change to "not logged in". */
function stateUpdateForLogout() {
    setLoggedIn(false);
    noteHeaders = [];
    setCurrentNote(null);
    setIntendedNote(null);
    continuationKey = null;
    isLoadingNotes = false;
    searchDebounceTimer = null;
    unfocusedEditsPending = false;
    clearTimeout(unfocusedEditDebounceTimer);
    unfocusedEditDebounceTimer = null;
    trashView = false;
    const mainPage = document.getElementById("main-page");
    mainPage.classList.remove("showing-note");
    mainPage.classList.remove("trash-view");
    document.querySelector("article input.title").removeAttribute("readonly");
    document.querySelector("article textarea.note-body").removeAttribute("readonly");
    renderNote();
    document.querySelector("input.search").value = "";
    clearInlineAlert("#note-list-alert");
    clearInlineAlert("#note-pane-alert");
    clearAllFloatingAlerts();
    // Local note data never outlives the session (see docs/pwa_design.md).
    dataLayer.wipeLocalData();
}

/**
 * Call this when the state of the application should change to "logged in". Be sure
 * that the cookie is also being set or it won't work.
 */
async function stateUpdateForLogin() {
    setLoggedIn(true);
    document.querySelector("#email-entry").value = "";
    document.querySelector("#password-entry").value = "";
    await loadNoteHeaders(null);
    // A fresh login starts with an empty mirror (logout wiped it); this
    // populates it. Not awaited: it never rejects, and login must not wait.
    dataLayer.refreshMirror();
}

/** Enters trash view: shows deleted notes in read-only mode. */
async function enterTrashView() {
    saveUnfocusedEditsIfPending();
    trashView = true;
    const mainPage = document.getElementById("main-page");
    mainPage.classList.add("trash-view");
    mainPage.classList.remove("showing-note");
    document.querySelector("input.search").value = "";
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    document.querySelector("article input.title").setAttribute("readonly", "");
    document.querySelector("article textarea.note-body").setAttribute("readonly", "");
    await loadTrashNoteHeaders(null);
}

/** Exits trash view: returns to normal notes mode. */
async function exitTrashView() {
    trashView = false;
    const mainPage = document.getElementById("main-page");
    mainPage.classList.remove("trash-view");
    mainPage.classList.remove("showing-note");
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    document.querySelector("article input.title").removeAttribute("readonly");
    document.querySelector("article textarea.note-body").removeAttribute("readonly");
    await loadNoteHeaders(null);
}

// ========== Rendering ==========

/** Clears the <note-list> element and repopulates it from the noteHeaders array. */
function renderNoteList() {
    const noteList = document.querySelector("note-list");
    noteList.innerHTML = "";
    noteHeaders.forEach((header) => {
        const isActive = currentNote !== null && header.note_id === currentNote.note_id;
        noteList.appendChild(createNoteSlug(header, isActive));
    });
    if (noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = trashView ? "No deleted notes." : "No notes yet. Click \"New\" to create one.";
        noteList.appendChild(emptyMessage);
    } else {
        const emptyMessage = noteList.querySelector("note-list-empty");
        if (emptyMessage) emptyMessage.remove();
    }
    setupScrollObserver();
}

/**
 * Wipes the note-list contents without rendering the empty-list message.
 * Used by the load functions when a refresh fails: leaving the previous
 * (now stale) items in place would be misleading, but the empty-list
 * message ("No notes yet.") is wrong too — it implies a successful zero
 * result. The accompanying inline-alert carries the real status.
 *
 * Re-runs setupScrollObserver so the sentinel exists for future loads.
 */
function clearNoteListForError() {
    noteHeaders = [];
    const noteList = document.querySelector("note-list");
    noteList.innerHTML = "";
    setupScrollObserver();
}

/** Updates the can-undo/can-redo classes on #note based on current stack state. */
function updateUndoRedoButtons() {
    const noteElem = document.getElementById("note");
    const canUndo = !!(currentNote && currentNote.undo_stack && currentNote.undo_stack.length > 0);
    const canRedo = !!(currentNote && redo_stack.length > 0);
    noteElem.classList.toggle("can-undo", canUndo);
    noteElem.classList.toggle("can-redo", canRedo);
}

/** Populates the article area with the current note's title and body. */
function renderNote() {
    unfocusedEditsPending = false;
    clearTimeout(unfocusedEditDebounceTimer);
    unfocusedEditDebounceTimer = null;
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    updateUndoRedoButtons();
    if (currentNote) {
        titleInput.value = currentNote.title;
        bodyTextarea.value = currentNote.body;
    } else {
        titleInput.value = "";
        bodyTextarea.value = "";
    }
}

/** Appends new <note-slug> elements to <note-list>, inserted before the sentinel. */
function appendNoteHeaders(newHeaders) {
    const noteList = document.querySelector("note-list");
    const sentinel = noteList.querySelector("note-list-sentinel");
    newHeaders.forEach((header) => {
        const isActive = currentNote !== null && header.note_id === currentNote.note_id;
        noteList.insertBefore(createNoteSlug(header, isActive), sentinel);
        const emptyMessage = noteList.querySelector("note-list-empty");
        if (emptyMessage) emptyMessage.remove();
    });
}

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

// ========== Scroll Observer ==========

let scrollObserver = null;

/** Creates a sentinel element and IntersectionObserver for infinite scroll. */
function setupScrollObserver() {
    const noteList = document.querySelector("note-list");
    const sentinel = document.createElement("note-list-sentinel");
    noteList.appendChild(sentinel);

    scrollObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && continuationKey !== null && !isLoadingNotes) {
            if (trashView) {
                loadTrashNoteHeaders(continuationKey);
            } else {
                loadNoteHeaders(continuationKey);
            }
        }
    }, {
        root: noteList,
        rootMargin: "0px 0px 200px 0px"
    });
    scrollObserver.observe(sentinel);
}

/** Re-observe the sentinel to force a fresh intersection check. */
function reobserveSentinel() {
    if (!scrollObserver) return;
    const sentinel = document.querySelector("note-list-sentinel");
    if (!sentinel) return;
    scrollObserver.unobserve(sentinel);
    scrollObserver.observe(sentinel);
}

/** Shows or hides the sentinel based on whether more pages are available. */
function updateSentinel() {
    const sentinel = document.querySelector("note-list-sentinel");
    if (!sentinel) return;
    if (continuationKey !== null) {
        sentinel.textContent = "Loading...";
        sentinel.style.display = "";
    } else {
        sentinel.textContent = "";
        sentinel.style.display = "none";
    }
}

// ========== Note State Helpers ==========

/**
 * Updates currentNote, noteHeaders, and the DOM after receiving a note
 * from the API. This is a no-op if the note doesn't match
 * intendedCurrentNoteId — meaning the user has navigated away and this
 * data is stale. Safe to call from async completion handlers without
 * external guards.
 */
function applyNoteToUI(note) {
    if (note.note_id !== intendedCurrentNoteId) return;
    setCurrentNote(note);
    renderNote(note);

    const newHeader = {
        user_id: note.user_id,
        note_id: note.note_id,
        version_id: note.version_id,
        title: note.title,
        modify_time: note.modify_time,
        format: note.format,
    };

    // --- Update noteHeaders ---
    const oldIndex = noteHeaders.findIndex(h => h.note_id === note.note_id);
    if (oldIndex !== -1) {
        noteHeaders.splice(oldIndex, 1);
    }
    noteHeaders.unshift(newHeader);

    // --- Update displayed noteList ---
    const noteList = document.querySelector("note-list");
    const activeSlug = noteList.querySelector("note-slug.active");
    if (activeSlug) activeSlug.classList.remove("active");
    let needNewSlug = true; // we may disprove this
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${note.note_id}"]`);
    if (oldSlug) {
        const isFirstInList = oldSlug.previousElementSibling === null;
        const isActive = oldSlug.classList.contains("active");
        const isCorrect = noteHeaderMatchesSlug(newHeader, oldSlug);
        if (isFirstInList && isActive && isCorrect) {
            needNewSlug = false;
        } else {
            oldSlug.remove();
        }
    }
    if (needNewSlug) {
        const newSlug = createNoteSlug(newHeader, true);
        noteList.insertBefore(newSlug, noteList.firstChild);
    }
    const emptyMessage = noteList.querySelector("note-list-empty");
    if (emptyMessage) emptyMessage.remove();

    renderNoteList();
}

// ========== API Calls ==========
//
// Note data is read and written through dataLayer (see data-layer.js). The
// calls below are the ones with no offline support by design — user, session,
// import and export — and they talk to the server directly.

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
 * alertSelector: the inline-alert element to write to. Eg. "#login-alert"
 * formSelector:  the form (or other ancestor) on which to listen for
 *                input bubbling up from any field within it.
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

/**
 * Updates the <floating-alert>'s text from the message queue. The
 * structural children (top row, dots, close button, message) live
 * statically in the HTML; this only writes textContent. When the queue
 * is empty the message is cleared, and the CSS `:has(message:empty)`
 * rule hides the alert.
 */
function renderFloatingAlert() {
    const dots = document.querySelector("floating-alert-dots");
    const message = document.querySelector("floating-alert-message");
    if (floatingAlertMessages.length === 0) {
        dots.textContent = "";
        message.textContent = "";
        return;
    }
    // One dot per additional queued message (i.e. one fewer than the queue length).
    dots.textContent = "⚫ ".repeat(floatingAlertMessages.length - 1);
    message.textContent = floatingAlertMessages[0];
}

/** Adds a message to the floating-alert queue and re-renders. */
function showFloatingAlert(message) {
    floatingAlertMessages.push(message);
    renderFloatingAlert();
}

/** Removes the first queued message (called from the close button). */
function dismissFloatingAlert() {
    floatingAlertMessages.shift();
    renderFloatingAlert();
}

/** Empties the floating-alert queue. Used on logout / full UI refresh. */
function clearAllFloatingAlerts() {
    floatingAlertMessages.length = 0;
    renderFloatingAlert();
}

/**
 * Displays a progress message in a progress-box (default state — hourglass icon).
 * Removes any prior .complete state. Accepts either a CSS selector or the
 * progress-box element directly (useful for bulk operations).
 */
function showProgressBox(box, message) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.remove("complete");
    el.textContent = message;
}

/**
 * Marks a progress-box as complete: replaces the hourglass icon with a
 * checkmark and updates the text to the completion message. Accepts either
 * a CSS selector or the progress-box element directly.
 */
function completeProgressBox(box, message) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.add("complete");
    el.textContent = message;
}

/** Clears a progress-box and removes any state class. Accepts either a
 * CSS selector or the progress-box element directly. */
function clearProgressBox(box) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.remove("complete");
    el.textContent = "";
}

/** Logs out by calling the server to clear the cookie, then updates UI. */
async function logout() {
    try {
        await apiFetch(`${getApiBaseUrl()}/api/v1/user_logout`, { method: "POST" });
    } catch (e) {
        // Ignore errors — logout should always proceed client-side
    }
    stateUpdateForLogout();
}

/**
 * Sends login request to the API with the entered email and password.
 * Bypasses apiFetch because a 401 here means "wrong credentials", not
 * "session expired" — the login form should display the error in place
 * rather than route through the logout flow.
 */
async function login() {
    const email = document.querySelector("#email-entry").value;
    const password = document.querySelector("#password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/user_login`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({email: email, password: password}),
        });
    } catch (e) {
        showInlineAlert("#login-alert", "login-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        await stateUpdateForLogin();
        return;
    }
    showInlineAlert("#login-alert", "login-form", await extractErrorMessage(response));
}

/** Sends new account request to the API. Same 401 reasoning as login(). */
async function createUser() {
    const email = document.querySelector("#email-entry").value;
    const password = document.querySelector("#password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/user_create`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({email: email, password: password}),
        });
    } catch (e) {
        showInlineAlert("#login-alert", "login-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        await stateUpdateForLogin();
        return;
    }
    showInlineAlert("#login-alert", "login-form", await extractErrorMessage(response));
}

/** Sends user edit request to the API to update email and/or password. */
async function editUser() {
    const password = document.querySelector("#user-edit-password").value;
    const newEmail = document.querySelector("#user-edit-new-email").value;
    const newPassword = document.querySelector("#user-edit-new-password").value;
    const body = {password: password};
    if (newEmail) {
        body.new_email = newEmail;
    }
    if (newPassword) {
        body.new_password = newPassword;
    }
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/user`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        });
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert("Failed to update user.");
        return;
    }
    if (!response.ok) {
        showFloatingAlert(await extractErrorMessage(response));
    }
}

/**
 * Requests a password-reset email for the address in the forgot-password dialog.
 * The backend returns 204 for the indistinguishable cases (success, no-such-user,
 * cooldown, SES failure) — only network/5xx surfaces as a floating alert here.
 */
async function sendPasswordResetEmail() {
    const email = document.querySelector("#forgot-password-email").value;
    const url = `${getApiBaseUrl()}/api/v1/pwd_reset/send`;
    let response;
    try {
        response = await apiFetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({email: email}),
        });
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert(FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        showFloatingAlert(await extractErrorMessage(response));
    }
}

/**
 * Loads one page of note headers and updates the list.
 *
 * fetchPage(continueKey) -> Promise of a dataLayer read result:
 *   caller-supplied function that knows which dataLayer method to call and
 *   with what extra arguments. Called once per invocation with the
 *   continueKey passed below.
 * continueKey: null for a fresh first-page load (replaces the list), or the
 *   continuation token from a previous result (appends).
 * sortByModifyTime: true to re-sort the whole accumulated list newest-first
 *   after folding in the page, re-rendering it entirely. Search results
 *   need this: their pages arrive in storage (note_id) order, unlike the
 *   list endpoints, which deliver modify_time order themselves.
 *
 * Returns true on success, false on failure (so callers like searchNotes
 * can decide whether to auto-follow further pages).
 *
 * Side effects: clears the note-list inline-alert on entry, updates the
 * inline-alert with a backend or fallback message on failure, manages
 * isLoadingNotes. On success, calls reobserveSentinel so that if the
 * sentinel is still in view the IntersectionObserver re-fires and the
 * next page is fetched immediately. On failure, reobserveSentinel is
 * deliberately skipped — calling observe() always re-fires the callback
 * synchronously, which would cause an instant retry loop while the
 * sentinel remains visible. A real scroll still fires the observer
 * normally because that's a genuine intersection-state change.
 */
async function loadNotePage(fetchPage, continueKey, sortByModifyTime) {
    isLoadingNotes = true;
    clearInlineAlert("#note-list-alert");
    try {
        const result = await fetchPage(continueKey);
        if (!result.ok) {
            if (continueKey === null) clearNoteListForError();
            showInlineAlert("#note-list-alert", null, result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
            return false;
        }
        const newHeaders = result.noteHeaders;
        continuationKey = result.continueKey;

        if (continueKey === null) {
            // First page: replace
            noteHeaders = newHeaders;
        } else {
            // Subsequent page: append
            noteHeaders = noteHeaders.concat(newHeaders);
        }
        if (sortByModifyTime) {
            noteHeaders.sort(byModifyTimeNewestFirst);
            renderNoteList();
        } else if (continueKey === null) {
            renderNoteList();
        } else {
            appendNoteHeaders(newHeaders);
        }
        updateSentinel();
        reobserveSentinel();
        return true;
    } catch (e) {
        if (e instanceof LoggedOutError) return false;
        if (continueKey === null) clearNoteListForError();
        showInlineAlert("#note-list-alert", null, FALLBACK_ERROR_MESSAGE);
        return false;
    } finally {
        isLoadingNotes = false;
    }
}

/**
 * Fetches note headers and renders the note list. Pass null as continueKey
 * to get the first block of values.
 */
async function loadNoteHeaders(continueKey) {
    await loadNotePage((ck) => dataLayer.getNotes(ck), continueKey, false);
}

/** Fetches deleted note headers and renders the note list. */
async function loadTrashNoteHeaders(continueKey) {
    await loadNotePage((ck) => dataLayer.getDeletedNotes(ck), continueKey, false);
}

/** Fetches note headers matching a search string and renders the note list. */
async function searchNotes(searchString, continueKey) {
    const succeeded = await loadNotePage(
        (ck) => dataLayer.searchNotes(searchString, ck),
        continueKey,
        true,
    );
    // Auto-follow continuation keys since search results are filtered and small.
    // Skip if the load failed — auto-follow would just fail the same way.
    if (succeeded && continuationKey) {
        await searchNotes(searchString, continuationKey);
    }
}

/** Saves the current note if the title or body has changed. */
async function saveNoteIfChanged() {
    if (trashView) return;

    // Wait for any save already in flight before deciding whether to save.
    // currentNote.version_id isn't updated until the in-flight save's response
    // arrives; sending a second save before then would carry a stale
    // source_version_id, which the backend treats as an edit conflict and
    // answers with a "[CONFLICTED]" note. Errors are reported by the call
    // that initiated the save, so waiters ignore them.
    while (saveInFlight) {
        try {
            await saveInFlight;
        } catch (e) {
            // Ignored: the initiating caller handles it.
        }
    }

    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const newTitle = titleInput.value;
    const newBody = bodyTextarea.value;

    // No await may occur between the checks above and setting saveInFlight
    // below, or another caller could slip in and start a concurrent save.
    if (currentNote === null) {
        // User started editing when there wasn't a note displayed: create a new one
        if (newTitle === "" && newBody === "") return;
        saveInFlight = createNewNote(newTitle, newBody);
    } else {
        // User was editing an existing note
        if (newTitle === currentNote.title && newBody === currentNote.body) return;
        saveInFlight = saveNote(newTitle, newBody);
    }
    try {
        await saveInFlight;
    } finally {
        saveInFlight = null;
    }
}

/** Saves the current note. */
async function saveNote(title, body) {
    const noteId = currentNote.note_id;
    const versionId = currentNote.version_id;
    let result;
    try {
        result = await dataLayer.editNote({
            noteId: noteId,
            title: title,
            body: body,
            sourceVersionId: versionId,
        });
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert("Failed to save changes to note.");
        return;
    }
    if (result.outcome === "rejected") {
        if (result.status === 409) {
            await handleConflict(result.note);
            return;
        }
        showFloatingAlert(result.errorMessage ?? "Failed to save changes to note.");
        return;
    }
    if (result.note !== null) {
        applyNoteToUI(result.note);
    }
}

/**
 * Handles an edit conflict on a save: the server left the note untouched
 * and created a conflict note holding this save's content. When that note
 * is known it is followed directly — it becomes the displayed note, with
 * the body textarea left as it is, since it holds exactly what was saved
 * into the conflict note plus any keystrokes typed while the save was in
 * flight, which the next save must keep. When the conflict note is not
 * known (the 409 body could not be read), fall back to a full state
 * refresh that selects the first note in the list — probably the conflict
 * note, which likely has the newest modify_time.
 */
async function handleConflict(conflictNote) {
    const conflictingNoteId = intendedCurrentNoteId;
    document.querySelector("input.search").value = "";
    if (conflictNote !== null) {
        if (setIntendedNoteIfUnchanged(conflictingNoteId, conflictNote.note_id)) {
            setCurrentNote(conflictNote);
            document.querySelector("article input.title").value = conflictNote.title;
            updateUndoRedoButtons();
        }
        await loadNoteHeaders(null);
        return;
    }
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    await loadNoteHeaders(null);
    // Select the first note in the list (probably the conflict note, which likely has the newest modify_time)
    if (noteHeaders.length > 0) {
        if (setIntendedNoteIfUnchanged(conflictingNoteId, noteHeaders[0].note_id)) {
            await loadNote(noteHeaders[0].note_id);
            const firstSlug = document.querySelector("note-list note-slug");
            if (firstSlug) {
                firstSlug.classList.add("active");
            }
            document.getElementById("main-page").classList.add("showing-note");
        }
    }
}

/** Refreshes state after the tab has been inactive for a long time. */
async function refreshAfterStale() {
    console.log("Refreshing stale tab");
    const priorIntended = intendedCurrentNoteId;
    await saveNoteIfChanged();
    const selectedNoteId = currentNote ? currentNote.note_id : null;
    await (trashView ? loadTrashNoteHeaders(null) : loadNoteHeaders(null));
    if (selectedNoteId) {
        const stillExists = noteHeaders.some(h => h.note_id === selectedNoteId);
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

/**
 * Assigns a title and body if needed, creates a new note via the API, and
 * switches to displaying it.
 */
async function createNewNote(newTitle = "", newBody = "") {
    let result;
    try {
        result = await dataLayer.newNote({title: newTitle, body: newBody, format: "PlainText"});
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert("Failed to create new note.");
        return;
    }
    if (result.outcome === "rejected") {
        showFloatingAlert(result.errorMessage ?? "Failed to create new note.");
        return;
    }
    if (result.note !== null && setIntendedNoteIfUnchanged(null, result.note.note_id)) {
        applyNoteToUI(result.note);
    }
}

/**
 * Deletes the current note. Optimistic: the UI removes the note before the
 * API call returns, so the user can continue navigating without waiting. On
 * failure, a floating-alert informs the user (the note stays gone locally
 * until the next refresh, when it'll reappear).
 */
async function deleteCurrentNote() {
    if (!currentNote) return;
    const noteId = currentNote.note_id;
    const versionId = currentNote.version_id;
    setIntendedNote(null);

    // Optimistic UI update: remove the note from local state before the API call.
    const oldIndex = noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        noteHeaders.splice(oldIndex, 1);
    }
    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();
    if (noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = trashView ? "No deleted notes." : "No notes yet. Click \"New\" to create one.";
        noteList.insertBefore(emptyMessage, noteList.firstChild);
    }
    setCurrentNote(null);
    renderNote();

    // Fire the write; surface failures via a floating-alert.
    let result;
    try {
        result = await dataLayer.deleteNote(noteId, versionId);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert(FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (result.outcome === "rejected") {
        showFloatingAlert(result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
    }
}

/** Removes the current note from the trash list UI and clears the display. */
function removeCurrentNoteFromTrashList() {
    const noteId = currentNote.note_id;
    setIntendedNote(null);

    const oldIndex = noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        noteHeaders.splice(oldIndex, 1);
    }

    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();

    if (noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = "No deleted notes.";
        noteList.insertBefore(emptyMessage, noteList.firstChild);
    }

    setCurrentNote(null);
    renderNote();
    document.getElementById("main-page").classList.remove("showing-note");
}

/**
 * Recovers the current note from trash. Optimistic: UI removes it from the
 * trash list before the API call returns; floating-alert on failure.
 */
async function recoverCurrentNote() {
    if (!currentNote) return;
    const noteId = currentNote.note_id;
    const versionId = currentNote.version_id;
    removeCurrentNoteFromTrashList();

    let result;
    try {
        result = await dataLayer.recoverNote(noteId, versionId);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert(FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (result.outcome === "rejected") {
        showFloatingAlert(result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
    }
}

/**
 * Permanently destroys the current note. Optimistic: UI removes it from the
 * trash list before the API call returns; floating-alert on failure.
 */
async function destroyCurrentNote() {
    if (!currentNote) return;
    const noteId = currentNote.note_id;
    removeCurrentNoteFromTrashList();

    let result;
    try {
        result = await dataLayer.destroyNote(noteId);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showFloatingAlert(FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (result.outcome === "rejected") {
        showFloatingAlert(result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
    }
}

/** Fetches the current user's data from the API and populates the user display fields. */
async function loadUser() {
    clearInlineAlert("#user-info-alert");
    document.getElementById("user-email-display").value = "";
    document.getElementById("user-type-display").value = "";
    document.getElementById("user-create-date-display").value = "";
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/user`);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showInlineAlert("#user-info-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        showInlineAlert("#user-info-alert", null, await extractErrorMessage(response));
        return;
    }
    const data = await response.json();
    const user = data.user;
    document.getElementById("user-email-display").value = user.email;
    document.getElementById("user-type-display").value = user.user_type;
    document.getElementById("user-create-date-display").value = user.create_time.substring(0, 10);
}

/** Fetches the current user's usage detail from the API and populates the user-details fields. */
async function loadUserDetail() {
    clearInlineAlert("#user-details-alert");
    const noteCountField = document.getElementById("user-note-count-display");
    const trashCountField = document.getElementById("user-trash-count-display");
    const lastEditField = document.getElementById("user-last-edit-display");
    const busiestNoteField = document.getElementById("user-busiest-note-version-display");
    noteCountField.value = "";
    trashCountField.value = "";
    lastEditField.value = "";
    busiestNoteField.value = "";
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/user_detail`);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        showInlineAlert("#user-details-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        showInlineAlert("#user-details-alert", null, await extractErrorMessage(response));
        return;
    }
    const data = await response.json();
    const detail = data.user_detail;
    noteCountField.value = detail.notes;
    trashCountField.value = detail.notes_in_trash;
    // The two maxima are null when the user has no active notes.
    lastEditField.value = detail.most_recent_edit ? detail.most_recent_edit.substring(0, 10) : "no notes";
    busiestNoteField.value = detail.busiest_note ?? "no notes";
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

/**
 * Fetches a single note from the API and renders it. The caller must set
 * intendedCurrentNoteId before calling this. If intendedCurrentNoteId has
 * changed by the time the fetch completes, the result is discarded.
 */
async function loadNote(noteId) {
    // Clear the pane immediately so the previous note doesn't linger
    // while the fetch is in flight. If the user clicks another slug
    // mid-flight, the intendedCurrentNoteId guard below will discard
    // this load's result (success or failure) so it can't clobber
    // the new selection.
    clearInlineAlert("#note-pane-alert");
    setCurrentNote(null);
    renderNote();
    let result;
    try {
        result = await dataLayer.getNote(noteId, NOTE_FETCH_TIMEOUT_MS);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        if (intendedCurrentNoteId === noteId) {
            showInlineAlert("#note-pane-alert", null, FALLBACK_ERROR_MESSAGE);
        }
        return;
    }
    if (!result.ok) {
        if (intendedCurrentNoteId === noteId) {
            showInlineAlert("#note-pane-alert", null, result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
        }
        return;
    }
    if (intendedCurrentNoteId === noteId) {
        setCurrentNote(result.note);
        renderNote();
    }
}

/** Utility for use in updateNoteInfo(). */
function countWords(str) {
    // Trim leading/trailing spaces and split by one or more whitespace characters
    const words = str.trim().split(/\s+/);
    // Filter out any potential empty strings from extra spaces and return the count
    return words.filter(word => word.length > 0).length;
}

/** Utility for use in updateNoteInfo(). */
function countCharacters(str) {
    const segmenter = new Intl.Segmenter("en-US", { granularity: "grapheme" });
    return [...segmenter.segment(str)].length;
}

/** Populates the note-info section with information about the current note (if there is one). */
function updateNoteInfo() {
    let create_time;
    let modify_time;
    if (currentNote) {
        create_time = currentNote.create_time.substring(0,10);
        modify_time = currentNote.modify_time.substring(0,10);
    } else {
        create_time = "new note";
        modify_time = "new note";
    }
    const body = document.querySelector("article textarea.note-body").value
    const word_count = countWords(body).toString();
    const character_count = countCharacters(body).toString();
    document.getElementById("create-time-display").value = create_time;
    document.getElementById("modify-time-display").value = modify_time;
    document.getElementById("word-count-display").value = word_count;
    document.getElementById("character-count-display").value = character_count;
}

// ========== Apply Diff ==========

/**
 * This applies the given note diff to the title and body of the currently-displayed note,
 * reading them from the page and writing the results back.
 *
 * Takes a note diff string (in the format described by formatNoteDiff() in diff.js) and a
 * boolean saying whether to reverse the effect of the diff instead of applying it.
 */
function applyNoteDiffToPage(diff, reverse) {
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const result = applyNoteDiff({title: titleInput.value, body: bodyTextarea.value}, diff, reverse);
    titleInput.value = result.title;
    bodyTextarea.value = result.body;
}

// ========== Actions ==========

/** Handles the login button click by sending credentials to the API. */
async function actionLoginBtn() {
    await login();
}

/** Handles the new account button click by creating a user account via the API. */
async function actionNewAccountBtn() {
    await createUser();
}

/** Handles the user button click by loading user data and showing the user info shadow box. */
async function actionUserBtn() {
    await loadUser();
    showShadowBox("user-display-dialog");
}

/** Click this to show the note info. */
async function actionNoteInfoBtn() {
    updateNoteInfo();
    showShadowBox("note-info-dialog");
}

/** Handles a click on a shadow-box; dismisses it if the click was on the backdrop. */
function actionDismissShadowBox(event) {
    if (event.target === event.currentTarget) {
        hideShadowBox(event.currentTarget.id);
    }
}

/** Handles the "back" button click in the user shadow box by dismissing it. */
function actionCloseUserShadowboxBtn() {
    hideShadowBox("user-display-dialog");
}

/** Handles the "back" button click in the note info shadow box by dismissing it. */
function actionCloseNoteInfoShadowboxBtn() {
    hideShadowBox("note-info-dialog");
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

/** Handles the logout button click by logging out via the API and resetting UI. */
async function actionLogoutBtn() {
    hideShadowBox("user-display-dialog");
    await logout();
}

/** Opens the user usage-detail dialog, loading the data first. */
async function actionUserDetailsBtn() {
    await loadUserDetail();
    showShadowBox("user-details-dialog");
}

/** Handles the back button in the user usage-detail dialog. */
function actionCloseUserDetailsBtn() {
    hideShadowBox("user-details-dialog");
}

/** Opens the user edit dialog. */
function actionUserEditDialogBtn() {
    showShadowBox("user-edit-dialog");
}

/** Opens the user edit dialog. */
function actionCloseUserEditBtn() {
    hideShadowBox("user-edit-dialog");
}

/** Submits the user edit form to update email and/or password. */
async function actionUserEditBtn() {
    try {
        await editUser();
    } catch (e) {
        hideShadowBox("user-edit-dialog");
        return;
    }
    await loadUser();
    hideShadowBox("user-edit-dialog");
}

/** Opens the user delete confirmation dialog with a clean state. */
function actionUserDeleteDialogBtn() {
    clearProgressBox("#delete-user-progress");
    clearInlineAlert("#delete-user-alert");
    showShadowBox("user-delete-dialog");
}

/** Handles the back button in the user delete dialog. */
function actionCloseUserDeleteBtn() {
    hideShadowBox("user-delete-dialog");
}

/**
 * How long the "Done deleting." confirmation is shown before the user is
 * logged out. Long enough to register; short enough not to feel laggy.
 */
const DELETE_USER_DONE_MS = 1500;

/**
 * Delete-account workflow: shows progress, then either completes (briefly
 * displays "Done deleting." before logging out) or surfaces an error.
 */
async function actionDeleteUserBtn() {
    clearInlineAlert("#delete-user-alert");
    showProgressBox("#delete-user-progress", "Deleting...");
    let response;
    try {
        response = await apiFetch(`${getApiBaseUrl()}/api/v1/user`, { method: "DELETE" });
    } catch (e) {
        clearProgressBox("#delete-user-progress");
        if (e instanceof LoggedOutError) {
            // apiFetch already handled the 401 and triggered logout; the
            // delete didn't happen, but we're already at the login screen.
            hideShadowBox("user-delete-dialog");
            hideShadowBox("user-display-dialog");
            return;
        }
        showInlineAlert("#delete-user-alert", null, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        clearProgressBox("#delete-user-progress");
        showInlineAlert("#delete-user-alert", null, await extractErrorMessage(response));
        return;
    }
    completeProgressBox("#delete-user-progress", "Done deleting.");
    // One of the very few places in the program where it simply pauses for a moment
    setTimeout(() => {
        clearProgressBox("#delete-user-progress");
        hideShadowBox("user-delete-dialog");
        hideShadowBox("user-display-dialog");
        stateUpdateForLogout();
    }, DELETE_USER_DONE_MS);
}

/** Opens the forgot-password dialog. Pre-fills email from the login field. */
function actionForgotPasswordLink() {
    const loginEmail = document.querySelector("#email-entry").value;
    document.querySelector("#forgot-password-email").value = loginEmail;
    showShadowBox("forgot-password-dialog");
}

/** Handles the back button in the forgot-password dialog. */
function actionCloseForgotPasswordBtn() {
    hideShadowBox("forgot-password-dialog");
}

/** Sends the reset request, then closes the dialog regardless of outcome. */
async function actionSendForgotPasswordBtn() {
    try {
        await sendPasswordResetEmail();
    } catch (e) {
        // The API returns 204 in every "expected" case, so a thrown error
        // here means a network failure or similar. Per the indistinguishable-
        // response design, we close the dialog without surfacing it.
    }
    hideShadowBox("forgot-password-dialog");
}

/** Handles the undo button by applying a diff from the undo stack. */
function actionUndoBtn() {
    if (!currentNote || !currentNote.undo_stack) {
        return;
    }
    const diff = currentNote.undo_stack.pop();
    applyNoteDiffToPage(diff, false);
    redo_stack.push(diff);
    unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
    updateUndoRedoButtons();
}

/** Handles the redo button by applying a diff from the redo stack. */
function actionRedoBtn() {
    if (!currentNote || !Array.isArray(currentNote.undo_stack) ) {
        return;
    }
    const diff = redo_stack.pop();
    applyNoteDiffToPage(diff, true);
    currentNote.undo_stack.push(diff);
    unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
    updateUndoRedoButtons();
}


/** Handles the new note button click by clearing the UI and focusing the body for editing. */
function actionNewNoteBtn() {
    saveUnfocusedEditsIfPending();
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    autoTitleActive = true;
    document.getElementById("main-page").classList.add("showing-note");
    document.querySelector("article textarea.note-body").focus();
}

/** Handles the delete button click by deleting the current note and returning to list view. */
async function actionDeleteNoteBtn() {
    await deleteCurrentNote();
    hideShadowBox("note-info-dialog");
    document.getElementById("main-page").classList.remove("showing-note");
}

/** Handles the back-to-list button click by switching from note view to list view. */
function actionBackToListBtn() {
    autoTitleActive = false;
    document.getElementById("main-page").classList.remove("showing-note");
}

/** Handles the trash button click by entering trash view. */
async function actionTrashBtn() {
    await enterTrashView();
}

/** Handles the close trash view button click by exiting trash view. */
async function actionCloseTrashView() {
    await exitTrashView();
}

/** Handles the restore button click by recovering the current note from trash. */
async function actionRestoreNoteBtn() {
    await recoverCurrentNote();
}

/** Handles the delete forever button (placeholder). */
async function actionDeleteForeverBtn() {
    await destroyCurrentNote();
}

/** Handles title input focus by entering note view and exiting auto-title mode. */
function actionTitleFocus() {
    saveUnfocusedEditsIfPending();
    autoTitleActive = false;
    document.getElementById("main-page").classList.add("showing-note");
}

/** Handles note body textarea focus by entering note view for mobile layout. */
function actionBodyFocus() {
    saveUnfocusedEditsIfPending();
    document.getElementById("main-page").classList.add("showing-note");
}

/** Handles title input blur by saving the note if it has changed. */
async function actionTitleBlur() {
    await saveNoteIfChanged();
}

/** Handles note body input by auto-populating the title from the first line. */
function actionBodyInput() {
    if (!autoTitleActive && currentNote === null) {
        autoTitleActive = true;
    }
    if (!autoTitleActive) return;
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const titleInput = document.querySelector("article input.title");
    const firstLine = bodyTextarea.value.split("\n")[0];
    titleInput.value = firstLine.substring(0, 40);
}

/** Handles note body textarea blur by saving the note if it has changed. */
async function actionBodyBlur() {
    await saveNoteIfChanged();
}

/** Handles search input by debouncing and filtering the note list. */
function actionSearchInput(event) {
    saveUnfocusedEditsIfPending();
    clearTimeout(searchDebounceTimer);
    autoTitleActive = false;

    // Immediately deselect current note, clear article, and exit note view
    document.getElementById("main-page").classList.remove("showing-note");
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    const activeSlug = document.querySelector("note-slug.active");
    if (activeSlug) activeSlug.classList.remove("active");

    const searchString = event.target.value.trim();

    if (searchString === "") {
        // Empty search: reload full note list
        loadNoteHeaders(null);
    } else {
        // Debounce: wait 300ms after typing stops, then search
        searchDebounceTimer = setTimeout(() => {
            searchNotes(searchString, null);
        }, 300);
    }
}

/** Handles a click on the note list by selecting and loading the clicked note. */
async function actionNoteListClick(event) {
    saveUnfocusedEditsIfPending();
    const slug = event.target.closest("note-slug");
    if (!slug) return;
    autoTitleActive = false;
    setIntendedNote(slug.dataset.noteId);
    const current = document.querySelector("note-slug.active");
    if (current) current.classList.remove("active");
    slug.classList.add("active");
    await loadNote(slug.dataset.noteId);
    document.getElementById("main-page").classList.add("showing-note");
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

/**
 * Event-delegated handler for the close button inside floating-alert.
 * The button is rebuilt on every renderFloatingAlert, so we listen on
 * the (long-lived) <floating-alert> element and inspect the click target.
 */
function actionFloatingAlertClick(event) {
    if (event.target.closest("button.close")) {
        dismissFloatingAlert();
    }
}

// ========== Stale Tab Detection ==========

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

// ========== Initialization ==========

// Route apiFetch's handling of a rejected session into this page's logout.
setSessionExpiredHandler(stateUpdateForLogout);

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

/**
 * Reports a queued write command that the server definitively refused
 * during a background delivery pass. The command has been dropped
 * (docs/pwa_design.md → "Delivery Outcomes"); a floating alert tells the
 * user which note lost a change, and why when the server said.
 */
function actionBackgroundRejection(command, outcome) {
    const subject = command.payload.title !== undefined
        ? `"${command.payload.title}"`
        : "a note";
    const reason = outcome.errorMessage ?? "the server refused it";
    showFloatingAlert(`A queued change to ${subject} could not be saved: ${reason}`);
}

/**
 * Reacts to a queued write command that met an edit conflict during a
 * background delivery pass. The data layer has already run the conflict
 * fix-up (docs/pwa_design.md → "Fix-up Pass: Conflict"): the note's queued
 * changes and its mirror entry now continue under the conflict note. Here
 * the UI follows that branch. A floating alert announces it; if the
 * original note is the one being displayed, the editor is pointed at the
 * conflict note — swapping the identity underneath the user's draft rather
 * than re-rendering, since the mirror's re-keyed entry (not the older
 * conflictNote snapshot) reflects any queued edits and the draft may hold
 * unsaved keystrokes on top of those. The title gains the conflict prefix
 * so the marker survives the next save. The note list is reloaded to show
 * the branch, unless a search is active — its results would be replaced by
 * the full list.
 */
function actionBackgroundConflict(command, conflictNote) {
    const subject = command.payload.title !== undefined
        ? `"${command.payload.title}"`
        : "a note";
    showFloatingAlert(
        `A queued change to ${subject} conflicted with a newer version of the note `
            + `and was kept as "${conflictNote.title}".`);
    if (intendedCurrentNoteId === command.note_id) {
        setIntendedNote(conflictNote.note_id);
        if (currentNote !== null && currentNote.note_id === command.note_id) {
            const titleInput = document.querySelector("article input.title");
            titleInput.value = CONFLICT_TITLE_PREFIX + titleInput.value;
            setCurrentNote({
                ...currentNote,
                note_id: conflictNote.note_id,
                title: CONFLICT_TITLE_PREFIX + currentNote.title,
            });
        } else {
            // The original note was still loading; load the conflict note
            // instead (the load of the original can no longer render, since
            // the intended note has moved on).
            loadNote(conflictNote.note_id);
        }
    }
    if (document.querySelector("input.search").value === "") {
        if (trashView) {
            loadTrashNoteHeaders(null);
        } else {
            loadNoteHeaders(null);
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    setupScrollObserver();

    document.querySelector("#user-btn").addEventListener("click", actionUserBtn);
    document.querySelector("#login-btn").addEventListener("click", actionLoginBtn);
    document.querySelector("#note-info-btn").addEventListener("click", actionNoteInfoBtn);
    document.querySelector("#new-account-btn").addEventListener("click", actionNewAccountBtn);
    document.querySelector("#close-user-shadowbox-btn").addEventListener("click", actionCloseUserShadowboxBtn);
    document.querySelector("#close-note-info-shadowbox-btn").addEventListener("click", actionCloseNoteInfoShadowboxBtn);
    document.querySelector("#logout-btn").addEventListener("click", actionLogoutBtn);
    document.querySelector("#user-details-btn").addEventListener("click", actionUserDetailsBtn);
    document.querySelector("#close-user-details-btn").addEventListener("click", actionCloseUserDetailsBtn);
    document.querySelector("#user-edit-dialog-btn").addEventListener("click", actionUserEditDialogBtn);
    document.querySelector("#close-user-edit-btn").addEventListener("click", actionCloseUserEditBtn);
    document.querySelector("#user-edit-btn").addEventListener("click", actionUserEditBtn);
    document.querySelector("#user-delete-dialog-btn").addEventListener("click", actionUserDeleteDialogBtn);
    document.querySelector("#close-user-delete-btn").addEventListener("click", actionCloseUserDeleteBtn);
    document.querySelector("#delete-user-btn").addEventListener("click", actionDeleteUserBtn);
    document.querySelector("#forgot-password-link").addEventListener("click", actionForgotPasswordLink);
    document.querySelector("#close-forgot-password-btn").addEventListener("click", actionCloseForgotPasswordBtn);
    document.querySelector("#send-forgot-password-btn").addEventListener("click", actionSendForgotPasswordBtn);
    document.querySelector("#undo-btn").addEventListener("click", actionUndoBtn);
    document.querySelector("#redo-btn").addEventListener("click", actionRedoBtn);
    document.querySelectorAll(".settings-btn").forEach(btn => {
        btn.addEventListener("click", actionSettingsBtn);
    });
    document.querySelector("#close-settings-btn").addEventListener("click", actionCloseSettingsBtn);
    document.querySelector("settings-nav-list").addEventListener("click", actionSettingsNavClick);
    document.querySelectorAll("shadow-box").forEach(sb => {
        sb.addEventListener("click", actionDismissShadowBox);
    });
    document.querySelector("#new-note").addEventListener("click", actionNewNoteBtn);
    document.querySelector("#delete-note").addEventListener("click", actionDeleteNoteBtn);
    document.querySelector("#back-to-list").addEventListener("click", actionBackToListBtn);
    document.querySelector("#trash-btn").addEventListener("click", actionTrashBtn);
    document.querySelector("#close-trash-view-btn").addEventListener("click", actionCloseTrashView);
    document.querySelector("#restore-note-btn").addEventListener("click", actionRestoreNoteBtn);
    document.querySelector("#delete-forever-btn").addEventListener("click", actionDeleteForeverBtn);
    document.querySelector("#note input.title").addEventListener("focus", actionTitleFocus);
    document.querySelector("#note input.title").addEventListener("blur", actionTitleBlur);
    document.querySelector("#note textarea.note-body").addEventListener("focus", actionBodyFocus);
    document.querySelector("#note textarea.note-body").addEventListener("input", actionBodyInput);
    document.querySelector("#note textarea.note-body").addEventListener("blur", actionBodyBlur);
    document.querySelector("input.search").addEventListener("input", actionSearchInput);
    document.querySelector("note-list").addEventListener("click", actionNoteListClick);
    document.querySelector("#import-notes-file").addEventListener("change", actionImportFileChange);
    document.querySelector("#import-notes-btn").addEventListener("click", actionImportNotesBtn);
    document.querySelector("floating-alert").addEventListener("click", actionFloatingAlertClick);
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
});
