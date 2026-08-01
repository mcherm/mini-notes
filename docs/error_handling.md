# Error Handling

This document describes the four-pattern frontend error display system and the conventions on both the frontend and backend that support it.

## Goals

- Every API call site that can fail should communicate that failure to the user in a way appropriate to where the failure happened.
- The frontend's UI should not lock waiting for backend responses; the error display mechanism must handle the case where the originating UI is no longer on screen when the error arrives.
- The user-facing error text should be written intentionally for users — not developer-facing technical strings.

## The four patterns

Each pattern is realized by one or two custom elements. All of them share a single visual vocabulary (tinted background, solid border, icon, centred text) defined in `html/main.css`.

### Pattern 1 — In-form alert

**Element:** `<inline-alert>` placed inside the form.

**When to use:** the user is on a form whose result they are unavoidably waiting for (e.g. the form *is* the page, with nowhere else to navigate).

**Sites:**
- Login (`#login-alert` inside `<login-form>`)
- Create account (same element as login — the form has two submit buttons)
- Set new password on the password-reset page (`#reset-alert` inside `<reset-form>`)

**Behaviour:**
- On submission failure, the alert displays the backend's error string. The form remains usable.
- The alert auto-clears the next time the user types in any field of the form (via a one-shot input listener attached in `showInlineAlert` and detached on first fire).

### Pattern 2 — Content-area indicator

**Element:** `<inline-alert>` placed inside the area whose content failed to load.

**When to use:** an area of the UI is meant to display loaded data and the load failed. The user passively observed the failure; there is nothing specific they were "submitting."

**Sites:**
- Note list area (`#note-list-alert`, sibling of `<note-list>` inside `<nav>`) — covers initial load, search, trash view, and pagination
- Note pane (`#note-pane-alert` inside `<article id="note">`) — fires when opening a specific note fails
- Dialog body (`#user-info-alert` inside `<user-area>`; `#site-data-alert` inside `<site-data-area>`) — fires when the dialog's data load fails

**Behaviour:**
- For refresh loads, the list/area's stale content is cleared and the alert appears in its place; the empty-list message is *not* shown (it would imply a successful zero-result load).
- For pagination loads (`continueKey` is set), existing items stay and the alert appears at the bottom; the IntersectionObserver retries on the next scroll-triggered intersection.
- For the note pane: clicking a slug clears the pane immediately, then either populates the new note on success or shows the alert on failure. An `intendedCurrentNoteId` guard discards stale results if the user clicks a different slug mid-flight.
- The alert clears at the start of the next attempt for the same area, and on logout (via `stateUpdateForLogout`).

### Pattern 3 — Floating-alert toast

**Element:** `<floating-alert>` — a single, statically-declared element at the body level inside `<active-area>`. JS maintains a message queue and updates two text slots within it.

**When to use:** an operation fires asynchronously and the user is free to navigate. The toast is the safety net regardless of whether the originating UI is still visible.

**Sites:**
- Request password reset email (only on network / 5xx — the backend returns 204 for all "could-have-succeeded" cases by design)
- Create note
- Save edits (all non-409 cases; 409 is the conflict path, handled separately)
- Delete note, restore note, destroy permanently (optimistic — see below)
- Edit user email/password

**Behaviour:**
- The element shows only the *head* of the queue. Additional queued messages are represented by indicator dots in the top row (one dot per additional queued message); the dots row uses `overflow-x: hidden`, so very long queues just truncate visually rather than widening the toast.
- The user dismisses each toast individually via the `✕` button in the top row; dismissing advances the queue.
- Position: bottom-left of `<active-area>` (which centres horizontally with the same `max-width` as the body-content, so the alert sits flush with the app's left edge).
- The toast is fully cleared (queue emptied) on logout, via `stateUpdateForLogout` → `clearAllFloatingAlerts`.
- Hidden when the message slot is empty via `floating-alert:has(floating-alert-message:empty) { display: none; }`.

**Optimistic UI for destructive operations (delete / restore / destroy note):**
The local UI update happens synchronously before the API call. On failure, the toast is the *only* signal — the UI does not roll back. The note will reappear on the next refresh if the server didn't actually perform the operation.

### Pattern 4 — Inline workflow status

**Element:** `<progress-box>` plus a sibling `<inline-alert>` in the same dialog.

**When to use:** the operation is itself a workflow that the user explicitly stays on the form/dialog to watch through. Both success and failure are reported inline.

**Sites:**
- Delete account (`#delete-user-progress` + `#delete-user-alert` inside `<user-delete>`)
- Import notes (`#import-progress` + `#import-alert` inside the `import-export` settings panel)

**Behaviour:**
- On start: `showProgressBox(..., "Deleting…")` / `showProgressBox(..., "Importing…")` — default state, hourglass icon.
- On success: `completeProgressBox(..., "Done deleting.")` / `completeProgressBox(..., "Done: 3 created, 1 updated.")` — `.complete` class added, hourglass replaced by checkmark.
- On failure: `clearProgressBox(...)` + `showInlineAlert(...)` — progress box vanishes, error alert appears in its slot.
- Delete-account specifically: after the "Done deleting." confirmation displays for 500ms, the user is logged out.

## Cross-cutting conventions

### Backend owns user-facing copy

The `{"error": "<string>"}` envelope returned by every non-2xx API response is the source of truth for what the user sees. The frontend displays the `error` field verbatim. There is no per-site mapping table on the frontend.

The frontend has exactly one fallback string, used when there is no parseable body (network failure, gateway error page, malformed response):

```js
const FALLBACK_ERROR_MESSAGE = "Error in operation.";
```

`data-layer.js` makes that split explicit in the results it returns: `errorMessage` carries the backend's copy and is null when the server did not answer, while `failureDetail` carries a diagnostic description — the HTTP status, or the browser error behind a request that never completed — which is logged and passed up but not displayed. A caller seeing a null `errorMessage` supplies its own wording: `FALLBACK_ERROR_MESSAGE`, or something more specific such as "Failed to save changes to note."

### Backend 500 messages

Where the failure condition is distinctive enough to be useful information for the user (or for support diagnosis), 500 responses carry a specific descriptive string — e.g. `"Unable to delete note"`, `"Password verification error"`, `"Update note failed"`. Where the condition is genuinely uninformative — typically a `DynamoDB SDK` error that could mean almost anything — the response uses the shared constant from `lambdas/api-v1/src/handlers/common.rs`:

```rust
pub const SERVER_ERROR_MESSAGE: &str = "Server error.";
```

Either way, the technical detail (`%err`) is captured via `tracing::info!()` so CloudWatch still has it.

### Cache-Control: no-store

A `tower_http::set_header::SetResponseHeaderLayer` in `lambdas/api-v1/src/main.rs` adds `Cache-Control: no-store` to every API response. Notes can change at any moment from another tab or device, so any HTTP caching is a correctness hazard — not just a performance concern. This also ensures that Firefox's "Work Offline" devtools mode produces real network errors instead of serving cached responses.

### 401 short-circuit

`apiFetch` in `api.js` (and the copies in `admin.js`, `reset-password.js`) intercepts 401 responses, calls the handler registered with `setSessionExpiredHandler` — `stateUpdateForLogout()`, registered by `main.js` — and throws `LoggedOutError`. Every error-handling site catches `LoggedOutError` and exits silently — the logout flow handles the UI, and surfacing an additional error message would just be noise.

```js
try {
    response = await apiFetch(url, options);
} catch (e) {
    if (e instanceof LoggedOutError) return;
    showFloatingAlert(FALLBACK_ERROR_MESSAGE);
    return;
}
```

## JS helpers

`FALLBACK_ERROR_MESSAGE` and `extractErrorMessage` live in `html/api.js`; the display helpers live in `html/main.js`. Both sets are duplicated for `admin.js` and `reset-password.js`, which are separate-page contexts.

| Helper | Purpose |
|---|---|
| `FALLBACK_ERROR_MESSAGE` | The single frontend fallback string. |
| `extractErrorMessage(response)` | Reads the backend's `error` field from a non-OK response; falls back to `FALLBACK_ERROR_MESSAGE`. |
| `showInlineAlert(alertSelector, formSelector, message)` | Shows an `<inline-alert>`. If `formSelector` is non-null, attaches a one-shot input listener that auto-clears the alert on the next keystroke in any field of that form. |
| `clearInlineAlert(alertSelector)` | Clears an `<inline-alert>` and removes any auto-clear listener. |
| `showProgressBox(boxOrSelector, message)` | Shows a `<progress-box>` in default (hourglass) state. |
| `completeProgressBox(boxOrSelector, message)` | Updates a `<progress-box>` to completion (checkmark) state. |
| `clearProgressBox(boxOrSelector)` | Empties a `<progress-box>` and removes the `.complete` class. |
| `showFloatingAlert(message)` | Appends a message to the floating-alert queue and re-renders. |
| `dismissFloatingAlert()` | Removes the head of the queue (called by the ✕ button via event delegation). |
| `clearAllFloatingAlerts()` | Empties the queue. Called by `stateUpdateForLogout`. |

Don't direct-manipulate the alert / progress-box elements. Always go through the helpers; they encapsulate the auto-clear listener lifecycle, the queue management, and the structural assumptions.

## Wiring a new error site

For most new API call sites the recipe is:

```js
async function someAction() {
    // (Synchronous UI update first, for optimistic operations.)

    let response;
    try {
        response = await apiFetch(url, options);
    } catch (e) {
        if (e instanceof LoggedOutError) return;
        // Network/exception path — no parseable response body.
        showXxx(/* … */, FALLBACK_ERROR_MESSAGE);
        return;
    }
    if (!response.ok) {
        // HTTP error path — backend supplied a message.
        showXxx(/* … */, await extractErrorMessage(response));
        return;
    }
    // Success path.
}
```

Pick the display pattern based on where the failure happens:

| Situation | Pattern |
|---|---|
| User just submitted a form they're stuck on (auth-style) | 1 — `<inline-alert>` inside the form |
| Loading data into a content area, search results, etc. | 2 — `<inline-alert>` inside that area |
| Background / fire-and-forget operation where the user has moved on | 3 — `<floating-alert>` toast |
| Workflow the user is explicitly watching through (delete account, import) | 4 — `<progress-box>` + `<inline-alert>` |

For Pattern 4 specifically, the success path also goes through `completeProgressBox`. For Pattern 3 with destructive operations, do the local UI update *before* the `await apiFetch` so the user-perceived response is instant.
