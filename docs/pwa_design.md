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

### Service worker lifecycle

- **install** — open `app-shell-<asset-version>` and populate it with the shell assets. Each asset is fetched with `{cache: 'reload'}` so the fetch bypasses the browser's HTTP cache and pulls the freshly deployed bytes from the network. This closes the trap where a new cache version is filled with stale assets out of the HTTP cache.
- **activate** — delete every cache whose name does not match the current `app-shell-<asset-version>`. This is the cleanup of superseded shells.
- **fetch** — serve shell assets **cache-first**: return the cached response and do not touch the network. Navigation requests (to any in-scope path) fall back to the cached `index.html`.

### Update detection

The app relies on the browser's **natural** update triggers and does not proactively call `registration.update()`:

- The browser re-fetches `sw.js` on navigation into the app's scope (subject to throttling).
- The browser bypasses the HTTP cache for `sw.js` at most about every 24 hours regardless of headers.

On each such check the browser byte-compares the fetched `sw.js` against the installed one. Identical → nothing happens. Different → the new service worker installs. A stamped content-hash change in `sw.js` is therefore what cascades into rebuilding the cache.

If an update check fails (e.g. the device is offline), it fails silently: the already-installed service worker stays active and in control, the app keeps running from the existing cache, and the browser simply retries at the next trigger. There is no penalty for a failed check.

### Cache-Control / HTTP headers

There are two caches between the app and the origin: the service worker's Cache Storage (designed above) and the browser's ordinary HTTP cache. The HTTP cache matters in exactly two places:

- **`sw.js` must be served `Cache-Control: no-cache`** ("always revalidate," not "never store"). Otherwise the browser's HTTP cache can keep returning the old `sw.js`, and a version change is never noticed until the ~24h forced bypass.
- **Shell assets** need no special headers, because the service worker fetches them with `{cache: 'reload'}` at install time, bypassing the HTTP cache. Their HTTP headers are therefore irrelevant to correctness.

CloudFront staleness is a non-issue: `make deploy-frontend` already issues a CloudFront `/*` invalidation on every deploy, so the CDN is flushed each time. The only remaining actor is each browser's HTTP cache, fully handled by the two points above.

### Forced refresh on service-version mismatch

When the backend rejects a request because the client's service version is too old, the frontend must perform a *forced* refresh — not a polite "new version available, reload?" prompt. This is driven entirely by application code.

A plain `location.reload()` is **not** sufficient: if a new service worker is sitting in the waiting state, the reload simply re-serves the old assets. The forced-refresh routine must therefore actively replace the running shell:

1. Clear the shell cache(s) from Cache Storage.
2. Activate the new service worker (`skipWaiting` + `clients.claim`) so it takes control instead of waiting for all tabs to close.
3. Reload the page, which now serves the freshly cached, compatible shell.

In short: **reload ≠ refresh.** Forcing an update means clearing the cache and activating the new worker, then reloading.

This same machinery also applies when (in the future) the app wants to apply a normal, non-forced update promptly; the difference is only whether the user is prompted first.

### Build / deploy changes

A new **stamping step** must be inserted into the frontend deploy path (currently `make deploy-frontend`, which is a raw `aws s3 sync html/ --delete` plus a CloudFront `/*` invalidation):

1. Compute a content hash over the shell assets.
2. Write that hash into `sw.js` as `ASSET_VERSION` before the sync.
3. Sync to S3, ensuring `sw.js` is served with `Cache-Control: no-cache`.
4. Invalidate CloudFront (already done today).

This step fits equally well in `make` or a future `just`-based build; switching build tools is not a prerequisite for this work.
