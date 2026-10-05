// --- Phone app: Places in the Alerts tab (#676) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Alerts script
// has drawn its panel. Adds a card that lists saved places with their
// reminders, saves "where I am now" (the browser asks for location once,
// while the app is open) and adds or removes a reminder. The Android shell
// reads the same list and does the background part; this card only edits
// it. Built with DOM APIs only; reuses the fx-* styles.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_PLACES_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-alerts');
  if (!panel) return;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    var b = el('button', 'fx-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
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

  var card = el('div', 'fx-card');
  card.id = 'pl-card';
  var head = el('div', 'fx-row');
  head.appendChild(el('h3', null, 'Places'));
  var note = el('p', 'fx-muted', 'Get a reminder when you arrive at or leave a place. Needs the AgentX Android app for the background part.');
  var err = el('p', 'fx-error fx-bad');
  err.setAttribute('role', 'alert');
  var list = el('ul', 'fx-list');
  list.id = 'pl-list';
  var add = el('div', 'fx-row fx-gap');
  var name = el('input');
  name.id = 'pl-name';
  name.placeholder = 'Name, e.g. School';
  name.maxLength = 60;
  name.setAttribute('aria-label', 'Place name');
  add.appendChild(name);
  add.appendChild(button('Save where I am', 'fx-primary', saveHere));
  card.appendChild(head);
  card.appendChild(note);
  card.appendChild(add);
  card.appendChild(err);
  card.appendChild(list);
  var recent = panel.querySelector('#al-recent-head');
  if (recent) panel.insertBefore(card, recent); else panel.appendChild(card);

  var data = null;
  function saveHere() {
    err.textContent = '';
    var n = name.value.trim();
    if (!n) { err.textContent = 'Give the place a name first.'; name.focus(); return; }
    if (!navigator.geolocation) { err.textContent = 'This browser cannot read the location.'; return; }
    note.textContent = 'Finding where you are…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      api('POST', '/api/app/places', { name: n, lat: pos.coords.latitude, lon: pos.coords.longitude })
        .then(function () { name.value = ''; return load(); })
        .catch(function (e) { err.textContent = e.message; });
    }, function (e) {
      err.textContent = e.code === 1
        ? 'Location was not allowed. Allow it for this app in the phone settings, or add the place from the dashboard.'
        : 'Could not find where you are: ' + e.message;
      load();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }
  function addReminder(place) {
    var text = prompt('Remind you of what when you arrive at ' + place.name + '?');
    if (!text || !text.trim()) return;
    var leave = confirm('Remind you when you LEAVE instead? (Cancel = when you arrive)');
    api('POST', '/api/app/places/reminders', { place: place.id, on: leave ? 'exit' : 'enter', text: text.trim() })
      .then(load).catch(function (e) { err.textContent = e.message; });
  }
  function render() {
    list.replaceChildren();
    if (data.enabled === false) { list.appendChild(el('li', 'fx-muted', data.reason || 'Place reminders are off on this computer.')); add.hidden = true; return; }
    add.hidden = false;
    var ev = (data.events || [])[0];
    note.textContent = ev
      ? 'Last event from this phone: ' + (ev.transition === 'enter' ? 'arrived at ' : 'left ') + ev.placeName + ', ' + new Date(ev.at).toLocaleString() + '.'
      : 'Get a reminder when you arrive at or leave a place. Needs the AgentX Android app for the background part.';
    if (!data.places.length) { list.appendChild(el('li', 'fx-muted', 'No place yet. Stand there and tap Save where I am.')); return; }
    data.places.forEach(function (p) {
      var li = el('li');
      var row = el('div', 'fx-row');
      row.appendChild(el('strong', null, p.name));
      row.appendChild(el('span', 'fx-muted', p.radiusMeters + ' m'));
      li.appendChild(row);
      data.reminders.filter(function (r) { return r.placeId === p.id; }).forEach(function (r) {
        var rr = el('div', 'fx-row');
        rr.appendChild(el('p', null, (r.on === 'enter' ? 'On arrival: ' : 'On leaving: ') + r.text));
        rr.appendChild(button('Remove', 'fx-danger-o', function () {
          api('POST', '/api/app/places/reminders/remove', { id: r.id }).then(load).catch(function (e) { err.textContent = e.message; });
        }));
        li.appendChild(rr);
      });
      var act = el('div', 'fx-row fx-gap');
      act.appendChild(button('Add reminder', null, function () { addReminder(p); }));
      act.appendChild(button('Remove place', 'fx-danger-o', function () {
        if (!confirm('Remove ' + p.name + ' and its reminders?')) return;
        api('POST', '/api/app/places/remove', { id: p.id }).then(load).catch(function (e) { err.textContent = e.message; });
      }));
      li.appendChild(act);
      list.appendChild(li);
    });
  }
  function load() {
    return api('GET', '/api/app/places').then(function (b) { data = b; render(); })
      .catch(function (e) { err.textContent = 'Could not load places: ' + e.message; });
  }
  function visible() { return !document.hidden && !panel.hidden; }
  new MutationObserver(function () { if (visible()) load(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', function () { if (visible()) load(); });
  load();
})();
`
