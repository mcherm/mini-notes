"use strict";

/** Thrown by apiFetch when a 401 triggers logout, to abort the caller's flow. */
class LoggedOutError extends Error {
    constructor() { super("Session expired — logged out"); }
}

// ========== Constants ==========

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STALE_UNFOCUSED_EDIT_MS = 60 * 1000; // 1 minute

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
let redo_stack = [];
let intendedCurrentNoteId = null;
let continuationKey = null;
let isLoadingNotes = false;
let searchDebounceTimer = null;
let lastActiveTime = Date.now();
let autoTitleActive = false;
let unfocusedEditsPending = false;
let unfocusedEditDebounceTimer = null;

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
    if (noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = "No notes yet. Click \"New\" to create one.";
        noteList.appendChild(emptyMessage);
    } else {
        const emptyMessage = noteList.querySelector("note-list-empty");
        if (emptyMessage) emptyMessage.remove();
    }
    setupScrollObserver();
}

/** Populates the article area with the current note's title and body. */
function renderNote() {
    unfocusedEditsPending = false;
    clearTimeout(unfocusedEditDebounceTimer);
    unfocusedEditDebounceTimer = null;
    const noteElem = document.getElementById("note");
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    if (currentNote) {
        noteElem.classList.toggle("can-redo", redo_stack.length > 0);
        noteElem.classList.toggle("can-undo", currentNote.undo_stack.length > 0);
        titleInput.value = currentNote.title;
        bodyTextarea.value = currentNote.body;
    } else {
        noteElem.classList.toggle("can-redo", false);
        noteElem.classList.toggle("can-undo", false);
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
    const noteId = currentNote.note_id;
    const versionId = currentNote.version_id;
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    const response = await apiFetch(url, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: title, body: body, source_version_id: versionId}),
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
    const conflictingNoteId = intendedCurrentNoteId;
    document.querySelector("input.search").value = "";
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    await loadNoteHeaders();
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
    await loadNoteHeaders();
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
    const url = `${getApiBaseUrl()}/api/v1/notes`;
    const response = await apiFetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: newTitle, body: newBody, format: "PlainText"}),
    });
    const data = await response.json();
    if (setIntendedNoteIfUnchanged(null, data.note.note_id)) {
        applyNoteToUI(data.note);
    }
}

/** Deletes the current note via the API and clears it from the UI. */
async function deleteCurrentNote() {
    if (!currentNote) return;
    const noteId = currentNote.note_id;
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    setIntendedNote(null);
    await apiFetch(url, { method: "DELETE" });

    const oldIndex = noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        noteHeaders.splice(oldIndex, 1);
    }

    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();

    if (noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = "No notes yet. Click \"New\" to create one.";
        noteList.insertBefore(emptyMessage, noteList.firstChild);
    }

    setCurrentNote(null);
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

/** Imports notes from the selected file by POSTing its raw bytes to the API. */
async function importNotes(file) {
    const statusSpan = document.getElementById("import-notes-status");
    statusSpan.textContent = "Importing...";
    try {
        const bytes = await file.arrayBuffer();
        const url = `${getApiBaseUrl()}/api/v1/note_import`;
        const response = await apiFetch(url, {
            method: "POST",
            body: bytes,
        });
        if (response.ok) {
            const data = await response.json();
            statusSpan.textContent = `Done: ${data.notes_created} created, ${data.notes_updated} updated.`;
            await loadNoteHeaders();
        } else {
            const data = await response.json();
            statusSpan.textContent = `Error: ${data.error || "import failed"}`;
        }
    } catch (e) {
        if (!(e instanceof LoggedOutError)) {
            statusSpan.textContent = `Error: ${e.message}`;
        }
    }
}

/**
 * Fetches a single note from the API and renders it. The caller must set
 * intendedCurrentNoteId before calling this. If intendedCurrentNoteId has
 * changed by the time the fetch completes, the result is discarded.
 */
async function loadNote(noteId) {
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    const response = await apiFetch(url);
    const data = await response.json();
    if (intendedCurrentNoteId === noteId) {
        setCurrentNote(data.note);
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
 * This applies the given diff (in the format described below) to the title and body of the
 * currently-displayed note.
 *
 * The format of the diff is one if these ("{" and "}" enclose descriptive text describing content;
 * other characters are literal). It can be any of three forms: "b:{body-diff}", or "t:{title-diff},
 * or "t:{title-diff}|b:{body-diff}". In each case, {body-diff} is a string diff (as processed by
 * applyStringDiff).
 */
function applyNoteDiff(diff, reverse=false) {
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");

    let section = diff;
    while (section.length > 0) {
        const colonPos = section.indexOf(":");
        if (colonPos === -1) break;
        const key = section.substring(0, colonPos);
        const sectionDiff = section.substring(colonPos + 1);

        if (key === "t") {
            const result = applyStringDiff(titleInput.value, sectionDiff, reverse);
            titleInput.value = result.asApplied;
            section = result.remaining;
        } else if (key === "b") {
            const result = applyStringDiff(bodyTextarea.value, sectionDiff, reverse);
            bodyTextarea.value = result.asApplied;
            section = result.remaining;
        } else {
            break; // unknown key
        }

        // Strip leading '|' separator before next section
        if (section.startsWith("|")) {
            section = section.substring(1);
        }
    }
}

/**
 * This is passed a string and a "diff" in the format described below, and it returns a string made by
 * applying the diff. Alternately, if reverse=true is provided it will reverse the effect of the diff.
 * Actually, it is slightly more complex than that, because instead of being passed a diff, it can be
 * passed a diff followed by a "|" and other characters, and it will return the unparsed portion of
 * the string. So it ACTUALLY returns an object with three fields: "asApplied" (a string with the
 * result of applying the diff to s), "remaining" (a string containing the rest of the diff string
 * that was NOT part of the leading diff), and "appliesCleanly" (a boolean which is true normally, but
 * false if there was an error applying the diff.
 *
 * The format of the diff is a series of entries, where each entry is (1) an 'unedited range', which is
 * a series of 1 or more digits ("0".."9"), or (2) a 'change' which looks like
 * "[{text-to-remove}|{text-to-add}]" (note: "{" and "}" wrap descriptive text, "[", "|", and "]" are
 * literals).
 *
 * An 'unedited range' is interpreted as a number in base 10 and it means that many characters in the
 * original string should be left as-is (starting from the beginning, or wherever the last bit left off).
 * A 'change' expects to find the literal text-to-remove next, and it will remove that and replace it
 * with the text-to-add. Both text-to-remove and text-to-add allow escaped characters: a "\|" means a
 * single "|", a "\]" means a single "]", and a "\\" means a single "\".
 *
 * If at any point, the next bit of text does NOT perfectly match the text-to-remove, then the diff
 * does not apply cleanly. Instead of deleting anything, it will skip forward that many characters and
 * insert the text-to-add. If we reach the end of the source string without reaching the end of the
 * characters in the diff that also means it did not apply cleanly.
 *
 * Notice that a diff can contain a "|" character inside a 'change', and within a text-to-remove or
 * text-to-add if the "|" is preceeded by a "\", but it CANNOT contain a "|" outside of a 'change'.
 * If a "|" is encountered outside of a 'change' then that indicates the end of the diff and the
 * remainder of the diff input (including the "|") are returned in the "remaining" field.
 */
function applyStringDiff(s, diff, reverse=false) {
    const srcChars = Array.from(s); // split into Unicode code points
    let srcPos = 0;
    let diffPos = 0;
    let asApplied = "";
    let appliesCleanly = true;

    while (diffPos < diff.length) {
        const ch = diff[diffPos];

        if (ch >= "0" && ch <= "9") {
            // Unedited range: read all consecutive digits as a base-10 number
            let numStr = "";
            while (diffPos < diff.length && diff[diffPos] >= "0" && diff[diffPos] <= "9") {
                numStr += diff[diffPos];
                diffPos++;
            }
            const count = parseInt(numStr, 10);
            for (let i = 0; i < count; i++) {
                if (srcPos < srcChars.length) {
                    asApplied += srcChars[srcPos];
                    srcPos++;
                } else {
                    appliesCleanly = false;
                }
            }
        } else if (ch === "[") {
            // Change: parse [text-to-remove|text-to-add]
            diffPos++; // skip '['
            const textToRemove = readEscaped("|");
            const textToAdd = readEscaped("]");

            const expectedText = reverse ? textToAdd : textToRemove;
            const insertText = reverse ? textToRemove : textToAdd;

            // Check if source matches the expected text
            const expectedChars = Array.from(expectedText);
            let matches = true;
            if (srcPos + expectedChars.length > srcChars.length) {
                matches = false;
            } else {
                for (let i = 0; i < expectedChars.length; i++) {
                    if (srcChars[srcPos + i] !== expectedChars[i]) {
                        matches = false;
                        break;
                    }
                }
            }

            if (matches) {
                srcPos += expectedChars.length; // skip the matched text
            } else {
                appliesCleanly = false;
                // Copy over expectedChars.length characters from source, then insert
                const copyCount = Math.min(expectedChars.length, srcChars.length - srcPos);
                for (let i = 0; i < copyCount; i++) {
                    asApplied += srcChars[srcPos];
                    srcPos++;
                }
            }
            asApplied += insertText;
        } else if (ch === "|") {
            // Bare '|' outside a change: end of this diff
            break;
        } else {
            throw new Error(`Invalid diff: unexpected character '${ch}' at position ${diffPos}`);
        }
    }

    // Any remaining source characters
    if (srcPos < srcChars.length) {
        for (let i = srcPos; i < srcChars.length; i++) {
            asApplied += srcChars[i];
        }
        appliesCleanly = false;
    }

    const remaining = diff.substring(diffPos);
    return { asApplied, remaining, appliesCleanly };

    /** Helper: read characters from diff until unescaped terminator, advancing diffPos. */
    function readEscaped(terminator) {
        let result = "";
        while (diffPos < diff.length) {
            const c = diff[diffPos];
            if (c === "\\") {
                diffPos++;
                if (diffPos < diff.length) {
                    const escaped = diff[diffPos];
                    if (escaped !== "\\" && escaped !== "]" && escaped !== "|") {
                        throw new Error(`Invalid diff: unexpected escape sequence '\\${escaped}' at position ${diffPos - 1}`);
                    }
                    result += escaped;
                    diffPos++;
                }
            } else if (c === terminator) {
                diffPos++; // skip the terminator
                return result;
            } else {
                result += c;
                diffPos++;
            }
        }
        return result; // reached end without finding terminator
    }
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

/** Handles a settings button click by showing the app-settings shadow box. */
function actionSettingsBtn() {
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

/** Opens the user delete confirmation dialog. */
function actionUserDeleteDialogBtn() {
    showShadowBox("user-delete-dialog");
}

/** Handles the back button in the user delete dialog. */
function actionCloseUserDeleteBtn() {
    hideShadowBox("user-delete-dialog");
}

/** Handles the delete account button by calling the API and logging out. */
async function actionDeleteUserBtn() {
    try {
        await apiFetch(`${getApiBaseUrl()}/api/v1/user`, { method: "DELETE" });
    } catch (e) {
        // If the delete fails, just close the dialog
        hideShadowBox("user-delete-dialog");
        return;
    }
    hideShadowBox("user-delete-dialog");
    hideShadowBox("user-display-dialog");
    stateUpdateForLogout();
}

/** Handles the undo button by applying a diff from the undo stack. */
function actionUndoBtn() {
    if (!currentNote || !currentNote.undo_stack) {
        return;
    }
    const diff = currentNote.undo_stack.pop();
    applyNoteDiff(diff);
    redo_stack.push(diff);
    unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
}

/** Handles the redo button by applying a diff from the redo stack. */
function actionRedoBtn() {
    if (!currentNote || !Array.isArray(currentNote.undo_stack) ) {
        return;
    }
    const diff = redo_stack.pop();
    applyNoteDiff(diff, true);
    currentNote.undo_stack.push(diff);
    unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
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
    document.getElementById("import-notes-status").textContent = "";
}

/** Imports notes from the file currently selected in the file input. */
async function actionImportNotesBtn() {
    const file = document.querySelector("#import-notes-file").files[0];
    if (file) await importNotes(file);
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

document.addEventListener("DOMContentLoaded", () => {
    setupScrollObserver();
    loadNoteHeaders();

    document.querySelector("#user-btn").addEventListener("click", actionUserBtn);
    document.querySelector("#login-btn").addEventListener("click", actionLoginBtn);
    document.querySelector("#note-info-btn").addEventListener("click", actionNoteInfoBtn);
    document.querySelector("#new-account-btn").addEventListener("click", actionNewAccountBtn);
    document.querySelector("#close-user-shadowbox-btn").addEventListener("click", actionCloseUserShadowboxBtn);
    document.querySelector("#close-note-info-shadowbox-btn").addEventListener("click", actionCloseNoteInfoShadowboxBtn);
    document.querySelector("#logout-btn").addEventListener("click", actionLogoutBtn);
    document.querySelector("#user-delete-dialog-btn").addEventListener("click", actionUserDeleteDialogBtn);
    document.querySelector("#close-user-delete-btn").addEventListener("click", actionCloseUserDeleteBtn);
    document.querySelector("#delete-user-btn").addEventListener("click", actionDeleteUserBtn);
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
    document.querySelector("#note input.title").addEventListener("focus", actionTitleFocus);
    document.querySelector("#note input.title").addEventListener("blur", actionTitleBlur);
    document.querySelector("#note textarea.note-body").addEventListener("focus", actionBodyFocus);
    document.querySelector("#note textarea.note-body").addEventListener("input", actionBodyInput);
    document.querySelector("#note textarea.note-body").addEventListener("blur", actionBodyBlur);
    document.querySelector("input.search").addEventListener("input", actionSearchInput);
    document.querySelector("note-list").addEventListener("click", actionNoteListClick);
    document.querySelector("#import-notes-file").addEventListener("change", actionImportFileChange);
    document.querySelector("#import-notes-btn").addEventListener("click", actionImportNotesBtn);
    document.addEventListener("visibilitychange", actionOnVisibilityChange);
    window.addEventListener("focus", actionOnWindowFocus);
    window.addEventListener("blur", actionOnWindowBlur);

    // Fix any links to work in both dev & prod environments
    document.querySelectorAll("a").forEach(a => {
        if (a.href.startsWith("https://api.mini-notes.com/")) {
            a.href = a.href.replace("https://api.mini-notes.com", getApiBaseUrl());
        }
    });
});
