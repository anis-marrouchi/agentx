// --- Phone app: pinned pages (#1120) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Places script.
// Two parts, both filled from /api/app/pins:
//
//   - the row of buttons under the header (#pin-bar), shown with the
//     header on the Chat tab, where the app opens. Each button is a plain
//     link in the same window: the Android app keeps the page inside its
//     Chrome window and the back gesture returns here; an installed iPhone
//     app opens it in its in-app browser. A page that asks for the
//     microphone gets the browser's own prompt for its address.
//   - the Pinned pages card in the Alerts tab: add, rename, remove.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_PINS_BAR = `<nav id="pin-bar" class="pin-bar" aria-label="Pinned pages" hidden></nav>`

export const APP_PINS_SCRIPT = `
(function () {
  var bar = document.getElementById('pin-bar');
  var panel = document.getElementById('panel-alerts');
  if (!bar || !panel) return;
  var card = document.createElement('div');
  card.className = 'fx-card pn-card';
  card.id = 'pn-card';
  card.innerHTML = '<div class="fx-row"><h3>Pinned pages</h3><span id="pn-pill" class="fx-pill"></span></div>' +
    '<p class="fx-muted">Buttons at the top of Chat that open a web page in this app. A page that uses the microphone asks for it the first time.</p>' +
    '<ul id="pn-list" class="fx-list pn-list"></ul>' +
    '<details id="pn-add-wrap" class="pn-add"><summary class="fx-btn">Pin a page</summary>' +
      '<form id="pn-add" autocomplete="off">' +
        '<label><span>Button name</span><input name="label" required maxlength="40" placeholder="Remote"></label>' +
        '<label><span>Page address</span><input name="url" required type="url" inputmode="url" placeholder="https://"></label>' +
        '<div class="fx-actions"><button type="submit" class="fx-btn fx-primary">Pin page</button></div>' +
      '</form></details>' +
    '<p id="pn-error" class="fx-error fx-bad" role="alert"></p>';
  var places = document.getElementById('pl-card');
  var head = document.getElementById('al-recent-head');
  panel.insertBefore(card, places ? places.nextSibling : (head || null));

  var pill = document.getElementById('pn-pill');
  var list = document.getElementById('pn-list');
  var addWrap = document.getElementById('pn-add-wrap');
  var form = document.getElementById('pn-add');
  var err = document.getElementById('pn-error');
  var pins = [];
  function field(n) { return form.elements.namedItem(n); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function host(u) { try { return new URL(u).host; } catch (e) { return ''; } }
  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }
  function paint(max) {
    // The computer only hands out https addresses; checked again here so a
    // stray value can never become a javascript: link.
    var safe = pins.filter(function (p) { return typeof p.url === 'string' && p.url.indexOf('https://') === 0; });
    bar.innerHTML = safe.map(function (p) {
      return '<a class="pin-btn" href="' + esc(p.url) + '">' + esc(p.label) + '</a>';
    }).join('');
    bar.hidden = !safe.length;
    pill.textContent = safe.length + (safe.length === 1 ? ' page' : ' pages');
    pill.className = 'fx-pill ' + (safe.length ? 'fx-on' : 'fx-off');
    list.innerHTML = safe.length ? safe.map(function (p) {
      return '<li class="pn-row"><span><strong>' + esc(p.label) + '</strong> <small class="fx-muted">' + esc(host(p.url)) + '</small></span>' +
        '<span class="pn-acts"><button type="button" class="fx-btn" data-act="rename" data-id="' + esc(p.id) + '" data-label="' + esc(p.label) + '">Rename</button>' +
        '<button type="button" class="fx-btn fx-danger-o" data-act="remove" data-id="' + esc(p.id) + '" data-label="' + esc(p.label) + '">Remove</button></span></li>';
    }).join('') : '<li class="fx-muted">No pinned pages yet.</li>';
    addWrap.hidden = typeof max === 'number' && safe.length >= max;
  }
  function load() {
    return api('GET', '/api/app/pins').then(function (s) { pins = s.pins || []; paint(s.max); })
      .catch(function (e) { pill.textContent = ''; err.textContent = 'Could not load pinned pages: ' + e.message; });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.textContent = '';
    api('POST', '/api/app/pins/add', { label: field('label').value, url: field('url').value })
      .then(function () { form.reset(); addWrap.open = false; return load(); })
      .catch(function (e) { err.textContent = e.message; });
  });
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var id = b.getAttribute('data-id');
    var label = b.getAttribute('data-label');
    var body;
    if (act === 'rename') {
      var next = prompt('New name for ' + label, label);
      if (next == null || next.trim() === '' || next.trim() === label) return;
      body = { id: id, label: next };
    } else {
      if (!confirm('Remove the ' + label + ' button?')) return;
      body = { id: id };
    }
    b.disabled = true;
    err.textContent = '';
    api('POST', '/api/app/pins/' + act, body)
      .then(load).catch(function (e) { err.textContent = e.message; b.disabled = false; });
  });
  // Opening a pin leaves /app, which ends a voice turn under way (recording,
  // waiting on the answer, or reading it out). Ask first; idle opens at once.
  bar.addEventListener('click', function (ev) {
    var a = ev.target.closest('a.pin-btn');
    var V = window.AXVoice;
    var state = V && typeof V.state === 'function' ? V.state() : 'idle';
    if (!a || state === 'idle') return;
    if (!confirm('Open ' + a.textContent + '? The voice reply in progress will stop.')) ev.preventDefault();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  load();
})();
`

export const APP_PINS_CSS = `
.pin-bar {
  display: flex; gap: 8px; overflow-x: auto; flex: none;
  padding: 4px calc(12px + env(safe-area-inset-right)) 8px calc(16px + env(safe-area-inset-left));
  scrollbar-width: none;
}
.pin-bar[hidden] { display: none; }
.pin-bar::-webkit-scrollbar { display: none; }
.pin-btn {
  flex: none; display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-pill);
  background: var(--ax-surface-2); color: var(--ax-text); text-decoration: none;
  font-size: var(--ax-fs-sm); font-weight: 600; white-space: nowrap;
}
.pin-btn:active { background: var(--ax-accent-t); }
body:has(#tab-chat[aria-selected=false]) > .pin-bar { display: none; }
.pn-card { margin-top: 12px; }
.pn-list { margin-top: 8px; }
.pn-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pn-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.pn-acts { display: flex; gap: 6px; flex: none; }
.pn-add summary { list-style: none; display: inline-flex; margin-top: 10px; cursor: pointer; min-height: 44px; align-items: center; }
.pn-add summary::-webkit-details-marker { display: none; }
.pn-add[hidden] { display: none; }
.pn-card form { display: grid; gap: 10px; margin-top: 10px; }
.pn-card label span { display: block; font-weight: 600; margin-bottom: 4px; font-size: var(--ax-fs-sm); }
.pn-card input {
  width: 100%; box-sizing: border-box; min-height: 44px; padding: 8px 10px; font: inherit;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-text);
}
`
