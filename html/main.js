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

// ========== State ==========


let noteHeaders = [];
let currentNote = null;
let continuationKey = null;
let isLoadingNotes = false;

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

// ========== Rendering ==========

/** Clears the <note-list> element and repopulates it from the noteHeaders array. */
function renderNoteList() {
    // TODO: Special display for when the list is empty.
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
 *   replaceNoteId: if set, removes the old header/slug for that note (used by save).
 *   deactivateOld: if true, deactivates the currently active slug (used by new note).
 */
function applyNoteToUI(note, { replaceNoteId = null, deactivateOld = false } = {}) {
    currentNote = note;

    const newHeader = {
        user_id: note.user_id,
        note_id: note.note_id,
        version_id: note.version_id,
        title: note.title,
        modify_time: note.modify_time,
        format: note.format,
    };

    if (replaceNoteId) {
        const oldIndex = noteHeaders.findIndex(h => h.note_id === replaceNoteId);
        if (oldIndex !== -1) {
            noteHeaders.splice(oldIndex, 1);
        }
    }
    noteHeaders.unshift(newHeader);

    const noteList = document.querySelector("note-list");

    if (replaceNoteId) {
        const oldSlug = noteList.querySelector(`note-slug[data-note-id="${replaceNoteId}"]`);
        if (oldSlug) oldSlug.remove();
    }

    if (deactivateOld) {
        const activeSlug = noteList.querySelector("note-slug.active");
        if (activeSlug) activeSlug.classList.remove("active");
    }

    const newSlug = createNoteSlug(newHeader, true);
    noteList.insertBefore(newSlug, noteList.firstChild);

    renderNote();
}

// ========== API Calls ==========

/** Fetches note headers from the API and renders the note list. */
async function loadNoteHeaders(continueKey) {
    isLoadingNotes = true;
    try {
        let url = `${getApiBaseUrl()}/api/v1/notes`;
        if (continueKey) {
            url += `?continue_key=${encodeURIComponent(continueKey)}`;
        }
        const response = await fetch(url);
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

/** Saves the current note if the title or body has changed. */
async function saveNoteIfChanged() {
    if (!currentNote) return;
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const newTitle = titleInput.value;
    const newBody = bodyTextarea.value;
    if (newTitle === currentNote.title && newBody === currentNote.body) return;

    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(currentNote.note_id)}`;
    const noteId = currentNote.note_id;
    const response = await fetch(url, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: newTitle, body: newBody}),
    });
    const data = await response.json();
    applyNoteToUI(data.note, { replaceNoteId: noteId });
}

/** Creates a new note via the API and switches to it. */
async function createNewNote() {
    await saveNoteIfChanged();
    const url = `${getApiBaseUrl()}/api/v1/notes`;
    const response = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({title: "New Note", body: "", format: "PlainText"}),
    });
    const data = await response.json();
    applyNoteToUI(data.note, { deactivateOld: true });
}

/** Fetches a single note from the API and renders it. */
async function loadNote(noteId) {
    const url = `${getApiBaseUrl()}/api/v1/notes/${encodeURIComponent(noteId)}`;
    const response = await fetch(url);
    const data = await response.json();
    currentNote = data.note;
    renderNote();
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    setupScrollObserver();
    loadNoteHeaders();

    document.querySelector("#new-note").addEventListener("click", createNewNote);
    document.querySelector("article input.title").addEventListener("blur", saveNoteIfChanged);
    document.querySelector("article textarea.note-body").addEventListener("blur", saveNoteIfChanged);

    document.querySelector("note-list").addEventListener("click", (event) => {
        const slug = event.target.closest("note-slug");
        if (!slug) return;
        const current = document.querySelector("note-slug.active");
        if (current) current.classList.remove("active");
        slug.classList.add("active");
        loadNote(slug.dataset.noteId);
    });
});
