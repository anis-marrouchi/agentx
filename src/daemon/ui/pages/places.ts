// --- Places for the phone's place reminders: the dashboard page (/places) (#676) ---
//
// The owner's saved places and what happens when their phone arrives at or
// leaves one. The AgentX Android app watches the places; this page only
// edits them. Data from /api/places (app-places.ts), the same store the
// phone app's Alerts tab edits.

import { pageHead, renderShell, type TopbarPeer } from "../index"

export function renderPlacesPage(opts: { peers?: TopbarPeer[] }): string {
  const body = pageHead({
    kicker: "Phone",
    title: "Places",
    lead: "Places your phone watches, and what to remind you of when you arrive or leave. The AgentX Android app on your phone notices the crossing and tells this computer only which place and which way: never where you are.",
  }) + `
  <div class="pl-wrap">
  <div id="pl-msg" class="pl-msg" role="status" aria-live="polite"></div>
  <form id="pl-add" class="pl-form" autocomplete="off">
    <h2>Add a place</h2>
    <label>Name <input name="name" required maxlength="60" placeholder="School"></label>
    <label>Coordinates <input name="coords" required placeholder="48.8584, 2.2945" inputmode="decimal" aria-describedby="pl-coords-help"></label>
    <p id="pl-coords-help" class="pl-help">Latitude, then longitude. In most map apps, long-press the spot and copy the numbers it shows.</p>
    <label>Radius in metres <input name="radius" type="number" step="10" inputmode="numeric"></label>
    <button type="submit" class="ax-btn ax-btn--primary">Add place</button>
  </form>
  <ol id="pl-list" class="pl-list" aria-label="Places"><li class="pl-empty">Loading…</li></ol>
  </div>`
  return renderShell({
    title: "AgentX · Places",
    activeTab: "admin",
    subtitle: "Places",
    peers: opts.peers,
    body,
    css: PLACES_CSS,
    scripts: `<script>${PLACES_SCRIPT}</script>`,
  })
}

const PLACES_CSS = `
.pl-wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px 96px; box-sizing: border-box; }
.pl-msg { min-height: 1.4em; margin: 8px 0 0; }
.pl-msg.is-bad { color: var(--ax-red-ink); }
.pl-form { margin: 16px 0; padding: 14px 16px; display: grid; gap: 10px; max-width: 520px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.pl-form h2, .pl-item h2 { margin: 0; font-size: 16px; }
.pl-form label { display: grid; gap: 4px; font-size: var(--ax-fs-sm); font-weight: 600; }
.pl-form input, .pl-form select, .pl-rule-form input, .pl-rule-form select { font: inherit; padding: 8px 10px; min-height: 40px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-text); }
.pl-help { margin: -4px 0 0; color: var(--ax-text-2); font-size: var(--ax-fs-xs); }
.pl-list { list-style: none; margin: 16px 0; padding: 0; display: grid; gap: 12px; }
.pl-empty { color: var(--ax-text-2); }
.pl-item { padding: 14px 16px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.pl-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
.pl-meta { margin: 4px 0 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.pl-rules { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
.pl-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: var(--ax-fs-sm); }
.pl-rule.is-off { color: var(--ax-text-2); }
.pl-rule-text { flex: 1 1 220px; overflow-wrap: anywhere; }
.pl-rule-form { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pl-rule-form input[name=text] { flex: 1 1 240px; }
.pl-btns { margin-left: auto; display: flex; gap: 8px; }
`

// Inside a TypeScript template literal: no backslashes, no dollar-brace
// and no backticks, or the inlined script breaks.
const PLACES_SCRIPT = `
(function () {
  var list = document.getElementById('pl-list');
  var msg = document.getElementById('pl-msg');
  var form = document.getElementById('pl-add');
  function field(f, n) { return f.elements.namedItem(n); }
  var state = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'pl-msg' + (bad ? ' is-bad' : ''); }
  function post(path, body) {
    return fetch('/api/places' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-board' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function ruleLine(r) {
    var what = (r.on === 'exit' ? 'When I leave: ' : 'When I arrive: ') + r.text;
    var how = (r.agent ? 'task for ' + r.agent : 'reminder') + (r.repeat ? ', every time' : ', once') + (r.enabled ? '' : (r.repeat ? ', paused' : ', done'));
    return '<li class="pl-rule' + (r.enabled ? '' : ' is-off') + '"><span class="pl-rule-text">' + esc(what) + ' <small>(' + esc(how) + ')</small></span>' +
      '<button type="button" class="ax-btn" data-act="toggle" data-id="' + esc(r.id) + '" data-on="' + (r.enabled ? '0' : '1') + '">' + (r.enabled ? 'Pause' : 'Turn on') + '</button>' +
      '<button type="button" class="ax-btn" data-act="rule-remove" data-id="' + esc(r.id) + '">Remove</button></li>';
  }
  function agentOptions() {
    return '<option value="">Just remind me</option>' + (state.agents || []).map(function (a) { return '<option value="' + esc(a) + '">Ask ' + esc(a) + '</option>'; }).join('');
  }
  function placeItem(p) {
    var rules = (state.rules || []).filter(function (r) { return r.placeId === p.id; });
    return '<li class="pl-item"><div class="pl-head"><h2>' + esc(p.name) + '</h2>' +
      '<div class="pl-btns"><button type="button" class="ax-btn" data-act="remove" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Remove place</button></div></div>' +
      '<p class="pl-meta">' + esc(p.lat) + ', ' + esc(p.lng) + ' · ' + esc(p.radius) + ' m</p>' +
      (rules.length ? '<ul class="pl-rules">' + rules.map(ruleLine).join('') + '</ul>' : '<p class="pl-meta">No reminders yet.</p>') +
      '<form class="pl-rule-form" data-place="' + esc(p.id) + '">' +
        '<select name="on" aria-label="When"><option value="enter">When I arrive</option><option value="exit">When I leave</option></select>' +
        '<input name="text" required maxlength="500" placeholder="Pick up the parcel" aria-label="Reminder">' +
        '<select name="agent" aria-label="Who">' + agentOptions() + '</select>' +
        '<label><input type="checkbox" name="repeat"> Every time</label>' +
        '<button type="submit" class="ax-btn">Add reminder</button></form></li>';
  }
  function render() {
    if (!state.enabled) { list.innerHTML = '<li class="pl-empty">' + esc(state.reason) + '</li>'; form.hidden = true; return; }
    form.hidden = false;
    field(form, 'radius').placeholder = String(state.limits.defaultRadiusMeters);
    field(form, 'radius').min = String(state.limits.minRadiusMeters);
    field(form, 'radius').max = String(state.limits.maxRadiusMeters);
    if (!state.pushAvailable && state.pushReason) say('Reminders are saved but not sent: ' + state.pushReason, true);
    list.innerHTML = state.places.length ? state.places.map(placeItem).join('') : '<li class="pl-empty">No places yet. Add one above, or from the phone app.</li>';
  }
  function load() {
    fetch('/api/places', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { say(d.error, true); return; }
      state = d; render();
    }).catch(function () { say('Could not read the places. Is the dashboard running?', true); });
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var parts = field(form, 'coords').value.split(',');
    if (parts.length !== 2) { say('Type the coordinates as latitude, longitude.', true); return; }
    post('/add', { name: field(form, 'name').value, lat: parts[0].trim(), lng: parts[1].trim(), radius: field(form, 'radius').value }).then(function (d) {
      say('Saved ' + d.place.name + '. Your phone picks it up the next time it checks.'); form.reset(); load();
    }).catch(function (e) { say(e.message, true); });
  });
  list.addEventListener('submit', function (ev) {
    var f = ev.target.closest('form[data-place]');
    if (!f) return;
    ev.preventDefault();
    post('/rules/add', { placeId: f.getAttribute('data-place'), on: field(f, 'on').value, text: field(f, 'text').value, agent: field(f, 'agent').value, repeat: field(f, 'repeat').checked })
      .then(function () { say('Reminder saved.'); load(); }).catch(function (e) { say(e.message, true); });
  });
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'remove' && !confirm('Remove ' + b.getAttribute('data-name') + ' and its reminders?')) return;
    var call = act === 'remove' ? post('/remove', { id: id })
      : act === 'rule-remove' ? post('/rules/remove', { id: id })
      : post('/rules/enable', { id: id, enabled: b.getAttribute('data-on') === '1' });
    b.disabled = true;
    call.then(function () { say(''); load(); }).catch(function (e) { say(e.message, true); b.disabled = false; });
  });
  load();
})();
`
