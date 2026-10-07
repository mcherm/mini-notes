/**
 * Dialog and form behavior shared by every page: shadow-box modals, and the
 * suppression of implicit form submission.
 */

const shadowBoxDismissCallbacks = new Map();

/** Shows a shadow-box modal by id. onDismiss is called when the box is dismissed. */
export function showShadowBox(id, onDismiss) {
    const el = document.getElementById(id);
    el.style.display = "flex";
    if (onDismiss) {
        shadowBoxDismissCallbacks.set(id, onDismiss);
    }
}

/** Hides a shadow-box modal by id, invoking its dismiss callback if one was registered. */
export function hideShadowBox(id) {
    const el = document.getElementById(id);
    el.style.display = "none";
    const callback = shadowBoxDismissCallbacks.get(id);
    if (callback) {
        shadowBoxDismissCallbacks.delete(id);
        callback();
    }
}

/** Handles a click on a shadow-box; dismisses it if the click was on the backdrop. */
function actionDismissShadowBox(event) {
    if (event.target === event.currentTarget) {
        hideShadowBox(event.currentTarget.id);
    }
}

/**
 * Invoked when a form is submitted, it does nothing. The reason this exists is to block the
 * implicit form submission that is default HTML behavior. In this application, all calls to
 * the server are performed by JavaScript.
 */
function actionFormSubmit(event) {
    event.preventDefault();
}

/**
 * Registers listeners for every form and shadow-box on the page: forms never
 * submit, and a click on a shadow-box's backdrop dismisses it.
 */
export function registerDialogListeners() {
    document.querySelectorAll("form").forEach(form => {
        form.addEventListener("submit", actionFormSubmit);
    });
    document.querySelectorAll("shadow-box").forEach(sb => {
        sb.addEventListener("click", actionDismissShadowBox);
    });
}
