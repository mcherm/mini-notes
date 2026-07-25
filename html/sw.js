// Service worker: caches the app shell so Mini-Notes loads instantly and runs
// offline. Design: docs/pwa_design.md ("App Shell Caching").

// ASSET_VERSION and SHELL_ASSETS are stamped by `just deploy-frontend`:
// ASSET_VERSION becomes a content hash of the shell assets, and SHELL_ASSETS
// becomes the list of paths from shell-assets.txt (the canonical list). The
// checked-in placeholders cache nothing, so an unstamped html/ tree runs the
// app entirely from the network.
const ASSET_VERSION = "dev";
const CACHE_NAME = "app-shell-" + ASSET_VERSION;

// The app shell: these paths (plus navigations to "/") are served cache-first.
// Everything else — admin.html, reset-password.html and their assets, and all
// API calls — goes straight to the network.
const SHELL_ASSETS = [];

async function populateShellCache() {
    const cache = await caches.open(CACHE_NAME);
    // {cache: "reload"} bypasses the browser's HTTP cache so the new shell is
    // built from freshly deployed bytes. addAll is all-or-nothing: if any
    // fetch fails the install fails, and the previous worker stays in control.
    await cache.addAll(SHELL_ASSETS.map((path) => new Request(path, {cache: "reload"})));
}

async function activateShellCache() {
    // Delete superseded shell caches. Only caches named "app-shell-*" are
    // ours to delete; other features (e.g. future note storage) may own others.
    const names = await caches.keys();
    const superseded = names.filter(
        (name) => name.startsWith("app-shell-") && name !== CACHE_NAME
    );
    await Promise.all(superseded.map((name) => caches.delete(name)));
    // Take control of open pages now; on first install this makes the app
    // offline-capable without waiting for a reload.
    await self.clients.claim();
}

async function serveShellAsset(path, request) {
    const cached = await caches.match(path);
    // The entry should always be present, but Cache Storage can be evicted
    // under storage pressure; fall back to the network rather than failing.
    return cached ?? fetch(request);
}

function actionInstall(event) {
    event.waitUntil(populateShellCache());
}

function actionActivate(event) {
    event.waitUntil(activateShellCache());
}

function actionFetch(event) {
    const request = event.request;
    if (request.method !== "GET") {
        return;
    }
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (SHELL_ASSETS.includes(path)) {
        event.respondWith(serveShellAsset(path, request));
    }
    // Any other request falls through to the network untouched.
}

function actionMessage(event) {
    // Lets page code promote a waiting worker to active; part of the
    // forced-refresh machinery (see docs/pwa_design.md).
    if (event.data === "skipWaiting") {
        self.skipWaiting();
    }
}

self.addEventListener("install", actionInstall);
self.addEventListener("activate", actionActivate);
self.addEventListener("fetch", actionFetch);
self.addEventListener("message", actionMessage);
