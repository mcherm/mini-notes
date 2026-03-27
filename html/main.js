"use strict";

/** Thrown by apiFetch when a 401 triggers logout, to abort the caller's flow. */
class LoggedOutError extends Error {
    constructor() { super("Session expired — logged out"); }
}

// ========== Constants ==========

const DEFAULT_NOTE_TITLE = "New Note";
const STALE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

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

// ========== State ==========

let noteHeaders = [];
let currentNote = null;
let continuationKey = null;
let isLoadingNotes = false;
let searchDebounceTimer = null;
let lastActiveTime = Date.now();

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

/** Call this when the state of the application should change to "not logged in". */
function stateUpdateForLogout() {
    setLoggedIn(false);
    noteHeaders = [];
    currentNote = null;
    continuationKey = null;
    isLoadingNotes = false;
    searchDebounceTimer = null;
    document.getElementById("main-page").classList.remove("showing-note");
    renderNote();
    document.querySelector("input.search").value = "";
}

/**
 * Call this when the state of the application should change to "logged in". Be sure
 * that the cookie is also being set or it won't work.
 */
async function stateUpdateForLogin() {
    setLoggedIn(true);
    document.querySelector("#email-entry").value = "";
    document.querySelector("#password-entry").value = "";
    await loadNoteHeaders();
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
    setupScrollObserver();
}

/** Populates the article area with the current note's title and body. */
function renderNote() {
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
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
            loadNoteHeaders(continuationKey);
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
 * Updates currentNote, noteHeaders, and the DOM after receiving a note from the API.
 */
function applyNoteToUI(note) {
    currentNote = note;
    // NOTE: This does not currently update the title and note text because it is
    // ALWAYS being called in places where those are already correct.

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

    renderNote();
}

// ========== API Calls ==========

/** Wrapper around fetch that adds credentials and handles 401 by logging out. */
async function apiFetch(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    if (response.status === 401) {
        stateUpdateForLogout();
        throw new LoggedOutError();
    }
    return response;
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

/** Sends login request to the API with the entered email and password. */
async function login() {
    const email = document.querySelector("#email-entry").value;
    const password = document.querySelector("#password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/user_login`;
    const response = await apiFetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email, password: password}),
    });
    const data = await response.json();
    console.log("Login response:", JSON.stringify(data, null, 2));
    if (response.ok) {
        await stateUpdateForLogin();
    }
}

/** Sends new account request to the API with the entered email and password. */
async function createUser() {
    const email = document.querySelector("#email-entry").value;
    const password = document.querySelector("#password-entry").value;
    const url = `${getApiBaseUrl()}/api/v1/user_create`;
    const response = await apiFetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email, password: password}),
    });
    const data = await response.json();
    console.log("Create account response:", JSON.stringify(data, null, 2));
    if (response.ok) {
        await stateUpdateForLogin();
    }
}

/**
 * Fetches note headers from the API and renders the note list. continueKey is
 * optional; omit it to get the first block of values.
 */
async function loadNoteHeaders(continueKey) {
    isLoadingNotes = true;
    try {
        const queryParams = continueKey ? `?continue_key=${encodeURIComponent(continueKey)}` : "";
        const url = `${getApiBaseUrl()}/api/v1/notes${queryParams}`;
        const response = await apiFetch(url);
        const data = await response.json();
        console.log("API response data:", JSON.stringify(data, null, 2));
        const newHeaders = data.note_headers;
        continuationKey = data.continue_key || null;
        console.log("continuationKey set to:", continuationKey);

        if (continueKey) {
            // Subsequent page: append
            noteHeaders = noteHeaders.concat(newHeaders);
            appendNoteHeaders(newHeaders);
        } else {
            // First page: replace
            noteHeaders = newHeaders;
            renderNoteList();
        }
        updateSentinel();
    } finally {
        isLoadingNotes = false;
        reobserveSentinel();
    }
}

/** Fetches note headers matching a search string and renders the note list. */
async function searchNotes(searchString, continueKey) {
    isLoadingNotes = true;
    try {
        const extraQueryParams = continueKey ? `&continue_key=${encodeURIComponent(continueKey)}` : "";
        const url = `${getApiBaseUrl()}/api/v1/note_search?search_string=${encodeURIComponent(searchString)}${extraQueryParams}`;
        const response = await apiFetch(url);
        const data = await response.json();
        const newHeaders = data.note_headers;
        continuationKey = data.continue_key || null;

        if (continueKey) {
            noteHeaders = noteHeaders.concat(newHeaders);
            appendNoteHeaders(newHeaders);
        } else {
            noteHeaders = newHeaders;
            renderNoteList();
        }
        updateSentinel();

        // Auto-follow continuation keys since search results are filtered and small
        if (continuationKey) {
            await searchNotes(searchString, continuationKey);
        }
    } finally {
        isLoadingNotes = false;
        reobserveSentinel();
    }
}

/** Saves the current note if the title or body has changed. */
async function saveNoteIfChanged() {
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const newTitle = titleInput.value;
    const newBody = bodyTextarea.value;


    if (currentNote === null) {
        // User started editing when there wasn't a note displayed: create a new one
        if (newTitle === "" && newBody === "") return;
        await createNewNote(newTitle, newBody)
    } else {
        // User was editing an existing note
        if (newTitle === currentNote.title && newBody === currentNote.body) return;
        await saveNote(newTitle, newBody);
    }
}

/** Saves the current note. */
async function saveNote(title, body) {
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(currentNote.note_id)}`;
    const response = await apiFetch(url, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: title, body: body, source_version_id: currentNote.version_id}),
    });
    const data = await response.json();
    if (response.status === 409) {
        await handleConflict();
    } else {
        applyNoteToUI(data.note);
    }
}

/** Handles an edit conflict by doing a full state refresh. */
async function handleConflict() {
    document.querySelector("input.search").value = "";
    currentNote = null;
    await loadNoteHeaders();
    // Select the first note in the list (probably the conflict note, which likely has the newest modify_time)
    if (noteHeaders.length > 0) {
        await loadNote(noteHeaders[0].note_id);
        const firstSlug = document.querySelector("note-list note-slug");
        if (firstSlug) {
            firstSlug.classList.add("active");
        }
        document.getElementById("main-page").classList.add("showing-note");
    }
}

/** Refreshes state after the tab has been inactive for a long time. */
async function refreshAfterStale() {
    console.log("Refreshing stale tab");
    await saveNoteIfChanged();
    const selectedNoteId = currentNote ? currentNote.note_id : null;
    await loadNoteHeaders();
    if (selectedNoteId) {
        const stillExists = noteHeaders.some(h => h.note_id === selectedNoteId);
        if (stillExists) {
            await loadNote(selectedNoteId);
        } else {
            currentNote = null;
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
    if (newTitle === "") {
        newTitle = DEFAULT_NOTE_TITLE;
    }
    const url = `${getApiBaseUrl()}/api/v1/notes`;
    const response = await apiFetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: newTitle, body: newBody, format: "PlainText"}),
    });
    const data = await response.json();
    applyNoteToUI(data.note);
}

/** Deletes the current note via the API and clears it from the UI. */
async function deleteCurrentNote() {
    if (!currentNote) return;
    const noteId = currentNote.note_id;
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    await apiFetch(url, { method: "DELETE" });

    const oldIndex = noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        noteHeaders.splice(oldIndex, 1);
    }

    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();

    currentNote = null;
    renderNote();
}

/** Fetches the current user's data from the API and populates the user display fields. */
async function loadUser() {
    const url = `${getApiBaseUrl()}/api/v1/user`;
    const response = await apiFetch(url);
    if (!response.ok) return;
    const data = await response.json();
    const user = data.user;
    document.getElementById("user-email-display").value = user.email;
    document.getElementById("user-type-display").value = user.user_type;
    document.getElementById("user-create-date-display").value = user.create_time.substring(0, 10);
}

/** Fetches a single note from the API and renders it. */
async function loadNote(noteId) {
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    const response = await apiFetch(url);
    const data = await response.json();
    currentNote = data.note;
    renderNote();
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
    showShadowBox("user-display");
}

/** Handles a click on a shadow-box; dismisses it if the click was on the backdrop. */
function actionDismissShadowBox(event) {
    if (event.target === event.currentTarget) {
        hideShadowBox(event.currentTarget.id);
    }
}

/** Handles the cancel button click in the user shadow box by dismissing it. */
function actionCloseUserShadowboxBtn() {
    hideShadowBox("user-display");
}

/** Handles a settings button click by showing the app-settings shadow box. */
function actionSettingsBtn() {
    showShadowBox("app-settings");
}

/** Handles the close button click in the settings shadow box by dismissing it. */
function actionCloseSettingsBtn() {
    hideShadowBox("app-settings");
}

/** Handles a click on the settings nav list by selecting the clicked item. */
function actionSettingsNavClick(event) {
    const navItem = event.target.closest("settings-nav-item");
    if (!navItem) return;
    selectSettingsNavItem(navItem);
}

/** Handles the logout button click by logging out via the API and resetting UI. */
async function actionLogoutBtn() {
    hideShadowBox("user-display");
    await logout();
}

/** Handles the new note button click by creating a note and switching to note view. */
async function actionNewNoteBtn() {
    await createNewNote();
    document.getElementById("main-page").classList.add("showing-note");
}

/** Handles the delete button click by deleting the current note and returning to list view. */
async function actionDeleteNoteBtn() {
    await deleteCurrentNote();
    document.getElementById("main-page").classList.remove("showing-note");
}

/** Handles the back-to-list button click by switching from note view to list view. */
function actionBackToListBtn() {
    document.getElementById("main-page").classList.remove("showing-note");
}

/** Handles title input focus by entering note view for mobile layout. */
function actionTitleFocus() {
    document.getElementById("main-page").classList.add("showing-note");
}

/** Handles note body textarea focus by entering note view for mobile layout. */
function actionBodyFocus() {
    document.getElementById("main-page").classList.add("showing-note");
}

/** Handles title input blur by saving the note if it has changed. */
async function actionTitleBlur() {
    await saveNoteIfChanged();
}

/** Handles note body textarea blur by saving the note if it has changed. */
async function actionBodyBlur() {
    await saveNoteIfChanged();
}

/** Handles search input by debouncing and filtering the note list. */
function actionSearchInput(event) {
    clearTimeout(searchDebounceTimer);

    // Immediately deselect current note, clear article, and exit note view
    document.getElementById("main-page").classList.remove("showing-note");
    currentNote = null;
    renderNote();
    const activeSlug = document.querySelector("note-slug.active");
    if (activeSlug) activeSlug.classList.remove("active");

    const searchString = event.target.value.trim();

    if (searchString === "") {
        // Empty search: reload full note list
        loadNoteHeaders();
    } else {
        // Debounce: wait 300ms after typing stops, then search
        searchDebounceTimer = setTimeout(() => {
            searchNotes(searchString);
        }, 300);
    }
}

/** Handles a click on the note list by selecting and loading the clicked note. */
async function actionNoteListClick(event) {
    const slug = event.target.closest("note-slug");
    if (!slug) return;
    await saveNoteIfChanged();
    const current = document.querySelector("note-slug.active");
    if (current) current.classList.remove("active");
    slug.classList.add("active");
    await loadNote(slug.dataset.noteId);
    document.getElementById("main-page").classList.add("showing-note");
}

// ========== Stale Tab Detection ==========

/** Checks if enough time has passed since last active and refreshes if so. */
async function checkAndRefreshIfStale() {
    if (!isLoggedIn()) return;
    const elapsed = Date.now() - lastActiveTime;
    if (elapsed > STALE_THRESHOLD_MS) {
        await refreshAfterStale();
    }
}

function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
        lastActiveTime = Date.now();
    } else if (document.visibilityState === "visible") {
        checkAndRefreshIfStale();
    }
}

function handleWindowFocus() {
    checkAndRefreshIfStale();
}

function handleWindowBlur() {
    lastActiveTime = Date.now();
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    setupScrollObserver();
    loadNoteHeaders();

    document.querySelector("#user-btn").addEventListener("click", actionUserBtn);
    document.querySelector("#login-btn").addEventListener("click", actionLoginBtn);
    document.querySelector("#new-account-btn").addEventListener("click", actionNewAccountBtn);
    document.querySelector("#close-user-shadowbox-btn").addEventListener("click", actionCloseUserShadowboxBtn);
    document.querySelector("#logout-btn").addEventListener("click", actionLogoutBtn);
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
    document.querySelector("article input.title").addEventListener("focus", actionTitleFocus);
    document.querySelector("article input.title").addEventListener("blur", actionTitleBlur);
    document.querySelector("article textarea.note-body").addEventListener("focus", actionBodyFocus);
    document.querySelector("article textarea.note-body").addEventListener("blur", actionBodyBlur);
    document.querySelector("input.search").addEventListener("input", actionSearchInput);
    document.querySelector("note-list").addEventListener("click", actionNoteListClick);
    document.querySelector("#export-notes-link").href = `${getApiBaseUrl()}/api/v1/note_export`;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
});
