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
    noteHeaders.forEach((header, index) => {
        noteList.appendChild(createNoteSlug(header, index === 0));
    });
    setupScrollObserver();
}

/** Appends new <note-slug> elements to <note-list>, inserted before the sentinel. */
function appendNoteHeaders(newHeaders) {
    const noteList = document.querySelector("note-list");
    const sentinel = noteList.querySelector("note-list-sentinel");
    const wasEmpty = noteHeaders.length === 0;
    newHeaders.forEach((header, index) => {
        noteList.insertBefore(createNoteSlug(header, wasEmpty && index === 0), sentinel);
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
        console.log("IntersectionObserver fired, isIntersecting:", entries[0].isIntersecting,
            "continuationKey:", continuationKey, "isLoadingNotes:", isLoadingNotes);
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
    console.log("updateSentinel called, sentinel found:", !!sentinel, "continuationKey:", continuationKey);
    if (!sentinel) return;
    if (continuationKey !== null) {
        sentinel.textContent = "Loading...";
        sentinel.style.display = "";
    } else {
        sentinel.textContent = "";
        sentinel.style.display = "none";
    }
}

// ========== API Calls ==========

/** Fetches note headers from the API and renders the note list. */
async function loadNoteHeaders(continueKey) {
    console.log("loadNoteHeaders called, continueKey:", continueKey);
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

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    setupScrollObserver();
    loadNoteHeaders();
});
