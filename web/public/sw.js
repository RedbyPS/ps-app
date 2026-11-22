// Cincee Vault service worker: keeps the app itself available offline.
// It never caches API traffic; your data is cached separately, encrypted, by the app.
// v2 (31 Oct 2026): v1 could keep a download (PS.dmg, the download page) as the shell; a new name clears it.
// v3 (PS 1.74): the app icons are the Cake icon under new names (icon-cake-*.png); a new name clears the old icons too.
const CACHE = "cincee-vault-shell-v3";
const SHELL = ["/client/", "/client/manifest.webmanifest", "/client/icon-cake-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // The app files (hashed, under /client/assets/) an older cache holds move into the new one first: the page that brought
  // this worker loaded them through the old one, and the cached shell needs them for an offline start.
  e.waitUntil(caches.keys().then(async (keys) => {
    // Only this worker's own older caches: another app on this site (the phone web app) keeps its own.
    const old = keys.filter((k) => k !== CACHE && k.startsWith("cincee-vault-shell-"));
    try {
      const now = await caches.open(CACHE);
      for (const k of old) {
        const c = await caches.open(k);
        for (const req of await c.keys()) {
          if (!new URL(req.url).pathname.startsWith("/client/assets/") || await now.match(req)) continue;
          const r = await c.match(req);
          if (r) await now.put(req, r);
        }
      }
    } catch { /* the old caches still go */ }
    await Promise.all(old.map((k) => caches.delete(k)));
  }).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/client/")) return;
  // The app downloads and their pages (PS.dmg, install.sh, the APK) are not the vault: never cached.
  if (url.pathname.startsWith("/client/ps/") || url.pathname.startsWith("/client/gos/")) return;
  // The build prompt page is its own page: never cached, and never kept as the vault's shell.
  if (url.pathname.startsWith("/client/build/")) return;
  if (e.request.mode === "navigate") {
    // Network first so updates arrive; fall back to the cached shell when offline.
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok && (r.headers.get("content-type") || "").startsWith("text/html")) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put("/client/", copy));
      }
      return r;
    }).catch(() => caches.match("/client/")));
    return;
  }
  if (url.pathname.startsWith("/client/assets/")) {
    // Hashed, immutable files: cache first.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});
