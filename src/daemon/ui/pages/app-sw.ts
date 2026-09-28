// --- Phone app service worker (/app/sw.js) ---

/** Network-first for the shell (so a revoked phone sees the locked page as
 *  soon as it is online), cache-first for icons and the manifest, and never
 *  anything under /api/. Bump CACHE when the precached list changes.
 *
 *  The locked page ("This phone isn't paired") is kept too, under its own
 *  key, so an unpaired app opened offline still shows the pairing form and
 *  says it needs a connection instead of a browser error. A cached paired
 *  shell always wins over it.
 *
 *  It also shows Web Push notifications (payload from channels/push.ts) and
 *  opens their link on tap: app links in an open app window, web links in
 *  the browser. */
export const APP_SERVICE_WORKER = `
var CACHE = 'agentx-app-v3';
var STATIC = ['/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(STATIC); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;
  if (req.mode === 'navigate' && url.pathname === '/app') {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) {
        if (res.ok) return Promise.all([c.put('/app', copy), c.delete('/app/locked')]);
        if (res.status === 401) return Promise.all([c.put('/app/locked', copy), c.delete('/app')]);
        return null;
      });
      return res;
    }).catch(function () {
      return caches.match('/app').then(function (hit) { return hit || caches.match('/app/locked'); }).then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }
  if (STATIC.indexOf(url.pathname) >= 0) {
    e.respondWith(caches.match(url.pathname).then(function (hit) { return hit || fetch(req); }));
  }
});
function safeUrl(u) {
  try {
    var abs = new URL(u || '/app#alerts', self.location.origin);
    return abs.protocol === 'https:' || abs.protocol === 'http:' ? abs.href : null;
  } catch (x) { return null; }
}
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  var actions = Array.isArray(d.actions) ? d.actions : [];
  var urls = {};
  actions.forEach(function (a) { urls[a.action] = a.url; });
  e.waitUntil(self.registration.showNotification(d.title || 'AgentX', {
    body: d.body || '',
    icon: '/app/icon-192.png',
    badge: '/app/icon-192.png',
    data: { url: d.url, urls: urls },
    actions: actions.map(function (a) { return { action: a.action, title: a.title }; }),
  }).then(function () {
    return self.clients.matchAll({ type: 'window' });
  }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'agentx-push' }); });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var target = safeUrl((e.action && data.urls && data.urls[e.action]) || data.url) || safeUrl('/app#alerts');
  var inApp = new URL(target).origin === self.location.origin;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    var app = inApp ? cs.filter(function (c) { return new URL(c.url).pathname === '/app'; })[0] : null;
    if (app) {
      app.postMessage({ type: 'agentx-open', url: target });
      return app.focus();
    }
    return self.clients.openWindow(target);
  }));
});
`
