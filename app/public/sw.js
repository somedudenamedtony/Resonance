// Resonance service worker: makes the home-screen app open instantly and keep working when the
// bridge is slow to answer. The WebSocket (/ws) never goes through here.
//
// Pages: network first, falling back to the cached shell, so a new web app flashed to the
// bridge shows up on the next launch. Hashed files under assets/: cache first, since their
// names change with every build.

const CACHE = "resonance-v1";
const SHELL = ["./", "./manifest.webmanifest", "./icon.svg", "./apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/ws") || url.pathname.endsWith("/update")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) void caches.open(CACHE).then((c) => c.put("./", res.clone()));
          return res;
        })
        .catch(() => caches.match("./").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && url.pathname.includes("/assets/")) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
