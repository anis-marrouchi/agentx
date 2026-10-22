// --- Phone app: pinned pages (#1120) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Places script.
// Two parts, both filled from /api/app/pinned:
//
//   - the strip under the header: one button per pinned page, shown with
//     the header on Chat (where the app opens), hidden while there are none;
//   - the Pinned pages card in the Alerts tab: add, rename and remove.
//
// A button is a plain link that opens in the same window, never a new tab
// or an iframe: in the Android app Chrome then shows the page in the app's
// own window with a close button, in an installed iPhone app it opens in
// the app's browser sheet, and in both the page's own microphone prompt
// works as in the browser. An iframe would need the other page to allow
// framing and to be granted the microphone through this one.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_PINNED_BODY = `<nav id="pn-strip" class="pn-strip" aria-label="Pinned pages" hidden></nav>`

export const APP_PINNED_SCRIPT = `
(function () {
  var strip = document.getElementById('pn-strip');
  var panel = document.getElementById('panel-alerts');
  if (!strip || !panel) return;
  var card = document.createElement('div');
  card.className = 'fx-card pn-card';
  card.id = 'pn-card';
  card.innerHTML = '<div class="fx-row"><h3>Pinned pages</h3><span id="pn-pill" class="fx-pill"></span></div>' +
    '<p id="pn-text" class="fx-muted">Checking…</p>' +
    '<ul id="pn-list" class="fx-list pn-list"></ul>' +
    '<details id="pn-add-wrap" class="pn-add" hidden><summary class="fx-btn">Pin a page</summary>' +
      '<form id="pn-add" autocomplete="off">' +
        '<label><span>Button name</span><input name="label" required maxlength="40" placeholder="Remote"></label>' +
        '<label><span>Address</span><input name="url" type="url" required maxlength="2048" inputmode="url" placeholder="https://tools.example.ts.net/remote"></label>' +
        '<div class="fx-actions"><button type="submit" class="fx-btn fx-primary">Pin page</button></div>' +
      '</form></details>' +
    '<p id="pn-error" class="fx-error fx-bad" role="alert"></p>';
  var head = document.getElementById('al-recent-head');
  panel.insertBefore(card, head || null);

  var pill = document.getElementById('pn-pill');
  var text = document.getElementById('pn-text');
  var list = document.getElementById('pn-list');
  var addWrap = document.getElementById('pn-add-wrap');
  var form = document.getElementById('pn-add');
  var err = document.getElementById('pn-error');
  var state = null;
  function field(f, n) { return f.elements.namedItem(n); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function host(url) { try { return new URL(url).host; } catch (e) { return url; } }
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
  // Only https links reach the page: the server checks, and so does this.
  function safe(url) { return /^https:[/][/]/i.test(url); }
  function paintStrip(pages) {
    var shown = pages.filter(function (p) { return safe(p.url); });
    strip.innerHTML = shown.map(function (p) {
      return '<a class="pn-btn" href="' + esc(p.url) + '" rel="noopener noreferrer" title="' + esc(host(p.url)) + '">' + esc(p.label) + '</a>';
    }).join('');
    strip.hidden = !shown.length;
    try { localStorage.setItem('ax-pinned', JSON.stringify(shown)); } catch (e) {}
  }
  function row(p) {
    var top = '<div class="fx-row"><a class="pn-open" href="' + esc(p.url) + '" rel="noopener noreferrer"><strong>' + esc(p.label) + '</strong></a><span class="fx-muted pn-host">' + esc(host(p.url)) + '</span></div>';
    if (p.source === 'config') return '<li class="pn-page">' + top + '<p class="fx-muted">Set in agentx.json (app.pinned.pages). Change or remove it there.</p></li>';
    return '<li class="pn-page">' + top +
      '<details class="pn-more"><summary>Rename or remove</summary>' +
        '<form class="pn-rename" data-id="' + esc(p.id) + '">' +
          '<label><span>Button name</span><input name="label" required maxlength="40" value="' + esc(p.label) + '"></label>' +
          '<div class="fx-actions"><button type="button" class="fx-btn fx-danger-o" data-act="remove" data-id="' + esc(p.id) + '" data-name="' + esc(p.label) + '">Remove</button>' +
          '<button type="submit" class="fx-btn fx-primary">Save name</button></div>' +
        '</form></details></li>';
  }
  function paint() {
    if (!state.enabled) {
      pill.textContent = 'Off'; pill.className = 'fx-pill fx-off';
      text.textContent = state.reason; list.innerHTML = ''; addWrap.hidden = true;
      paintStrip([]);
      return;
    }
    var n = state.pages.length;
    pill.textContent = n + (n === 1 ? ' page' : ' pages');
    pill.className = 'fx-pill ' + (n ? 'fx-on' : 'fx-off');
    text.textContent = 'Pin a web page as a button at the top of Chat. Tap it to open the page here; pages that use the microphone ask for it as in your browser.';
    addWrap.hidden = n >= state.max;
    list.innerHTML = n ? state.pages.map(row).join('') : '<li class="fx-muted">No pinned pages yet.</li>';
    paintStrip(state.pages);
  }
  function load() {
    return api('GET', '/api/app/pinned').then(function (s) { state = s; paint(); })
      .catch(function (e) { pill.textContent = ''; text.textContent = 'Could not load pinned pages: ' + e.message; });
  }

  // Offline, the strip shows the buttons from the last load.
  try {
    var saved = JSON.parse(localStorage.getItem('ax-pinned') || '[]');
    if (Array.isArray(saved)) paintStrip(saved);
  } catch (e) {}

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.textContent = '';
    api('POST', '/api/app/pinned/add', { label: field(form, 'label').value, url: field(form, 'url').value })
      .then(function () { form.reset(); addWrap.open = false; return load(); })
      .catch(function (e) { err.textContent = e.message; });
  });
  list.addEventListener('submit', function (ev) {
    var f = ev.target.closest('form[data-id]');
    if (!f) return;
    ev.preventDefault();
    err.textContent = '';
    api('POST', '/api/app/pinned/rename', { id: f.getAttribute('data-id'), label: field(f, 'label').value })
      .then(load).catch(function (e) { err.textContent = e.message; });
  });
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act=remove]');
    if (!b) return;
    if (!confirm('Remove the ' + b.getAttribute('data-name') + ' button?')) return;
    b.disabled = true;
    err.textContent = '';
    api('POST', '/api/app/pinned/remove', { id: b.getAttribute('data-id') })
      .then(load).catch(function (e) { err.textContent = e.message; b.disabled = false; });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state) load(); });
  load();
})();
`

export const APP_PINNED_CSS = `
.pn-strip {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  padding: 4px calc(12px + env(safe-area-inset-right)) 8px calc(20px + env(safe-area-inset-left));
  background: var(--ax-bg);
}
.pn-strip[hidden] { display: none; }
/* Shown with the header, on Chat, where the app opens: the other tabs
   hide the header and start at the top of the screen. */
body:has(#tab-chat[aria-selected=false]) > .pn-strip { display: none; }
.pn-strip::-webkit-scrollbar { display: none; }
.pn-btn {
  flex: none; display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-pill);
  background: var(--ax-surface-2); color: var(--ax-text); text-decoration: none;
  font-size: var(--ax-fs-sm); font-weight: 600; white-space: nowrap;
}
.pn-btn:active { background: var(--ax-accent-t); }
.pn-card { margin-top: 12px; }
.pn-list { margin-top: 8px; }
.pn-open { color: var(--ax-text); text-decoration: none; }
.pn-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pn-more summary, .pn-add summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.pn-more summary { color: var(--ax-accent); font-size: var(--ax-fs-sm); }
.pn-add summary { list-style: none; display: inline-flex; margin-top: 10px; }
.pn-add summary::-webkit-details-marker { display: none; }
.pn-card form { display: grid; gap: 10px; margin-top: 10px; }
.pn-card label span { display: block; font-weight: 600; margin-bottom: 4px; font-size: var(--ax-fs-sm); }
.pn-card input {
  width: 100%; box-sizing: border-box; min-height: 44px; padding: 8px 10px; font: inherit;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-text);
}
`
