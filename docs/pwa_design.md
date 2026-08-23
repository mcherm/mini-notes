# PWA Design

This document describes how Mini-Notes behaves as an installable Progressive Web App: what is cached, how it is cached, and how updates are delivered. It is organized into sections, each covering one part of the offline/PWA story. This first section covers the **app shell**. Later sections will cover the local data store and synchronization.

## App Shell Caching

The "app shell" is the set of static frontend assets that make up the core Mini-Notes application. This section describes how the service worker caches them so the app loads instantly and runs offline, and how new versions are delivered reliably.

### Goals

- The core application runs fully offline, served from a local cache rather than the network.
- Shell assets can be cached effectively forever; correctness never depends on the browser revalidating them over the network.
- There is a reliable mechanism to push a new version of the shell to users, including the ability to *force* an update when the backend changes in a way the old frontend cannot tolerate.
- An offline device degrades gracefully: a missed update is never fatal; the device keeps running the version it already has until it is next online.

### What is cached

The app shell currently consists of these assets, all served from the site root:

- `index.html`
- `main.css`
- `main.js`
- `api.js`
- `commands.js`
- `data-layer.js`
- `diff.js`
- `store.js`
- `manifest.json`
- The six icons: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `mini-notes-192x192.png`, `mini-notes-512x512.png`

The canonical, machine-read form of this list is `html/shell-assets.txt` (one path per line). The deploy both hashes the listed files and stamps the list into `sw.js` — see the build/deploy section below — so the list is maintained in exactly one place.

Explicitly **not** part of the app shell:

- `admin.html` / `admin.css` / `admin.js` — an online-only operational tool. No offline support.
- `reset-password.html` / `reset-password.css` / `reset-password.js` — reached from an email link and inherently requires the backend to verify a token. No offline support.
- `sw.js` — the service worker script is **never** placed in any cache. It is the one uncached bootstrap file (see below).

One known interaction: both excluded pages link `main.css`, which *is* a shell asset. When the service worker controls those pages it serves them the cached copy of `main.css`, so between deploys they may briefly pair a fresh HTML page with a slightly older stylesheet. This is accepted; everything else on those pages comes from the network (see the fetch handler below).

### Two independent version concepts

Two different version numbers are in play. Keeping them distinct avoids confusion:

1. **Asset version** — identifies *which build of the shell* is installed. It is a content hash of the shell assets, stamped into `sw.js` at deploy time, and is used to name the cache (`app-shell-<asset-version>`). It governs only frontend asset freshness.

2. **Service version** — identifies *which backend contract the frontend was built against*. It lives inside a shell asset (`main.js`) and is sent on every backend request (see the separate handshake; documented elsewhere). It governs whether an old frontend may talk to a redeployed backend.

The two are independent, but coupled in one direction: because the service version lives in `main.js`, refreshing the app shell automatically upgrades the service version as well. A backend-incompatibility forced refresh therefore works by forcing a shell refresh.

### Cache versioning

The shell cache is versioned and all-or-nothing. A single content hash covering every shell asset is computed at deploy time and stamped into `sw.js`, e.g.:

```js
const ASSET_VERSION = '<content-hash>';
const CACHE_NAME = 'app-shell-' + ASSET_VERSION;
```

Because the cache is all-or-nothing on activation, one combined hash for the whole shell is sufficient; per-asset hashes are not needed. "Bumping the version" is not a manual act — it happens automatically whenever any shell asset's bytes change, because the hash changes.

**Known limitation (accepted):** the hash *names* the cache, but nothing verifies that the bytes fetched at install time actually match it. If a deploy lands in the window between the browser fetching `sw.js` and the install fetches completing — or while a CloudFront invalidation is still propagating across edge nodes — the cache can end up holding a mix of old and new assets under a single version name, and it will be treated as valid until the next deploy changes the hash. The window is seconds wide, deploys are performed by one person, and a mixed shell would at worst misbehave until the following deploy heals it. Verifying per-asset hashes during install would close the gap but was judged disproportionate complexity for this project.

### Service worker lifecycle

- **install** — open `app-shell-<asset-version>` and populate it with the shell assets. Each asset is fetched with `{cache: 'reload'}` so the fetch bypasses the browser's HTTP cache and pulls the freshly deployed bytes from the network. This closes the trap where a new cache version is filled with stale assets out of the HTTP cache. Population is all-or-nothing (`cache.addAll` or equivalent): if any single fetch fails, the whole install fails and nothing is kept. That failure is safe — the previous service worker and its cache remain in place and in control, and the browser simply retries the install at the next update trigger.
- **activate** — delete every cache whose name starts with `app-shell-` but does not match the current `app-shell-<asset-version>`. This is the cleanup of superseded shells; caches under other names are left alone, since other features (such as the future note data store) may own caches of their own.
- **fetch** — the handler is an **allowlist**, not a catch-all. Requests for known shell assets are served cache-first: return the cached response without touching the network. If the entry is unexpectedly missing — browsers may evict Cache Storage under storage pressure — fall back to fetching from the network rather than failing. Navigation requests to `/` (and `/index.html`) are served the cached `index.html`. Every other request — `admin.html`, `reset-password.html` and their css/js, API calls, and anything unrecognized — is passed through to the network untouched. (The service worker's scope covers the whole origin, so it *sees* requests for the excluded pages; it must never answer a navigation to them with `index.html`. `reset-password.html` in particular is reached from an email link and must always come from the network.)

To make eviction unlikely in the first place, the app requests persistent storage once via `navigator.storage.persist()`. This will matter even more for the note data (later section), which lives in the same evictable storage bucket as the shell cache.

### Update detection

The app relies on the browser's **natural** update triggers and does not routinely call `registration.update()` (the one exception is the forced-refresh routine below, which calls it explicitly):

- The browser re-fetches `sw.js` on every navigation into the app's scope (subject to throttling). Launching the installed PWA counts as a navigation, so every app launch is an update check.
- There is **no** background timer: a window that stays open without navigating is never checked. This is deliberate — a user who isn't interacting with the page shouldn't have it updated out from under them. A stale-but-working shell is acceptable, and the forced-refresh routine (below) covers the one case where an update is mandatory.

On each such check the browser byte-compares the fetched `sw.js` against the installed one. Identical → nothing happens. Different → the new service worker installs. A stamped content-hash change in `sw.js` is therefore what cascades into rebuilding the cache.

If an update check fails (e.g. the device is offline), it fails silently: the already-installed service worker stays active and in control, the app keeps running from the existing cache, and the browser simply retries at the next trigger. There is no penalty for a failed check.

### Cache-Control / HTTP headers

There are two caches between the app and the origin: the service worker's Cache Storage (designed above) and the browser's ordinary HTTP cache. The HTTP cache matters in these places:

- **`sw.js` is served `Cache-Control: no-cache`** ("always revalidate," not "never store"). Modern browsers already bypass the HTTP cache when fetching `sw.js` for an update check (`updateViaCache` defaults to `'imports'`), so this header is a safety net rather than the primary mechanism: it covers older browsers, and it caps staleness anywhere the default doesn't apply. It costs nothing and removes a whole class of "why isn't the new version showing up" problems.
- **Shell assets** need no special headers *once the service worker is in charge*, because it fetches them with `{cache: 'reload'}` at install time, bypassing the HTTP cache.
- **HTML pages and the online-only pages' assets are served `Cache-Control: no-cache`** — that is `index.html`, `admin.html`, `reset-password.html`, plus `admin.css`/`admin.js` and `reset-password.css`/`reset-password.js`. These are exactly the requests the service worker does *not* answer from its cache: the first-ever visit, and every visit to the excluded pages. Without an explicit header, browsers apply heuristic caching (typically 10% of the file's age since `Last-Modified`) and can serve a stale `admin.html` for days after a deploy — a CloudFront invalidation flushes the CDN but never reaches browsers' HTTP caches.

CloudFront staleness is a non-issue: `just deploy-frontend` already issues a CloudFront `/*` invalidation on every deploy, so the CDN is flushed each time. The only remaining actor is each browser's HTTP cache, fully handled by the points above.

### Forced refresh on service-version mismatch

When the backend rejects a request because the client's service version is too old, the frontend must perform a *forced* refresh — not a polite "new version available, reload?" prompt. This is driven entirely by application code.

> **Implementation status:** the page-side routine described here is deliberately **not yet implemented**, because its trigger does not exist: the backend does not yet send a service version or reject requests over it. It will be implemented together with that server-side handshake. The service worker's supporting pieces (the `skipWaiting` message handler and `clients.claim()` on activate) are already in place.

A plain `location.reload()` is **not** sufficient, for two reasons. First, there may be no new service worker available yet: update checks happen only on navigation, so a long-lived session may not have noticed the deploy at all. Second, even if a new worker is sitting in the waiting state, a reload simply re-serves the old assets from the old cache.

One thing the routine must **never** do is delete caches by hand. The lifecycle already guarantees safety: the new worker's install builds a complete new cache before the worker becomes eligible to activate, and its activate deletes the superseded caches — so there is no moment without one fully populated shell cache. If page code deleted the current cache before a new worker had successfully installed, any failure after that point (network drop, install error) would leave the app with no working shell at all.

The forced-refresh routine:

1. Call `registration.update()` to check for a new `sw.js` immediately, and wait for the new worker to reach the *installed* (waiting) state. At that point its cache is fully populated.
2. Send the waiting worker a message telling it to call `skipWaiting()` — page code cannot invoke that directly. (The worker's activate handler calls `clients.claim()` so it takes control of the open page instead of waiting for all tabs from the old version to close.)
3. Wait for the `controllerchange` event, then `location.reload()`. The page now loads from the freshly cached, compatible shell.

Failure modes are defined, not accidental:

- **Offline, or the update check finds nothing new** (e.g. the backend was redeployed minutes before the new frontend propagated): do not reload — that would just re-run the old shell. Show a "required update not available yet — will retry" state and re-attempt later.
- **Loop guard:** if a forced refresh completes but the backend *still* rejects the service version, do not force another refresh immediately; fall back to the retry state above. This prevents an infinite reload loop during a deploy window.

In short: **reload ≠ refresh.** Forcing an update means fetching and installing the new worker, promoting it to active, and only then reloading — never clearing caches manually.

This same machinery also applies when (in the future) the app wants to apply a normal, non-forced update promptly; the difference is only whether the user is prompted first.

### Build / deploy changes

A new **stamping step** must be inserted into the frontend deploy path (currently `just deploy-frontend`, which is a raw `aws s3 sync html/ --delete` plus a CloudFront `/*` invalidation). Stamping happens in a **staging directory**, never in `html/` itself: the source tree contains only sources, deploys never mutate a checked-in file, and derived artifacts live under `target/` — the same pattern the Lambda zips follow.

Two values are stamped into `sw.js`: `ASSET_VERSION` (the content hash) and `SHELL_ASSETS` (the asset list, read from the canonical `html/shell-assets.txt`). The checked-in `html/sw.js` carries placeholders:

```js
const ASSET_VERSION = "dev";
const SHELL_ASSETS = [];
```

An unstamped `sw.js` therefore caches nothing: serving `html/` directly on a local machine still runs the app, but always from the network. This is deliberate — local serving never fights a stale service-worker cache, and offline/caching behavior is tested against the dev stage (or a stamped staging copy under `target/`), which exercises the real deploy path.

The deploy steps:

1. Delete and re-create the staging directory (under `target/`), then copy `html/` into it. Starting fresh each time ensures no stale files from a previous deploy survive.
2. Read the shell asset list from `shell-assets.txt`, compute a content hash over those files, and rewrite `ASSET_VERSION` and `SHELL_ASSETS` in the **staging copy** of `sw.js`, failing the deploy if either stamp did not take effect.
3. Sync the staging directory to S3, ensuring `sw.js`, the HTML pages, and the online-only pages' assets are served with `Cache-Control: no-cache` (see the headers section above).
4. Invalidate CloudFront (already done today).

The existing up-to-date check (skip the deploy when nothing under `html/` is newer than the sentinel) continues to work unchanged, since the deploy writes nothing into `html/`.

## Note Data Caching

> **Implementation status:** this section is partly implemented. The backend
> changes below are done. The data-access interface (`html/data-layer.js`),
> the diff generator (`html/diff.js`), and the local store (`html/store.js` —
> the mirror and the update queue, with the read barrier) all exist. Feature
> detection at startup selects the offline or passthrough implementation; in
> offline mode every successful server response is written through to the
> mirror, and the mirror is wiped at logout and on a rejected session. The
> read path is complete: when the server is unreachable, get-notes,
> get-deleted-notes, get-note and search-notes are served from the mirror
> (lists and search answer in a single page); get-note races the server
> against a timeout and serves the mirrored copy when it expires
> (Mechanism 1); and the Mechanism 3 background refresh runs at launch,
> after login, and hourly while the app is visible — it is also what
> populates an empty mirror. The write path is complete: every
> offline-capable write is applied to the mirror and appended to the queue
> in one transaction (`html/commands.js` holds the per-command field logic;
> new-note ids are client-generated), enqueueing triggers a delivery pass
> that sends the queued commands in order — one in flight, stopping at the
> first transient failure — and the write's promise reports delivered,
> queued, or rejected as designed. The sync engine's retry loop
> (`html/sync-engine.js`) is in place: the Web Locks election (offline mode
> now requires the API), the exponential backoff, its reset on the `online`
> event, app launch, and enqueue, and the hourly idle recheck; a rejected
> session wipes local data through the existing forced-logout path. The
> removal fix-up pass is in place: removing a definitively failed command
> repairs the later queued commands for its note, and the note's mirror
> entry is evicted only when no later commands remain. The conflict
> fix-up pass is in place as well: a queued command answered with a 409
> re-addresses the note's later queued commands and its mirror entry to
> the conflict note the server returned, and the UI follows an open note
> to its conflict note — a background conflict is also announced with a
> floating alert. Not yet implemented, from "Delivering Delayed
> Updates": there is no poisoned-command detection.

### Goals

The goal is that users can continue to perform normal note viewing and note editing work with a spotty connection or a fully inactive connection and it will correct itself as soon as a connection can be re-established. Specialized operations, like editing a user's properties do not need to be supported whie offline.

Offline note storage must work across a range of environments (iOS Safari, Firefox on Android, assorted desktop browsers). Where an environment does not support the needed local storage, the app degrades to working online-only rather than failing. This has an architectural consequence: UI code must not talk to local storage (or the network) directly, but through a single data-access interface. Behind that interface sit two implementations — the full offline store, or a passthrough straight to the network — selected by feature detection at startup. Designing this seam in from the start is cheap; retrofitting it later would not be. A related constraint: nothing may depend on the Background Sync API (Chromium-only); all sync activity is driven from page code.

### Where the Layer Lives

The offline data layer is **page-level application code**: UI code calls the data-access interface, which reads and writes local storage and the network. The service worker is not involved — it remains exactly what the App Shell section made it, an app-shell cache whose fetch handler passes API requests through untouched. All sync activity (queue draining, background refresh) is triggered from page code. The Web Locks API is used so that exactly one tab runs the queue-draining sync engine no matter how many tabs are open; like the rest of the storage stack, it is feature-detected, and environments without it degrade to online-only. Tabs are not otherwise notified of each other's changes: a tab refreshes from the local store on the existing visibility-change trigger (no `BroadcastChannel`).

### Feature Detection

The choice between the two implementations is made at each app launch, by trying the storage rather than asking about it: the data layer attempts to open the `IndexedDB` database and perform a trivial write. If that succeeds, the offline implementation is used for the session. If it fails (or the needed APIs are absent — e.g. private-browsing modes, restricted WebViews), the session runs in "no-offline-support" mode: writes go directly to the server with no queuing, and reads simply fail when the server is unavailable. The choice is not revisited mid-session; an environment that gains storage support picks up offline mode at the next launch.

### List of Commands

Here is a pair of tables listing all the read-only commands and the write commands marking which commands need to be supported for offline operations and which do not.

| Read Command            | Offline Use |
|-------------------------|-------------|
| get-notes               | Yes         |
| get-note                | Yes         |
| get-deleted-notes       | Yes         |
| export-notes            | No          |
| search-notes            | Yes         |
| get-user                | No          |
| get-user-detail         | No          |
| site-data               | No          |
| users-detail            | No          |


| Write Command           | Offline Use |
|-------------------------|-------------|
| new-note                | Yes         |
| edit-note               | Yes         |
| delete-note             | Yes         |
| recover-deleted-note    | Yes         |
| destroy-deleted-note    | No          |
| import-notes            | No          |
| delete-user             | No          |
| user-edit               | No          |
| user-login              | No          |
| user-logout             | No          |
| user-create             | No          |
| send-password-reset     | No          |
| complete-password-reset | No          |

### Device Data Storage

I expect to store two things on the device. I will store a complete list of all of the notes (see below for the specific fields stored). This will be stored using `IndexedDB`. And I will store a list of the queued updates not yet sent to the server. This also lives in `IndexedDB`, as a second object store in the same database as the notes, so a single transaction can update a note and the queue atomically. The queue's primary key is a monotonically increasing sequence number (the order in which the updates are to be applied), with a secondary index on `note_id` (which note each update affects).

Storing the full note information seems reasonable, given typical note sizes and typical device capabilities. If that proves to be a problem we could revisit the option of storing only the most recently used notes on the device.

**Known limitation (accepted):** despite the `navigator.storage.persist()` request, the browser may still evict this storage under pressure; if that happens, any queued-but-unsent edits are lost.

**Known limitation (accepted):** the local layer does not replicate the server's `[CONFLICTED]`-copy behavior. If two tabs edit the same note while offline, the result is last-write-wins rather than a conflict copy. (The overwritten text remains reachable via the note's undo history, since each replayed edit still generates an undo diff.) Online, the server's conflict handling applies as usual.

Logging out wipes all local note data: both the mirror and the queue are deleted. Any unsent changes in the queue are lost, with no warning. (A possible future feature is to warn the user at logout when the queue is non-empty.) The same wipe applies when the server rejects the session as invalid — the user is effectively logged out, and pending edits are lost, which is accepted.

The wipe rules above guarantee that local note data exists only if a user was logged in when the device was last online. An offline app launch therefore treats the presence of the local database as an authenticated session and opens the mirror; the session is validated against the server whenever connectivity returns, and a rejection triggers the wipe described above.

#### Queue Records and Indexing

Each queue record has the shape `{ update_queue_seq, note_id, command_type, payload, source_version_id }`, where `update_queue_seq` is the auto-incrementing primary key and `note_id` is a top-level field so a secondary index can be built on it. (Because `new-note` ids are client-generated, every offline-capable write command has a real `note_id` at enqueue time.) The queue is accessed two ways — by delivery order (the `update_queue_seq` primary key) and by note (the `note_id` index) — and these cover every operation performed on it:

1. **Next command to deliver** — a cursor on the primary key; the first record is the head of the queue. *(primary key)*
2. **Remove a delivered/failed command** — delete by `update_queue_seq`. *(primary key)*
3. **Does note X have pending commands?** — an existence check, `index.count(X) > 0`. This is the read-barrier test: a server read (Mechanism 1 or Mechanism 3) writes a note into the mirror only if this count is zero; otherwise the note is skipped entirely, since local state plus its queued commands is ahead of the server. *(note_id index)*
4. **All pending commands for note X, in order** — a cursor over the index range for X, used by the fix-up passes (see Delivering Delayed Updates). The failed head is removed before a fix-up pass runs, so "all remaining" and "all later" commands for X are the same set; and within one index key, IndexedDB iterates in primary-key order, so the cursor walks them in queue order. *(note_id index)*
5. **Was that the last pending command for note X?** — the same existence check as #3, run after removing a delivered command, to decide whether the server's returned note may be written to the mirror. *(note_id index)*

The read-barrier check (#3, #5) and the mirror write it guards are performed in a single IndexedDB transaction spanning both object stores, so no command can be enqueued between the check and the write.

### The Read Path

When the server is unreachable, the offline-capable read commands are served from the mirror: `get-notes` and `get-deleted-notes` return the mirrored active and trashed notes, and `get-note` returns the mirrored note. `search-notes` offline is a client-side search over the mirrored notes' titles and bodies — a second, JavaScript implementation of the search semantics. Fetching a note at the start of an edit is governed by Mechanism 1 (see Updating Device Data).

### The Write Path

Every offline-capable write command goes through a single path — there is no separate "try the server directly, and fall back to the queue if that fails" logic. A write is committed by updating the local mirror and appending the command to the queue in one IndexedDB transaction. If that transaction fails, nothing was committed and the write is rejected. Because enqueueing a command triggers an immediate delivery attempt (see Delivering Delayed Updates), the server call still happens right away whenever the device is online; being offline only affects how quickly the queue drains.

For `new-note`, the `note_id` is generated **on the client** (using the standard 10-character ID scheme) and included in the command. This means a newly created note has its permanent id immediately — later queued commands can reference it, and no id-rewriting is needed when the create is eventually delivered. This requires a backend change: the `new-note` API must accept a client-supplied `note_id` (as `import-notes` already does).

The data layer's write call returns a promise that resolves with the outcome of that **first** delivery attempt, giving the UI feedback just as immediate as today's direct calls. The outcome is one of:

- **delivered** — the server accepted the command. The mirror is updated with the note object the server returned, and the UI proceeds exactly as an online save does today.
- **queued** — the server could not be reached (network error or timeout). The change is already safely committed locally and will be delivered by the background retry loop. Because nothing has been lost, this outcome is *not* reported with today's "Failed to save changes to note" alert. For now, we will not display this to the user, but we will retain the option to change that treatment later if desired.
- **rejected** — the command definitively failed and will not be retried, either because the server answered with a definitive error or because the device could not commit it locally. This is surfaced to the user immediately through the same paths used today: a 409 feeds the existing conflict-handling flow, and other errors feed the existing alert.

Retries after the first attempt happen silently in the background; their outcomes are handled by the sync engine, not reported through this promise.

In environments that degrade to online-only passthrough mode (see Goals), there is no queue: the write call goes directly to the server, the **queued** outcome cannot occur, and a network failure is reported as a true save failure, as today.

### Updating Device Data

We want to ensure that the device data is fairly well up-to-date. To ensure this we will use three mechanisms.

#### Mechanism 1: Update on Edit

Whenever a user begins editing a note, we will attempt to fetch that note from the server (we do this today). That will ensure that we always have the latest version of a note that is being edited, unless the device is unable to communicate with the server. In that case, we will work with whatever value is cached. We will use a timeout for this, tuned so it will usually leave enough time for the server's response, but won't feel *too* slow for a user who is offline.

#### Mechanism 2: Updates Made Here

When an update is made to a note, it goes through the write path (see The Write Path above): the local mirror is updated from the command immediately, as part of enqueueing it. (Note: the mirror entry does *not* need some special marker that it is potentially inaccurate, because the presence of the queued command takes care of that.) When delivery to the server succeeds, the mirror is updated again to match what the server returns (only when no later commands for that note remain queued — see Delivering Delayed Updates). This requires a backend change: `delete-note` and `recover-deleted-note` must be modified to return the updated note (`edit-note` and `new-note` already do).

#### Mechanism 3: Background Updates

In order to receive edits that were made from a different device, the device will retrieve any changes from the server. It will launch a background thread to run "while the app is in use" every so often (maybe once per hour while in use?). This will retrieve the full list of notes (which includes each note's version_id), and then the full list of deleted notes. It will retrieve from the server and update in storage any note which has been removed, added, or has a new version_id. Notes in the trash are mirrored with their full bodies too: since get-deleted-notes returns only headers, the background pass fetches each added or changed trashed note individually with get-note. This process can be low-priority since it only needs to catch changes made to notes that are edited on another device and not edited here.

I think this mechanism can also be used to populate the local copy of the list of notes initially.

### Delivering Delayed Updates

Every offline-capable write command is appended to the `IndexedDB` queue store (see Device Data Storage above) as part of the write path, and the sync engine delivers the queued commands to the server. The updates are sent in the order in which they were performed: the command at the head of the queue is delivered (and on failure, retried) before any later command is sent.

The `source_version_id` stored on each queued command is a precomputation of what the server's version will be when that command is delivered. This works because the local layer changes `version_id` by exactly the same rule the server uses, per command type: set to 0 by `new-note`, incremented by `edit-note`, and left unchanged by `delete-note` and `recover-deleted-note` — and because every queued command is normally applied in order. When something breaks the every-command-applied assumption, the queue is repaired by one of the fix-up passes below.

#### Delivery Outcomes

Each delivery attempt of the head command ends one of four ways:

- **Success (2xx):** the command is removed from the queue, and the mirror is updated from the returned note as described in Mechanism 2.
- **Conflict (409):** the server created a new `[CONFLICTED]` note (at version `source_version_id + 1`) and left the original untouched. The command is removed from the queue (its content lives in the conflict note), and the conflict fix-up pass below is applied.
- **Definitive failure (other 4xx):** the command is complete — and has failed. It is removed from the queue, the failure is surfaced to the user, and the removal fix-up pass below is applied. (Exception: a 401 means the session is invalid; all local note data is wiped, as described in Device Data Storage.)
- **Transient failure (network error, timeout, or 5xx):** the command stays at the head of the queue and the retry loop's backoff applies.

#### Duplicate Deliveries and Idempotency

A transient failure is ambiguous: the request may never have reached the server, or it may have been applied and only the *response* was lost. Since the sync engine re-sends after a transient failure, the server can receive the same command twice. No idempotency keys are used; instead, duplicates are detected from the data itself.

Two rules make this sound:

- **Single command in flight.** The sync engine never pipelines: only the head command is ever unacknowledged. A duplicate therefore always carries a `source_version_id` exactly 1 behind the server's current `version_id` (unless another device has also edited, in which case conflict handling is correct anyway).
- **Server-side duplicate detection for edit-note.** When an `edit-note` arrives whose `source_version_id` is exactly 1 behind the note's current `version_id`, and whose title and body are byte-identical to the note's current title and body, the server treats it as a duplicate of the edit it already applied: it makes no change and returns 200 with the current note, rather than creating a `[CONFLICTED]` copy. (The edit payload is a complete snapshot, so this comparison fully determines whether the earlier delivery already produced this result.) In every other case the existing conflict behavior applies unchanged.

The other three offline-capable commands are made idempotent by no-op rules:

- **new-note**: if a note with the client-supplied `note_id` already exists for this user and has the same fields, return success with the existing note (it is the retry) instead of an error.
- **delete-note**: deleting an already-deleted note returns success.
- **recover-deleted-note**: recovering a note that is not deleted returns success.

Each no-op rule also guarantees that a retried command cannot apply its effect (including any `version_id` bump) twice.

#### Detecting a Poisoned Command

A transient failure normally means the device is offline, but it could also mean this specific command triggers a server bug. To distinguish them: after N consecutive transient failures of the same command, the sync engine calls a health endpoint (`GET /api/v1/health-check` — a new, unauthenticated endpoint returning 200). If the health check fails, the device really is offline and backoff continues indefinitely. If the health check succeeds, the command is retried once more; if it still fails, it is declared poisoned: removed from the queue, surfaced to the user, and the removal fix-up pass is applied.

#### Fix-up Pass: Command Removed Undelivered

When a command for a note is removed without having been applied (definitive failure or poisoned), the server never made the `version_id` advance that command promised. If the removed command was an `edit-note` — the one offline-capable command that advances `version_id` — every later queued command for that note has its `source_version_id` decremented by 1; removing a `delete-note` or `recover-deleted-note` changes no `source_version_id`, since those commands make no advance. (If the removed command was the `new-note`, the later commands reference a note the server never created; they will fail definitively and be removed one at a time by this same rule.)

#### Fix-up Pass: Conflict

When a command gets a 409, the branch of history in the queue continues on the conflict note. In one pass over the later queued commands for the original note: rewrite their `note_id` to the conflict note's `note_id`, and prepend `"[CONFLICTED] "` to each queued edit's title (so the marker survives the later edits overwriting the title). Their `source_version_id`s are left unchanged — the conflict note continues the same version sequence, so they are already correct. The mirror entry for the original note is re-keyed to the conflict note's `note_id` in the same pass; the original note then has no pending commands, so the normal mechanisms re-fetch the server's version of it. If the note is open in the UI, the open note follows the branch to the conflict note (the offline analog of today's online conflict handling).

Whenever the queue is non-empty, a background retry loop attempts delivery, with exponential backoff between attempts, capped at a few hours (a long-offline device being hours out of date is acceptable). Three events reset the backoff and trigger an immediate attempt: the browser's `online` event, app launch, and a new command being enqueued. The retry loop runs in whichever tab holds the Web Lock for the sync engine; when its queue is idle it rechecks about hourly anyway, since a command enqueued from another tab arrives without any of the three events firing in the lock-holding tab.

When a delivery response returns a note, the mirror is updated from it only if the queue contains no remaining commands for that note (queue-index use case 5); if later commands are still pending, the mirror already reflects them and the response is not written.

### Note Fields on Device

The notes stored in the `IndexedDB` will need to have the following fields. This table shows the fields, along with a note about how each is populated when we perform an offline update.

| Field       | Source during offline update                                             |
|-------------|--------------------------------------------------------------------------|
| user_id     | Unknown locally: null until the server's copy of the note replaces this. |
| note_id     | In the update command (client-generated for new-note).                   |
| version_id  | 0 for new-note; incremented by edit-note; unchanged by delete/recover.   |
| title       | This is in the update command.                                           |
| body        | This is in the update command.                                           |
| create_time | Set by new-note; left as-is for other commands.                          |
| modify_time | Set by system clock; delete-note leaves it unchanged.                    |
| format      | This is a constant.                                                      |
| undo_stack  | A diff is generated locally (see below).                                 |
| delete_time | Set to the purge time by delete-note; cleared by recover-deleted-note.   |

Generating the undo diff for offline edits requires a JavaScript implementation of the diff format (specified in
`design_notes.md`), maintained in parallel with the Rust implementation. The two are ports of one another and produce
byte-identical output; the shared test vectors in `tests/diff_vectors.json`, which both test suites assert against,
keep them in agreement.

### Required Backend Changes

The design above requires these server-side changes (each is also a contract change to record in `design_notes.md`):

- **new-note**: accept a client-supplied `note_id`; if a note with that id already exists for this user, make no change and return success with the existing note. **[DONE]**
- **edit-note**: duplicate detection — when `source_version_id` is exactly 1 behind the note's current `version_id` and the incoming title and body are byte-identical to the note's current title and body, make no change and return 200 with the current note instead of creating a `[CONFLICTED]` copy. **[DONE]**
- **delete-note**: return the updated note instead of a bare 204; deleting an already-deleted note returns success; add a `condition_expression` so deleting a nonexistent note returns 404 instead of creating a phantom item (also listed in `todo.md`). **[DONE]**
- **recover-deleted-note**: return the updated note instead of a bare 204. (Its no-op idempotency rule is already implemented.) **[DONE]**
- **`GET /api/v1/health-check`**: new unauthenticated endpoint returning 200, used by the sync engine's poisoned-command detection. **[DONE]**
