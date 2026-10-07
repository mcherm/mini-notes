/**
 * Alert and progress display shared by every page: inline-alerts (a message
 * in a fixed spot, usually within a form), the floating-alert queue, and
 * progress-boxes.
 */

/**
 * Tracks the auto-clear input listener (if any) attached to each
 * inline-alert by showInlineAlert. Keyed by the alert element so we can
 * detach the listener again from clearInlineAlert.
 */
const _inlineAlertAutoClear = new Map();

/**
 * Fills an inline-alert with its message and a close button that
 * dismisses it.
 */
function fillInlineAlert(alert, message) {
    const messageElem = document.createElement("inline-alert-message");
    messageElem.textContent = message;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "close";
    closeButton.setAttribute("aria-label", "Dismiss");
    closeButton.textContent = "\u2715";
    closeButton.addEventListener("click", actionInlineAlertClose);
    alert.append(messageElem, closeButton);
}

/** Dismisses the inline-alert whose close button was clicked. */
function actionInlineAlertClose(event) {
    clearInlineAlert(`#${event.currentTarget.closest("inline-alert").id}`);
}

/**
 * Displays a message in an inline-alert and arranges for it to clear
 * itself the next time the user types in the surrounding form. The
 * listener is attached only while a message is shown and removes itself
 * after firing once — no per-keystroke work in the common case where no
 * error is displayed.
 *
 * alertSelector: the inline-alert element to write to. Eg. "#login-alert"
 * formSelector:  the form (or other ancestor) on which to listen for
 *                input bubbling up from any field within it.
 */
export function showInlineAlert(alertSelector, formSelector, message) {
    clearInlineAlert(alertSelector);
    const alert = document.querySelector(alertSelector);
    fillInlineAlert(alert, message);
    if (formSelector) {
        const form = document.querySelector(formSelector);
        const onInput = () => {
            alert.textContent = "";
            form.removeEventListener("input", onInput);
            _inlineAlertAutoClear.delete(alert);
        };
        form.addEventListener("input", onInput);
        _inlineAlertAutoClear.set(alert, { form, onInput });
    }
}

/**
 * Clears an inline-alert and removes any auto-clear input listener
 * previously attached by showInlineAlert.
 */
export function clearInlineAlert(alertSelector) {
    const alert = document.querySelector(alertSelector);
    const tracked = _inlineAlertAutoClear.get(alert);
    if (tracked) {
        tracked.form.removeEventListener("input", tracked.onInput);
        _inlineAlertAutoClear.delete(alert);
    }
    alert.textContent = "";
}

/** Queue of alerts; first one is visible */
const floatingAlertMessages = [];

/**
 * Updates the <floating-alert>'s text from the message queue. The
 * structural children (top row, dots, close button, message) live
 * statically in the HTML; this only writes textContent. When the queue
 * is empty the message is cleared, and the CSS `:has(message:empty)`
 * rule hides the alert.
 */
function renderFloatingAlert() {
    const dots = document.querySelector("floating-alert-dots");
    const message = document.querySelector("floating-alert-message");
    if (floatingAlertMessages.length === 0) {
        dots.textContent = "";
        message.textContent = "";
        return;
    }
    // One dot per additional queued message (i.e. one fewer than the queue length).
    dots.textContent = "⚫ ".repeat(floatingAlertMessages.length - 1);
    message.textContent = floatingAlertMessages[0];
}

/** Adds a message to the floating-alert queue and re-renders. */
export function showFloatingAlert(message) {
    floatingAlertMessages.push(message);
    renderFloatingAlert();
}

/** Removes the first queued message (called from the close button). */
function dismissFloatingAlert() {
    floatingAlertMessages.shift();
    renderFloatingAlert();
}

/** Empties the floating-alert queue. Used on logout / full UI refresh. */
export function clearAllFloatingAlerts() {
    floatingAlertMessages.length = 0;
    renderFloatingAlert();
}

/**
 * Event-delegated handler for the close button inside floating-alert.
 * The button is rebuilt on every renderFloatingAlert, so we listen on
 * the (long-lived) <floating-alert> element and inspect the click target.
 */
function actionFloatingAlertClick(event) {
    if (event.target.closest("button.close")) {
        dismissFloatingAlert();
    }
}

/**
 * Displays a progress message in a progress-box (default state — hourglass icon).
 * Removes any prior .complete state. Accepts either a CSS selector or the
 * progress-box element directly (useful for bulk operations).
 */
export function showProgressBox(box, message) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.remove("complete");
    el.textContent = message;
}

/**
 * Marks a progress-box as complete: replaces the hourglass icon with a
 * checkmark and updates the text to the completion message. Accepts either
 * a CSS selector or the progress-box element directly.
 */
export function completeProgressBox(box, message) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.add("complete");
    el.textContent = message;
}

/** Clears a progress-box and removes any state class. Accepts either a
 * CSS selector or the progress-box element directly. */
export function clearProgressBox(box) {
    const el = typeof box === "string" ? document.querySelector(box) : box;
    el.classList.remove("complete");
    el.textContent = "";
}

/** Registers listeners for the alert elements present on the page. */
export function registerAlertListeners() {
    document.querySelector("floating-alert")?.addEventListener("click", actionFloatingAlertClick);
}
