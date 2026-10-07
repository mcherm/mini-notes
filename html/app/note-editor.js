/**
 * The note pane: displaying the current note, saving edits (including edit
 * conflicts), undo/redo, the note-info dialog, and creating, deleting,
 * recovering and destroying notes.
 */

import { clearInlineAlert, showFloatingAlert, showInlineAlert } from "../lib/alerts.js";
import { FALLBACK_ERROR_MESSAGE, LoggedOutError } from "../lib/api.js";
import { hideShadowBox, showShadowBox } from "../lib/dialogs.js";
import { CONFLICT_TITLE_PREFIX } from "../model/commands.js";
import { applyNoteDiff } from "../model/diff.js";
import { dataLayer } from "../data/data-layer.js";
import {
    createNoteSlug,
    loadNoteHeaders,
    loadTrashNoteHeaders,
    noteHeaderMatchesSlug,
    renderNoteList,
    SERVER_FETCH_TIMEOUT_MS,
} from "./note-list.js";
import { setCurrentNote, setIntendedNote, setIntendedNoteIfUnchanged, state } from "./state.js";

const STALE_UNFOCUSED_EDIT_MS = 60 * 1000; // 1 minute

/** If unfocused edits are pending, save immediately and clear the timer. */
export function saveUnfocusedEditsIfPending() {
    if (!state.unfocusedEditsPending) return;
    state.unfocusedEditsPending = false;
    clearTimeout(state.unfocusedEditDebounceTimer);
    state.unfocusedEditDebounceTimer = null;
    saveNoteIfChanged();
}

/** Starts or restarts the debounce timer for saving unfocused edits. */
function restartUnfocusedEditTimer() {
    clearTimeout(state.unfocusedEditDebounceTimer);
    state.unfocusedEditDebounceTimer = setTimeout(() => {
        state.unfocusedEditDebounceTimer = null;
        if (state.unfocusedEditsPending) {
            state.unfocusedEditsPending = false;
            saveNoteIfChanged();
        }
    }, STALE_UNFOCUSED_EDIT_MS);
}

/** Updates the can-undo/can-redo classes on #note based on current stack state. */
function updateUndoRedoButtons() {
    const noteElem = document.getElementById("note");
    const canUndo = !!(state.currentNote?.undo_stack && state.currentNote.undo_stack.length > 0);
    const canRedo = !!(state.currentNote && state.redo_stack.length > 0);
    noteElem.classList.toggle("can-undo", canUndo);
    noteElem.classList.toggle("can-redo", canRedo);
}

/** Populates the article area with the current note's title and body. */
export function renderNote() {
    state.unfocusedEditsPending = false;
    clearTimeout(state.unfocusedEditDebounceTimer);
    state.unfocusedEditDebounceTimer = null;
    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    updateUndoRedoButtons();
    if (state.currentNote) {
        titleInput.value = state.currentNote.title;
        bodyTextarea.value = state.currentNote.body;
    } else {
        titleInput.value = "";
        bodyTextarea.value = "";
    }
}

/**
 * Updates currentNote, noteHeaders, and the DOM after receiving a note
 * from the API. This is a no-op if the note doesn't match
 * intendedCurrentNoteId — meaning the user has navigated away and this
 * data is stale. Safe to call from async completion handlers without
 * external guards.
 */
function applyNoteToUI(note) {
    if (note.note_id !== state.intendedCurrentNoteId) return;
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
    state.listGenerationCounter++;
    const oldIndex = state.noteHeaders.findIndex(h => h.note_id === note.note_id);
    if (oldIndex !== -1) {
        state.noteHeaders.splice(oldIndex, 1);
    }
    state.noteHeaders.unshift(newHeader);

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

/**
 * Fetches a single note from the API and renders it. The caller must set
 * intendedCurrentNoteId before calling this. If intendedCurrentNoteId has
 * changed by the time the fetch completes, the result is discarded.
 */
export async function loadNote(noteId) {
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
        result = await dataLayer.getNote(noteId, SERVER_FETCH_TIMEOUT_MS);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        if (state.intendedCurrentNoteId === noteId) {
            showInlineAlert("#note-pane-alert", null, FALLBACK_ERROR_MESSAGE);
        }
        return;
    }
    if (!result.ok) {
        if (state.intendedCurrentNoteId === noteId) {
            showInlineAlert("#note-pane-alert", null, result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
        }
        return;
    }
    if (state.intendedCurrentNoteId === noteId) {
        setCurrentNote(result.note);
        renderNote();
    }
}

/** Saves the current note if the title or body has changed. */
export async function saveNoteIfChanged() {
    if (state.trashView) return;

    // Wait for any save already in flight before deciding whether to save.
    // currentNote.version_id isn't updated until the in-flight save's response
    // arrives; sending a second save before then would carry a stale
    // source_version_id, which the backend treats as an edit conflict and
    // answers with a "[CONFLICTED]" note. Errors are reported by the call
    // that initiated the save, so waiters ignore them.
    while (state.saveInFlight) {
        try {
            await state.saveInFlight;
        } catch (_err) {
            // Ignored: the initiating caller handles it.
        }
    }

    const titleInput = document.querySelector("article input.title");
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const newTitle = titleInput.value;
    const newBody = bodyTextarea.value;

    // No await may occur between the checks above and setting saveInFlight
    // below, or another caller could slip in and start a concurrent save.
    if (state.currentNote === null) {
        // User started editing when there wasn't a note displayed: create a new one
        if (newTitle === "" && newBody === "") return;
        state.saveInFlight = createNewNote(newTitle, newBody);
    } else {
        // User was editing an existing note
        if (newTitle === state.currentNote.title && newBody === state.currentNote.body) return;
        state.saveInFlight = saveNote(newTitle, newBody);
    }
    try {
        await state.saveInFlight;
    } finally {
        state.saveInFlight = null;
    }
}

/** Saves the current note. */
async function saveNote(title, body) {
    const noteId = state.currentNote.note_id;
    const versionId = state.currentNote.version_id;
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
    const conflictingNoteId = state.intendedCurrentNoteId;
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
    if (state.noteHeaders.length > 0) {
        if (setIntendedNoteIfUnchanged(conflictingNoteId, state.noteHeaders[0].note_id)) {
            await loadNote(state.noteHeaders[0].note_id);
            const firstSlug = document.querySelector("note-list note-slug");
            if (firstSlug) {
                firstSlug.classList.add("active");
            }
            document.getElementById("main-page").classList.add("showing-note");
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
    if (!state.currentNote) return;
    const noteId = state.currentNote.note_id;
    const versionId = state.currentNote.version_id;
    setIntendedNote(null);

    // Optimistic UI update: remove the note from local state before the API call.
    state.listGenerationCounter++;
    const oldIndex = state.noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        state.noteHeaders.splice(oldIndex, 1);
    }
    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();
    if (state.noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = state.trashView ? "No deleted notes." : "No notes yet. Click \"New\" to create one.";
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
    const noteId = state.currentNote.note_id;
    setIntendedNote(null);

    state.listGenerationCounter++;
    const oldIndex = state.noteHeaders.findIndex(h => h.note_id === noteId);
    if (oldIndex !== -1) {
        state.noteHeaders.splice(oldIndex, 1);
    }

    const noteList = document.querySelector("note-list");
    const oldSlug = noteList.querySelector(`note-slug[data-note-id="${noteId}"]`);
    if (oldSlug) oldSlug.remove();

    if (state.noteHeaders.length === 0) {
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
    if (!state.currentNote) return;
    const noteId = state.currentNote.note_id;
    const versionId = state.currentNote.version_id;
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
    if (!state.currentNote) return;
    const noteId = state.currentNote.note_id;
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
    if (state.currentNote) {
        create_time = state.currentNote.create_time.substring(0,10);
        modify_time = state.currentNote.modify_time.substring(0,10);
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

/** Click this to show the note info. */
async function actionNoteInfoBtn() {
    updateNoteInfo();
    showShadowBox("note-info-dialog");
}

/** Handles the "back" button click in the note info shadow box by dismissing it. */
function actionCloseNoteInfoShadowboxBtn() {
    hideShadowBox("note-info-dialog");
}

/** Handles the undo button by applying a diff from the undo stack. */
function actionUndoBtn() {
    if (!state.currentNote?.undo_stack) {
        return;
    }
    const diff = state.currentNote.undo_stack.pop();
    applyNoteDiffToPage(diff, false);
    state.redo_stack.push(diff);
    state.unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
    updateUndoRedoButtons();
}

/** Handles the redo button by applying a diff from the redo stack. */
function actionRedoBtn() {
    if (!state.currentNote || !Array.isArray(state.currentNote.undo_stack) ) {
        return;
    }
    const diff = state.redo_stack.pop();
    applyNoteDiffToPage(diff, true);
    state.currentNote.undo_stack.push(diff);
    state.unfocusedEditsPending = true;
    restartUnfocusedEditTimer();
    updateUndoRedoButtons();
}

/** Handles the new note button click by clearing the UI and focusing the body for editing. */
function actionNewNoteBtn() {
    saveUnfocusedEditsIfPending();
    setIntendedNote(null);
    setCurrentNote(null);
    renderNote();
    state.autoTitleActive = true;
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
    state.autoTitleActive = false;
    document.getElementById("main-page").classList.remove("showing-note");
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
    state.autoTitleActive = false;
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
    if (!state.autoTitleActive && state.currentNote === null) {
        state.autoTitleActive = true;
    }
    if (!state.autoTitleActive) return;
    const bodyTextarea = document.querySelector("article textarea.note-body");
    const titleInput = document.querySelector("article input.title");
    const firstLine = bodyTextarea.value.split("\n")[0];
    titleInput.value = firstLine.substring(0, 40);
}

/** Handles note body textarea blur by saving the note if it has changed. */
async function actionBodyBlur() {
    await saveNoteIfChanged();
}

/**
 * Reports a queued write command that the server definitively refused
 * during a background delivery pass. The command has been dropped
 * (docs/pwa_design.md → "Delivery Outcomes"); a floating alert tells the
 * user which note lost a change, and why when the server said.
 */
export function actionBackgroundRejection(command, outcome) {
    const subject = command.payload.title !== undefined
        ? `"${command.payload.title}"`
        : "a note";
    const reason = outcome.errorMessage
        ?? (outcome.poisoned ? "sending it failed repeatedly" : "the server refused it");
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
export function actionBackgroundConflict(command, conflictNote) {
    const subject = command.payload.title !== undefined
        ? `"${command.payload.title}"`
        : "a note";
    showFloatingAlert(
        `A queued change to ${subject} conflicted with a newer version of the note `
            + `and was kept as "${conflictNote.title}".`);
    if (state.intendedCurrentNoteId === command.note_id) {
        setIntendedNote(conflictNote.note_id);
        if (state.currentNote !== null && state.currentNote.note_id === command.note_id) {
            const titleInput = document.querySelector("article input.title");
            titleInput.value = CONFLICT_TITLE_PREFIX + titleInput.value;
            setCurrentNote({
                ...state.currentNote,
                note_id: conflictNote.note_id,
                title: CONFLICT_TITLE_PREFIX + state.currentNote.title,
            });
        } else {
            // The original note was still loading; load the conflict note
            // instead (the load of the original can no longer render, since
            // the intended note has moved on).
            loadNote(conflictNote.note_id);
        }
    }
    if (document.querySelector("input.search").value === "") {
        if (state.trashView) {
            loadTrashNoteHeaders(null);
        } else {
            loadNoteHeaders(null);
        }
    }
}

/** Registers the note pane's listeners. */
export function registerNoteEditorListeners() {
    document.querySelector("#note-info-btn").addEventListener("click", actionNoteInfoBtn);
    document.querySelector("#close-note-info-shadowbox-btn").addEventListener("click", actionCloseNoteInfoShadowboxBtn);
    document.querySelector("#undo-btn").addEventListener("click", actionUndoBtn);
    document.querySelector("#redo-btn").addEventListener("click", actionRedoBtn);
    document.querySelector("#new-note").addEventListener("click", actionNewNoteBtn);
    document.querySelector("#delete-note").addEventListener("click", actionDeleteNoteBtn);
    document.querySelector("#back-to-list").addEventListener("click", actionBackToListBtn);
    document.querySelector("#restore-note-btn").addEventListener("click", actionRestoreNoteBtn);
    document.querySelector("#delete-forever-btn").addEventListener("click", actionDeleteForeverBtn);
    document.querySelector("#note input.title").addEventListener("focus", actionTitleFocus);
    document.querySelector("#note input.title").addEventListener("blur", actionTitleBlur);
    document.querySelector("#note textarea.note-body").addEventListener("focus", actionBodyFocus);
    document.querySelector("#note textarea.note-body").addEventListener("input", actionBodyInput);
    document.querySelector("#note textarea.note-body").addEventListener("blur", actionBodyBlur);
}
