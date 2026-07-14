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
- `manifest.json`
- The six icons: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `mini-notes-192x192.png`, `mini-notes-512x512.png`

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
- **activate** — delete every cache whose name does not match the current `app-shell-<asset-version>`. This is the cleanup of superseded shells.
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

The checked-in `html/sw.js` is the real source file and carries a valid default:

```js
const ASSET_VERSION = 'dev';
```

so serving `html/` directly on a local machine always works, even on a fresh checkout. (The fixed `'dev'` cache name means local service-worker testing can serve stale assets between edits; DevTools' "Update on reload" is the standard workaround. This affects only local testing, never a deployment.)

The deploy steps:

1. Delete and re-create the staging directory (under `target/`), then copy `html/` into it. Starting fresh each time ensures no stale files from a previous deploy survive.
2. Compute a content hash over the shell assets and rewrite `ASSET_VERSION` in the **staging copy** of `sw.js`.
3. Sync the staging directory to S3, ensuring `sw.js`, the HTML pages, and the online-only pages' assets are served with `Cache-Control: no-cache` (see the headers section above).
4. Invalidate CloudFront (already done today).

The existing up-to-date check (skip the deploy when nothing under `html/` is newer than the sentinel) continues to work unchanged, since the deploy writes nothing into `html/`.

## Note Data Caching

The design for how to store the notes data has not been written yet.