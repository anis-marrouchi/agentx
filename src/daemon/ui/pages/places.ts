// --- Places page (/places) (#676) ---
//
// The places the Android shell watches, the reminders on each, and the
// latest enter/exit events. API lives in places-panel.ts (dashboard side,
// token-gated like the rest of /api/admin). This file owns only the HTML,
// CSS and client JS.
// Client JS avoids backslash escapes: they collapse inside this template
// literal.

import { pageHead, renderShell, type TopbarPeer } from ".."

export interface PlacesPageOpts {
  peers?: TopbarPeer[]
  localToken?: string
}

export function renderPlacesPage(opts: PlacesPageOpts = {}): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const body = pageHead({
    kicker: "Phone",
    title: "Places",
    lead: "Places your Android phone watches. When it enters or leaves one, the reminders you set here arrive as notifications. Only the place and the direction leave the phone, never its position.",
  }) + `
  <div class="pl">
    <div id="pl-msg" class="pl-msg" role="status" aria-live="polite"></div>
    <p id="pl-off" class="pl-note" hidden></p>
    <section class="pl-card" aria-labelledby="pl-add-title">
      <h2 id="pl-add-title">Add a place</h2>
      <form id="pl-add" class="pl-form">
        <label>Name<input name="name" required maxlength="60" placeholder="School"></label>
        <label>Latitude<input name="lat" required inputmode="decimal" placeholder="48.8584"></label>
        <label>Longitude<input name="lon" required inputmode="decimal" placeholder="2.2945"></label>
        <label>Radius (m)<input name="radiusMeters" inputmode="numeric" id="pl-radius"></label>
        <button type="submit" class="ax-btn ax-btn--primary">Add place</button>
      </form>
      <p class="pl-hint">Tip: in a map app, long-press the spot and copy its coordinates. On the phone, the app's Alerts tab can also save where you are now.</p>
    </section>
    <ol id="pl-list" class="pl-list" aria-label="Places"><li class="pl-quiet">Loading…</li></ol>
    <section class="pl-card" aria-labelledby="pl-ev-title">
      <h2 id="pl-ev-title">Latest events</h2>
      <ol id="pl-events" class="pl-events"><li class="pl-quiet">None yet.</li></ol>
    </section>
  </div>`
  return renderShell({
    title: "AgentX · Places",
    activeTab: "admin",
    subtitle: "Places",
    peers: opts.peers,
    body,
    css: PLACES_CSS,
    scripts: `${tokenScript}<script>${PLACES_SCRIPT}</script>`,
  })
}

const PLACES_CSS = `
.pl { max-width: 960px; margin: 0 auto; padding: 0 24px 64px; display: grid; gap: 16px; }
.pl-msg { min-height: 1.4em; font-size: var(--ax-fs-sm); }
.pl-msg.is-bad { color: var(--ax-red-ink); }
.pl-note { margin: 0; padding: 10px 14px; border-radius: var(--ax-radius); background: var(--ax-surface-2); font-size: var(--ax-fs-sm); }
.pl-card, .pl-place { padding: 14px 16px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.pl-card h2, .pl-place h3 { margin: 0 0 10px; font-size: 15px; }
.pl-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.pl-form label { display: grid; gap: 4px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.pl-form input, .pl-form select { font: inherit; padding: 6px 8px; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-sm); background: var(--ax-bg); color: var(--ax-text); min-width: 0; }
.pl-form input[name=text] { min-width: 260px; }
.pl-hint, .pl-quiet { margin: 8px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.pl-list, .pl-events, .pl-rems { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.pl-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; justify-content: space-between; }
.pl-meta { font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.pl-rems li, .pl-events li { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; font-size: var(--ax-fs-sm); padding: 6px 0; border-top: var(--ax-border-w) solid var(--ax-border); }
.pl-rems { margin: 8px 0 12px; }
`

const PLACES_SCRIPT = `
(function () {
  var msg = document.getElementById('pl-msg');
  var list = document.getElementById('pl-list');
  var events = document.getElementById('pl-events');
  var off = document.getElementById('pl-off');
  var data = { places: [], reminders: [], events: [], settings: {} };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers(json) {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (json) h['Content-Type'] = 'application/json';
    if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'pl-msg' + (bad ? ' is-bad' : ''); }
  function when(v) { var d = new Date(v); return v && !isNaN(d) ? d.toLocaleString() : ''; }
  function call(method, path, body) {
    return fetch(path, { method: method, credentials: 'same-origin', headers: headers(!!body), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function form(el) {
    var out = {};
    Array.prototype.forEach.call(el.elements, function (i) { if (i.name) out[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
    return out;
  }
  function reminderRow(r) {
    var what = (r.on === 'enter' ? 'On arrival' : 'On leaving') + (r.repeat ? ', every time' : ', once') + (r.agent ? ', through ' + r.agent : '');
    return '<li><span><b>' + esc(what) + ':</b> ' + esc(r.text) + '</span><button type="button" class="ax-btn ax-btn--danger" data-rm-rem="' + esc(r.id) + '">Remove</button></li>';
  }
  function placeCard(p) {
    var rems = data.reminders.filter(function (r) { return r.placeId === p.id; });
    var map = 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lon + '#map=17/' + p.lat + '/' + p.lon;
    return '<li class="pl-place"><div class="pl-head"><h3>' + esc(p.name) + '</h3>' +
      '<span class="pl-meta">' + esc(p.lat + ', ' + p.lon) + ' · ' + esc(p.radiusMeters) + ' m · <a href="' + esc(map) + '" target="_blank" rel="noopener noreferrer">map</a></span>' +
      '<button type="button" class="ax-btn ax-btn--danger" data-rm-place="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Remove place</button></div>' +
      (rems.length ? '<ul class="pl-rems">' + rems.map(reminderRow).join('') + '</ul>' : '<p class="pl-quiet">No reminder on this place yet.</p>') +
      '<form class="pl-form" data-place="' + esc(p.id) + '">' +
        '<label>When<select name="on"><option value="enter">I arrive</option><option value="exit">I leave</option></select></label>' +
        '<label>Remind me<input name="text" required maxlength="500" placeholder="Pick up the parcel"></label>' +
        '<label>Agent (optional)<input name="agent" maxlength="64" placeholder="agent id"></label>' +
        '<label><span>Every time</span><input type="checkbox" name="repeat"></label>' +
        '<button type="submit" class="ax-btn">Add reminder</button></form></li>';
  }
  function draw() {
    off.hidden = data.enabled !== false;
    off.textContent = data.reason || '';
    document.getElementById('pl-radius').placeholder = String(data.settings.defaultRadiusMeters || '');
    list.innerHTML = data.places.length ? data.places.map(placeCard).join('') : '<li class="pl-quiet">No place yet. Add one above.</li>';
    var names = {};
    data.places.forEach(function (p) { names[p.id] = p.name; });
    events.innerHTML = data.events.length ? data.events.map(function (e) {
      return '<li><span>' + esc(e.transition === 'enter' ? 'Arrived at ' : 'Left ') + esc(e.placeName) + (e.note ? ' (' + esc(e.note) + ')' : e.fired ? ', ' + e.fired + ' reminder' + (e.fired > 1 ? 's' : '') : '') + '</span><span class="pl-meta">' + esc(when(e.at)) + '</span></li>';
    }).join('') : '<li class="pl-quiet">None yet.</li>';
  }
  function load() {
    return call('GET', '/api/admin/places').then(function (d) { data = d; draw(); })
      .catch(function (e) { say('Could not read places: ' + e.message, true); });
  }
  document.getElementById('pl-add').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    call('POST', '/api/admin/places', form(f)).then(function (d) { f.reset(); say('Saved "' + d.place.name + '". The phone picks it up on its next sync.'); return load(); })
      .catch(function (e) { say(e.message, true); });
  });
  list.addEventListener('submit', function (ev) {
    var f = ev.target.closest('form[data-place]');
    if (!f) return;
    ev.preventDefault();
    var body = form(f);
    body.place = f.getAttribute('data-place');
    call('POST', '/api/admin/places/reminders', body).then(function () { say('Reminder saved.'); return load(); })
      .catch(function (e) { say(e.message, true); });
  });
  list.addEventListener('click', function (ev) {
    var rp = ev.target.closest('button[data-rm-place]');
    if (rp) {
      if (!confirm('Remove "' + rp.getAttribute('data-name') + '" and its reminders?')) return;
      call('POST', '/api/admin/places/remove', { id: rp.getAttribute('data-rm-place') }).then(function () { say('Place removed.'); return load(); })
        .catch(function (e) { say(e.message, true); });
      return;
    }
    var rr = ev.target.closest('button[data-rm-rem]');
    if (rr) {
      call('POST', '/api/admin/places/reminders/remove', { id: rr.getAttribute('data-rm-rem') }).then(function () { say('Reminder removed.'); return load(); })
        .catch(function (e) { say(e.message, true); });
    }
  });
  load();
  setInterval(load, 30000);
})();
`
