// Offline cache for the installable web version. Bump VERSION whenever files in www/ change.
const VERSION = "selah-v6";
// Bible books are cached as they are opened, so the ones you read work offline.
const FILES = [
  "./", "index.html", "manifest.webmanifest", "config.js", "live.js", "vendor/supabase.js",
  "fonts/fonts.css", "fonts/Figtree-normal.woff2", "fonts/Literata-normal.woff2",
  "fonts/Literata-italic.woff2", "fonts/YoungSerif-normal.woff2",
  "bible/books.json", "icons/favicon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// network first, so updates show up right away; fall back to the cache when offline
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});

// ---------- push notifications (web version) ----------
// Show the notification unless Selah is open and in front; the app shows its own banner then.
self.addEventListener("push", e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { title: "Selah", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (list.some(c => c.focused && c.visibilityState === "visible")) return;
    return self.registration.showNotification(msg.title || "Selah", {
      body: msg.body || "", tag: msg.tag, renotify: !!msg.tag, data: msg.data || {},
      icon: "icons/icon-192.png", badge: "icons/badge-96.png"
    });
  }));
});
// Tapping a notification opens Selah (or brings it forward) on the right screen.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const win = list.find(c => "focus" in c);
    if (win) { win.postMessage({ type: "push-open", data }); return win.focus(); }
    return self.clients.openWindow("./?push=" + encodeURIComponent(JSON.stringify(data)));
  }));
});
