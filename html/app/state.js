/**
 * The notes page's shared mutable state, and the functions that change the
 * parts of it with invariants to keep. The state lives in one exported
 * object because modules cannot assign to a variable another module exports.
 */

export const state = {
    noteHeaders: [],
    currentNote: null,
    redo_stack: [],
    intendedCurrentNoteId: null,
    continuationKey: null,
    isLoadingNotes: false,
    searchDebounceTimer: null,
    autoTitleActive: false,
    unfocusedEditsPending: false,
    unfocusedEditDebounceTimer: null,
    /** Promise for the save currently in flight, or null when none is. */
    saveInFlight: null,
    /** Boolean, where true means we are viewing the trash rather than normal notes. */
    trashView: false,
    /**
     * Counts changes to the displayed note list, so that a first-page load
     * applies its server response only if nothing changed the list while the
     * response was awaited; otherwise the response is out of date and is
     * dropped. Incremented when any first-page list load starts (in
     * loadNotePage) and whenever a write edits the displayed list in place.
     * Any new code that edits the displayed list in place must increment it.
     */
    listGenerationCounter: 0,
};

/** Returns true if the user is currently logged in. */
export function isLoggedIn() {
    return document.body.classList.contains("logged-in");
}

/** Sets the logged-in state by toggling the body class. */
export function setLoggedIn(value) {
    document.body.classList.toggle("logged-in", value);
}

/**
 * Sets the current note to be displayed (set to null to display no note). Does
 * not automatically render it, you have to call renderNote() separately. DOES
 * set the redo_stack to [] every time.
 */
export function setCurrentNote(note) {
    state.currentNote = note;
    state.redo_stack = [];
}

/**
 * Sets which note the UI intends to display. Call this synchronously in
 * response to a user action (before any await). Never call this after an
 * await without using setIntendedNoteIfUnchanged() instead.
 */
export function setIntendedNote(noteId) {
    state.intendedCurrentNoteId = noteId;
}

/**
 * Sets the intended note only if no other action has changed it since the
 * caller last checked. Use this after an await to avoid clobbering a user
 * action that occurred during the async gap. Returns true if the value was
 * set, false if it was stale (meaning the caller should stop updating the UI).
 */
export function setIntendedNoteIfUnchanged(expectedValue, newNoteId) {
    if (state.intendedCurrentNoteId !== expectedValue) return false;
    state.intendedCurrentNoteId = newNoteId;
    return true;
}
