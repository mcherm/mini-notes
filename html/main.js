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
    const noteList = document.querySelector("note-list");
    noteList.innerHTML = "";
    noteHeaders.forEach((header, index) => {
        noteList.appendChild(createNoteSlug(header, index === 0));
    });
}

// ========== API Calls ==========

/** Fetches the first page of note headers from the API and renders the note list. */
async function loadNoteHeaders() {
    const url = `${getApiBaseUrl()}/api/v1/notes`;
    const response = await fetch(url);
    const data = await response.json();
    noteHeaders = data.note_headers;
    renderNoteList();
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", loadNoteHeaders);
