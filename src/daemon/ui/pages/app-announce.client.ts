// --- Phone app: Announcements in the Alerts tab (#268) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Alerts script
// has drawn its panel. Adds a card with the "Notify me of announcements"
// switch and the recent mesh announcements from /api/app/announcements,
// refreshed while the Alerts tab is on screen. Built with DOM APIs only:
// announcement text comes from people and agents on other nodes, so it
// never goes through innerHTML. Reuses the fx-* styles.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_ANNOUNCE_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-alerts');
  if (!panel) return;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  var card = el('div', 'fx-card');
  card.id = 'an-card';
  var head = el('div', 'fx-row');
  head.appendChild(el('h3', null, 'Announcements'));
  var sw = el('button', 'fx-switch');
  sw.type = 'button';
  sw.id = 'an-notify';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', 'false');
  sw.setAttribute('aria-labelledby', 'an-notify-label');
  sw.appendChild(el('span'));
  // Same look as the chat-finish switch above it (.al-finish).
  var row = el('div', 'fx-row al-finish');
  var label = el('p', null, 'Notify me of announcements');
  label.appendChild(el('small', null, 'A notification for each new one'));
  label.id = 'an-notify-label';
  row.appendChild(label);
  row.appendChild(sw);
  row.style.display = 'none';
  var err = el('p', 'fx-error fx-bad');
  err.setAttribute('role', 'alert');
  var list = el('ul', 'fx-list');
  list.id = 'an-list';
  list.setAttribute('aria-live', 'polite');
  card.appendChild(head);
  card.appendChild(row);
  card.appendChild(err);
  card.appendChild(list);
  // Above "Recent", under the notifications card.
  var recent = panel.querySelector('h3.fx-sub');
  if (recent) panel.insertBefore(card, recent); else panel.appendChild(card);

  var busy = false;
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('not paired'); }
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }
  function setSwitch(on) {
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  function render(items) {
    list.replaceChildren();
    if (!items.length) { list.appendChild(el('li', 'fx-muted', 'No announcements yet.')); return; }
    items.forEach(function (it) {
      var li = el('li');
      li.appendChild(el('p', null, it.text));
      var meta = [it.by, it.node, ago(it.at)].filter(function (x) { return x; }).join(' · ');
      li.appendChild(el('p', 'fx-muted', meta));
      list.appendChild(li);
    });
  }
  function load() {
    return api('GET', '/api/app/announcements').then(function (b) {
      err.textContent = b.error ? 'Could not load announcements: ' + b.error : '';
      row.style.display = b.notifyAvailable ? '' : 'none';
      if (!busy) setSwitch(!!b.notify);
      render(b.items || []);
    }).catch(function (e) { err.textContent = 'Could not load announcements: ' + e.message; });
  }
  sw.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    var on = sw.getAttribute('aria-checked') !== 'true';
    setSwitch(on);
    err.textContent = '';
    api('POST', '/api/app/push/prefs', { announce: on })
      .catch(function (e) { setSwitch(!on); err.textContent = e.message; })
      .then(function () { busy = false; });
  });

  function visible() { return !document.hidden && !panel.hidden; }
  setInterval(function () { if (visible()) load(); }, 5000);
  document.addEventListener('visibilitychange', function () { if (visible()) load(); });
  // The tab bar un-hides the panel; load as soon as it shows.
  new MutationObserver(function () { if (visible()) load(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if ((ev.data || {}).type === 'agentx-push') load();
    });
  }
  load();
})();
`
