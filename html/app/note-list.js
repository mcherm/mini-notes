/**
 * The note list: loading pages of note headers (from the server and the
 * local mirror), rendering them, infinite scroll, search, and the trash view.
 */

import { clearInlineAlert, showInlineAlert } from "../lib/alerts.js";
import { FALLBACK_ERROR_MESSAGE, LoggedOutError, OFFLINE_ERROR_MESSAGE } from "../lib/api.js";
import { dataLayer } from "../data/data-layer.js";
import { FETCH_TIMED_OUT, raceAgainstTimeout } from "../data/network-source.js";
import { byModifyTimeNewestFirst } from "../data/offline-source.js";
import { loadNote, renderNote, saveUnfocusedEditsIfPending } from "./note-editor.js";
import { setCurrentNote, setIntendedNote, state } from "./state.js";

/**
 * How long a server read may run before the app treats the server as
 * unreachable and shows locally mirrored data instead: a note fetch serves
 * the mirrored copy (if any), and a first-page list load shows the full
 * mirrored list. Tuned to usually leave the server enough time to answer —
 * including a cold start — without making a user on a hanging connection
 * wait long enough to feel stuck.
 */
export const SERVER_FETCH_TIMEOUT_MS = 3 * 1000;

/**
 * How many mirrored note headers are shown while the server's first page
 * of a note list is awaited. Matches the server's page size
 * (NOTES_PER_BATCH), so the cached list covers what that page will.
 */
const FIRST_PAGE_SIZE = 100;

/** Creates a <note-slug> element from a NoteHeader object. */
export function createNoteSlug(noteHeader, isActive) {
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
export function noteHeaderMatchesSlug(noteHeader, noteSlug) {
    return noteSlug.textContent === noteHeader.title;
}

/** Clears the <note-list> element and repopulates it from the noteHeaders array. */
export function renderNoteList() {
    const noteList = document.querySelector("note-list");
    noteList.innerHTML = "";
    state.noteHeaders.forEach((header) => {
        const isActive = state.currentNote !== null && header.note_id === state.currentNote.note_id;
        noteList.appendChild(createNoteSlug(header, isActive));
    });
    if (state.noteHeaders.length === 0) {
        const emptyMessage = document.createElement("note-list-empty");
        emptyMessage.textContent = state.trashView ? "No deleted notes." : "No notes yet. Click \"New\" to create one.";
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
    state.noteHeaders = [];
    const noteList = document.querySelector("note-list");
    noteList.innerHTML = "";
    setupScrollObserver();
}

/** Appends new <note-slug> elements to <note-list>, inserted before the sentinel. */
function appendNoteHeaders(newHeaders) {
    const noteList = document.querySelector("note-list");
    const sentinel = noteList.querySelector("note-list-sentinel");
    newHeaders.forEach((header) => {
        const isActive = state.currentNote !== null && header.note_id === state.currentNote.note_id;
        noteList.insertBefore(createNoteSlug(header, isActive), sentinel);
        const emptyMessage = noteList.querySelector("note-list-empty");
        if (emptyMessage) emptyMessage.remove();
    });
}

let scrollObserver = null;

/** Creates a sentinel element and IntersectionObserver for infinite scroll. */
function setupScrollObserver() {
    const noteList = document.querySelector("note-list");
    const sentinel = document.createElement("note-list-sentinel");
    noteList.appendChild(sentinel);

    scrollObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && state.continuationKey !== null && !state.isLoadingNotes) {
            if (state.trashView) {
                loadTrashNoteHeaders(state.continuationKey);
            } else {
                loadNoteHeaders(state.continuationKey);
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
    if (state.continuationKey !== null) {
        sentinel.textContent = "Loading...";
        sentinel.style.display = "";
    } else {
        sentinel.textContent = "";
        sentinel.style.display = "none";
    }
}

/**
 * True when two header lists would render identically: the same notes in
 * the same order, with the same title, version and modify time.
 */
function sameNoteHeaders(a, b) {
    return a.length === b.length && a.every((header, i) =>
        header.note_id === b[i].note_id
        && header.title === b[i].title
        && header.version_id === b[i].version_id
        && header.modify_time === b[i].modify_time);
}

/**
 * Shows note headers read from the local mirror as the whole list, with no
 * continuation key, so scrolling loads nothing more. Does nothing when
 * there are no headers to show (null: no mirror) or when the displayed list
 * has changed since the load numbered generation began. Returns true when
 * the headers were shown.
 */
function showCachedNoteHeaders(headers, generation) {
    if (headers === null || generation !== state.listGenerationCounter) return false;
    state.noteHeaders = headers;
    state.continuationKey = null;
    renderNoteList();
    updateSentinel();
    return true;
}

/**
 * Applies one dataLayer read result to the list; the second half of
 * loadNotePage, which documents the parameters and the return value. A
 * first-page result is dropped when the displayed list has changed since
 * the load numbered generation began (see listGenerationCounter).
 * cachedShown is true when the list currently shows mirrored headers from
 * this same load: a failure then leaves them in place rather than clearing
 * the list, and a result identical to them is not re-rendered.
 */
function applyNotePage(result, continueKey, sortByModifyTime, generation, cachedShown) {
    if (continueKey === null && generation !== state.listGenerationCounter) return false;
    if (!result.ok) {
        if (continueKey === null && !cachedShown) clearNoteListForError();
        showInlineAlert("#note-list-alert", null, result.errorMessage ?? FALLBACK_ERROR_MESSAGE);
        return false;
    }
    if (result.fromMirror) {
        showInlineAlert("#note-list-alert", null, OFFLINE_ERROR_MESSAGE);
    } else {
        clearInlineAlert("#note-list-alert");
    }
    const newHeaders = result.noteHeaders;
    state.continuationKey = result.continueKey;

    if (cachedShown && sameNoteHeaders(state.noteHeaders, newHeaders)) {
        // Already displayed: leave the DOM alone, so nothing moves.
    } else if (continueKey === null) {
        // First page: replace
        state.noteHeaders = newHeaders;
        if (sortByModifyTime) state.noteHeaders.sort(byModifyTimeNewestFirst);
        renderNoteList();
    } else {
        // Subsequent page: append
        state.noteHeaders = state.noteHeaders.concat(newHeaders);
        if (sortByModifyTime) {
            state.noteHeaders.sort(byModifyTimeNewestFirst);
            renderNoteList();
        } else {
            appendNoteHeaders(newHeaders);
        }
    }
    updateSentinel();
    reobserveSentinel();
    return true;
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
 * fetchCachedPage(limit) -> Promise of a header array, or of null: optional
 *   caller-supplied function reading the same list from the local mirror,
 *   at most limit headers (null for all). When given, a first-page load
 *   shows the mirror's first FIRST_PAGE_SIZE headers at once, then the
 *   server's page when it arrives. If the server has not answered within
 *   SERVER_FETCH_TIMEOUT_MS, the full mirrored list is shown instead, with
 *   the OFFLINE_ERROR_MESSAGE alert, and the server's page is still applied
 *   (clearing the alert) if it arrives later. A first page the data layer
 *   served from the mirror (fromMirror) shows the same alert.
 *   (docs/pwa_design.md → "The Read Path")
 *
 * Returns true on success, false on failure (so callers like searchNotes
 * can decide whether to auto-follow further pages). After a timeout it
 * returns true without waiting for the server.
 *
 * Every first-page load increments listGenerationCounter, and its result
 * is dropped if the counter has moved on by the time it arrives.
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
async function loadNotePage(fetchPage, continueKey, sortByModifyTime, fetchCachedPage = null) {
    if (continueKey === null) state.listGenerationCounter++;
    const generation = state.listGenerationCounter;
    state.isLoadingNotes = true;
    clearInlineAlert("#note-list-alert");
    try {
        const cachedShown = continueKey === null && fetchCachedPage !== null
            && showCachedNoteHeaders(await fetchCachedPage(FIRST_PAGE_SIZE), generation);
        const fetching = fetchPage(continueKey);
        if (!cachedShown) {
            return applyNotePage(await fetching, continueKey, sortByModifyTime, generation, false);
        }
        const raced = await raceAgainstTimeout(fetching, SERVER_FETCH_TIMEOUT_MS);
        if (raced !== FETCH_TIMED_OUT) {
            return applyNotePage(raced, continueKey, sortByModifyTime, generation, true);
        }
        // Treat the server as unreachable: show the whole mirrored list,
        // and apply the server's page if it does arrive later.
        showCachedNoteHeaders(await fetchCachedPage(null), generation);
        if (generation === state.listGenerationCounter) {
            showInlineAlert("#note-list-alert", null, OFFLINE_ERROR_MESSAGE);
        }
        fetching.then(
            (late) => applyNotePage(late, continueKey, sortByModifyTime, generation, true),
            (e) => {
                if (!(e instanceof LoggedOutError)) console.warn("late note list load failed:", e);
            },
        );
        return true;
    } catch (e) {
        if (e instanceof LoggedOutError) return false;
        if (continueKey === null) clearNoteListForError();
        showInlineAlert("#note-list-alert", null, FALLBACK_ERROR_MESSAGE);
        return false;
    } finally {
        state.isLoadingNotes = false;
    }
}

/**
 * Fetches note headers and renders the note list. Pass null as continueKey
 * to get the first block of values.
 */
export async function loadNoteHeaders(continueKey) {
    await loadNotePage(
        (ck) => dataLayer.getNotes(ck),
        continueKey,
        false,
        (limit) => dataLayer.getCachedNotes(false, limit),
    );
}

/** Fetches deleted note headers and renders the note list. */
export async function loadTrashNoteHeaders(continueKey) {
    await loadNotePage(
        (ck) => dataLayer.getDeletedNotes(ck),
        continueKey,
        false,
        (limit) => dataLayer.getCachedNotes(true, limit),
    );
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
    if (succeeded && state.continuationKey) {
        await searchNotes(searchString, state.continuationKey);
    }
}

/** Enters trash view: shows deleted notes in read-only mode. */
async function enterTrashView() {
    saveUnfocusedEditsIfPending();
    state.trashView = true;
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
    state.trashView = false;
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

/** Handles the trash button click by entering trash view. */
async function actionTrashBtn() {
    await enterTrashView();
}

/** Handles the close trash view button click by exiting trash view. */
async function actionCloseTrashView() {
    await exitTrashView();
}

/** Handles search input by debouncing and filtering the note list. */
function actionSearchInput(event) {
    saveUnfocusedEditsIfPending();
    clearTimeout(state.searchDebounceTimer);
    state.autoTitleActive = false;

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
        state.searchDebounceTimer = setTimeout(() => {
            searchNotes(searchString, null);
        }, 300);
    }
}

/** Handles a click on the note list by selecting and loading the clicked note. */
async function actionNoteListClick(event) {
    saveUnfocusedEditsIfPending();
    const slug = event.target.closest("note-slug");
    if (!slug) return;
    state.autoTitleActive = false;
    setIntendedNote(slug.dataset.noteId);
    const current = document.querySelector("note-slug.active");
    if (current) current.classList.remove("active");
    slug.classList.add("active");
    await loadNote(slug.dataset.noteId);
    document.getElementById("main-page").classList.add("showing-note");
}

/** Sets up the note list's scroll observer and registers its listeners. */
export function registerNoteListListeners() {
    setupScrollObserver();
    document.querySelector("#trash-btn").addEventListener("click", actionTrashBtn);
    document.querySelector("#close-trash-view-btn").addEventListener("click", actionCloseTrashView);
    document.querySelector("input.search").addEventListener("input", actionSearchInput);
    document.querySelector("note-list").addEventListener("click", actionNoteListClick);
}
