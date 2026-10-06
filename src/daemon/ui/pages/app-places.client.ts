// --- Phone app: Places card in the Alerts tab (#676) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Alerts script.
// Lists the owner's places and their reminders (/api/app/places), adds and
// removes them. "Use where I am now" reads the position once, only when
// tapped, and only to fill in the form; nothing is sent until Save.
//
// Watching the places in the background is the AgentX Android app's job
// (apps/android). Chrome opens the app with an android-app:// referrer;
// the card remembers that, and then links to the app's own location
// settings through an intent: link. In a browser the card says the app is
// needed for reminders to fire.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_PLACES_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-alerts');
  if (!panel) return;
  var card = document.createElement('div');
  card.className = 'fx-card pl-card';
  card.id = 'pl-card';
  card.innerHTML = '<div class="fx-row"><h3>Places</h3><span id="pl-pill" class="fx-pill"></span></div>' +
    '<p id="pl-text" class="fx-muted">Checking…</p>' +
    '<p id="pl-shell" class="fx-muted" hidden></p>' +
    '<ul id="pl-list" class="fx-list pl-list"></ul>' +
    '<details id="pl-add-wrap" class="pl-add" hidden><summary class="fx-btn">Add a place</summary>' +
      '<form id="pl-add" autocomplete="off">' +
        '<label><span>Name</span><input name="name" required maxlength="60" placeholder="School"></label>' +
        '<button type="button" id="pl-here" class="fx-btn">Use where I am now</button>' +
        '<label><span>Latitude, longitude</span><input name="coords" required inputmode="decimal" placeholder="48.8584, 2.2945"></label>' +
        '<label><span>Radius in metres</span><input name="radius" type="number" inputmode="numeric" step="10"></label>' +
        '<div class="fx-actions"><button type="submit" class="fx-btn fx-primary">Save place</button></div>' +
      '</form></details>' +
    '<p id="pl-error" class="fx-error fx-bad" role="alert"></p>';
  var head = document.getElementById('al-recent-head');
  panel.insertBefore(card, head || null);

  var pill = document.getElementById('pl-pill');
  var text = document.getElementById('pl-text');
  var shellNote = document.getElementById('pl-shell');
  var list = document.getElementById('pl-list');
  var addWrap = document.getElementById('pl-add-wrap');
  var form = document.getElementById('pl-add');
  var err = document.getElementById('pl-error');
  var state = null;
  function field(f, n) { return f.elements.namedItem(n); }

  var inShell = false;
  try {
    if (/^android-app:/.test(document.referrer)) localStorage.setItem('ax-shell', 'android');
    inShell = localStorage.getItem('ax-shell') === 'android';
  } catch (e) { inShell = /^android-app:/.test(document.referrer); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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
  function ruleRow(r) {
    var what = (r.on === 'exit' ? 'Leave: ' : 'Arrive: ') + r.text;
    var how = (r.agent ? 'asks ' + r.agent : 'reminder') + (r.repeat ? ', every time' : ', once') + (r.enabled ? '' : (r.repeat ? ', paused' : ', done'));
    return '<li class="pl-rule' + (r.enabled ? '' : ' is-off') + '"><span>' + esc(what) + ' <small class="fx-muted">' + esc(how) + '</small></span>' +
      '<button type="button" class="fx-btn" data-act="rule-remove" data-id="' + esc(r.id) + '" aria-label="Remove reminder ' + esc(r.text) + '">Remove</button></li>';
  }
  function placeRow(p) {
    var rules = (state.rules || []).filter(function (r) { return r.placeId === p.id; });
    var agents = (state.agents || []).map(function (a) { return '<option value="' + esc(a) + '">Ask ' + esc(a) + '</option>'; }).join('');
    return '<li class="pl-place"><div class="fx-row"><strong>' + esc(p.name) + '</strong><span class="fx-muted">' + esc(p.radius) + ' m</span></div>' +
      (rules.length ? '<ul class="pl-rules">' + rules.map(ruleRow).join('') + '</ul>' : '<p class="fx-muted">No reminders yet.</p>') +
      '<details class="pl-more"><summary>Add a reminder or remove</summary>' +
        '<form class="pl-rule-form" data-place="' + esc(p.id) + '">' +
          '<label><span>When</span><select name="on"><option value="enter">When I arrive</option><option value="exit">When I leave</option></select></label>' +
          '<label><span>Remind me to</span><input name="text" required maxlength="500" placeholder="Pick up the parcel"></label>' +
          '<label><span>Who</span><select name="agent"><option value="">Just remind me</option>' + agents + '</select></label>' +
          '<label class="pl-check"><input type="checkbox" name="repeat"> Every time, not just once</label>' +
          '<div class="fx-actions"><button type="button" class="fx-btn fx-danger-o" data-act="remove" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Remove place</button>' +
          '<button type="submit" class="fx-btn fx-primary">Add reminder</button></div>' +
        '</form></details></li>';
  }
  function paint() {
    if (!state.enabled) {
      pill.textContent = 'Off'; pill.className = 'fx-pill fx-off';
      text.textContent = state.reason; list.innerHTML = ''; addWrap.hidden = true; shellNote.hidden = true;
      return;
    }
    var n = state.places.length;
    pill.textContent = n + (n === 1 ? ' place' : ' places');
    pill.className = 'fx-pill ' + (n ? 'fx-on' : 'fx-warn');
    text.textContent = state.pushAvailable
      ? 'Get a reminder when you arrive at or leave a place. Your phone tells this computer only which place, never where you are.'
      : 'Places are saved, but reminders are not sent: ' + (state.pushReason || 'notifications are off.');
    shellNote.hidden = false;
    shellNote.innerHTML = inShell
      ? 'This phone watches these places in the background. <a href="intent://places#Intent;scheme=agentx;package=' + esc(state.android.packageName) + ';end">Location settings</a>'
      : 'Reminders fire only on an Android phone with the AgentX Android app. See Place reminders in the AgentX docs.';
    var radius = field(form, 'radius');
    radius.placeholder = String(state.limits.defaultRadiusMeters);
    radius.min = String(state.limits.minRadiusMeters);
    radius.max = String(state.limits.maxRadiusMeters);
    addWrap.hidden = n >= state.limits.maxPlaces;
    list.innerHTML = n ? state.places.map(placeRow).join('') : '<li class="fx-muted">No places yet.</li>';
  }
  function load() {
    return api('GET', '/api/app/places').then(function (s) { state = s; paint(); })
      .catch(function (e) { pill.textContent = ''; text.textContent = 'Could not load places: ' + e.message; });
  }

  document.getElementById('pl-here').addEventListener('click', function () {
    err.textContent = '';
    if (!navigator.geolocation) { err.textContent = 'This browser can’t read the location. Type the coordinates instead.'; return; }
    var b = this; b.disabled = true; b.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      field(form, 'coords').value = pos.coords.latitude.toFixed(6) + ', ' + pos.coords.longitude.toFixed(6);
      b.disabled = false; b.textContent = 'Use where I am now';
    }, function (e) {
      var show = function (permission) {
        err.textContent = locationErrorText(e.code, inShell, permission);
        b.disabled = false; b.textContent = 'Use where I am now';
      };
      if (e.code !== 1 || !navigator.permissions) { show(''); return; }
      navigator.permissions.query({ name: 'geolocation' })
        .then(function (p) { show(p.state); }, function () { show(''); });
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.textContent = '';
    var parts = field(form, 'coords').value.split(',');
    if (parts.length !== 2) { err.textContent = 'Type the coordinates as latitude, longitude.'; return; }
    api('POST', '/api/app/places/add', { name: field(form, 'name').value, lat: parts[0].trim(), lng: parts[1].trim(), radius: field(form, 'radius').value })
      .then(function () { form.reset(); addWrap.open = false; return load(); })
      .catch(function (e) { err.textContent = e.message; });
  });
  list.addEventListener('submit', function (ev) {
    var f = ev.target.closest('form[data-place]');
    if (!f) return;
    ev.preventDefault();
    err.textContent = '';
    api('POST', '/api/app/places/rules/add', { placeId: f.getAttribute('data-place'), on: field(f, 'on').value, text: field(f, 'text').value, agent: field(f, 'agent').value, repeat: field(f, 'repeat').checked })
      .then(load).catch(function (e) { err.textContent = e.message; });
  });
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'remove' && !confirm('Remove ' + b.getAttribute('data-name') + ' and its reminders?')) return;
    b.disabled = true;
    err.textContent = '';
    api('POST', act === 'remove' ? '/api/app/places/remove' : '/api/app/places/rules/remove', { id: b.getAttribute('data-id') })
      .then(load).catch(function (e) { err.textContent = e.message; b.disabled = false; });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state) load(); });
  load();
})();
`

export const APP_PLACES_CSS = `
.pl-card { margin-top: 12px; }
.pl-list { margin-top: 8px; }
.pl-rules { list-style: none; margin: 6px 0 0; padding: 0; }
.pl-rules .pl-rule { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border: 0; }
.pl-rule.is-off { opacity: .7; }
.pl-more summary, .pl-add summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.pl-more summary { color: var(--ax-accent); font-size: var(--ax-fs-sm); }
.pl-add summary { list-style: none; display: inline-flex; margin-top: 10px; }
.pl-add summary::-webkit-details-marker { display: none; }
.pl-card form { display: grid; gap: 10px; margin-top: 10px; }
.pl-card label span { display: block; font-weight: 600; margin-bottom: 4px; font-size: var(--ax-fs-sm); }
.pl-card input:not([type=checkbox]), .pl-card select {
  width: 100%; box-sizing: border-box; min-height: 44px; padding: 8px 10px; font: inherit;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-text);
}
.pl-check { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-sm); }
.pl-check input { width: 20px; height: 20px; }
#pl-here { justify-self: start; }
`
