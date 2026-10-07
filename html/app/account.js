/**
 * The user's account and session: login, logout, account creation, the user
 * info/details/edit/delete dialogs, and the forgot-password dialog. These
 * calls have no offline support by design, so they use apiFetch directly
 * rather than dataLayer.
 */

import {
    clearAllFloatingAlerts,
    clearInlineAlert,
    clearProgressBox,
    completeProgressBox,
    showFloatingAlert,
    showInlineAlert,
    showProgressBox,
} from "../lib/alerts.js";
import {
    apiFetch,
    extractErrorMessage,
    FALLBACK_ERROR_MESSAGE,
    getApiBaseUrl,
    LoggedOutError,
} from "../lib/api.js";
import { hideShadowBox, showShadowBox } from "../lib/dialogs.js";
import { dataLayer } from "../data/data-layer.js";
import { renderNote } from "./note-editor.js";
import { loadNoteHeaders } from "./note-list.js";
import { setCurrentNote, setIntendedNote, setLoggedIn, state } from "./state.js";

/** Call this when the state of the application should change to "not logged in". */
export function stateUpdateForLogout() {
    setLoggedIn(false);
    state.noteHeaders = [];
    setCurrentNote(null);
    setIntendedNote(null);
    state.continuationKey = null;
    state.isLoadingNotes = false;
    state.searchDebounceTimer = null;
    state.unfocusedEditsPending = false;
    clearTimeout(state.unfocusedEditDebounceTimer);
    state.unfocusedEditDebounceTimer = null;
    state.trashView = false;
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

/** Logs out by calling the server to clear the cookie, then updates UI. */
async function logout() {
    try {
        await apiFetch(`${getApiBaseUrl()}/api/v1/user_logout`, { method: "POST" });
    } catch (_err) {
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
    } catch (_err) {
        showInlineAlert("#login-alert", "form.login-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        await stateUpdateForLogin();
        return;
    }
    showInlineAlert("#login-alert", "form.login-form", await extractErrorMessage(response));
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
    } catch (_err) {
        showInlineAlert("#login-alert", "form.login-form", FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (response.ok) {
        await stateUpdateForLogin();
        return;
    }
    showInlineAlert("#login-alert", "form.login-form", await extractErrorMessage(response));
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

/** Handles the "back" button click in the user shadow box by dismissing it. */
function actionCloseUserShadowboxBtn() {
    hideShadowBox("user-display-dialog");
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
    } catch (_err) {
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
function actionForgotPasswordLink(event) {
    event.preventDefault();
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
    } catch (_err) {
        // The API returns 204 in every "expected" case, so a thrown error
        // here means a network failure or similar. Per the indistinguishable-
        // response design, we close the dialog without surfacing it.
    }
    hideShadowBox("forgot-password-dialog");
}

/** Registers the listeners for login and the user dialogs. */
export function registerAccountListeners() {
    document.querySelector("#user-btn").addEventListener("click", actionUserBtn);
    document.querySelector("#login-btn").addEventListener("click", actionLoginBtn);
    document.querySelector("#new-account-btn").addEventListener("click", actionNewAccountBtn);
    document.querySelector("#close-user-shadowbox-btn").addEventListener("click", actionCloseUserShadowboxBtn);
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
}
