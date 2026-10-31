// --- Wall People page, browser side (#1441) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), when(), avatar(), nameOf(), isOpen(), stateBadge(), getJson(),
// headers(), wallTaskHref(), fillSelect(), writeHash() and render().
//
// Everyone who talks to the agents, as the classic /people page showed
// them: role, channel identities, the agents they may reach, and, opened,
// the machines they paired, their requests and the turns they started.
// No new API: it reads GET /api/admin/people and /api/admin/people/<id>
// (people-panel.ts). Each person links to their open requests on the Wall
// (the feed with the "Asked by" filter), each request to its post and each
// turn to the Wall's Task page.
//
// Writes, the ones the classic page had: End access for one machine,
// POST /api/admin/people/<id>/devices/<tokenId>/end, End access for one
// signed-in browser (#1478), POST /api/admin/people/<id>/sessions/<id>/end,
// and the person's
// picture (#1425, wall-pictures.client.ts), behind the dashboard token
// gate like every /api/admin write. Adding and editing people stays
// with `agentx people` and Settings (#1428).
//
// renderPeople(page) is the one call the Wall's render() makes;
// refreshPeople() is called from the Wall's own load(), so the nav count
// and the "Asked by" names are there before the page is opened.

import { HUB_NAME } from "../hub-name"

export const WALL_PEOPLE_SCRIPT = String.raw`
  var PP = { list: null, paired: 0, error: '', open: {}, detail: {}, note: '', bad: false };
  var PP_ROLE = { owner: 'Owner', member: 'Member', client: 'Client', guest: 'Guest' };
  var PP_REQUEST = {
    in_progress: ['In progress', ''], waiting_owner: ['Waiting on you', 'chip--warn'], waiting_other: ['Waiting on another agent', 'chip--warn'],
    needs_attention: ['Needs attention', 'chip--err'], done: ['Done', 'chip--done'], declined: ['Declined', 'chip--ghost'], dropped: ['Dropped', 'chip--ghost'],
  };
  var PP_OPEN = ['in_progress', 'waiting_owner', 'waiting_other', 'needs_attention'];
  async function loadPeople() {
    try {
      var d = await getJson('/api/admin/people');
      PP.list = d.people || []; PP.paired = d.paired || 0; PP.error = '';
      // Someone no longer listed closes; the ones still open read again.
      Object.keys(PP.open).forEach(function (id) { if (!PP.list.some(function (p) { return p.id === id; })) { delete PP.open[id]; delete PP.detail[id]; } });
      Object.keys(PP.open).forEach(loadPerson);
      fillAsker();
    } catch (e) { PP.error = e.message; }
    render();
  }
  function refreshPeople() { loadPeople(); }
  async function loadPerson(id) {
    try {
      var d = await getJson('/api/admin/people/' + encodeURIComponent(id));
      if (PP.open[id]) PP.detail[id] = d;
    } catch (e) { if (PP.open[id]) PP.detail[id] = { error: e.message }; }
    render();
  }
  function personName(id) {
    var p = (PP.list || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.name : id;
  }
  /** The Feed filter "Asked by": everyone who asked something, and everyone listed. */
  function fillAsker() {
    var ids = ((S.data && S.data.posts) || []).map(function (p) { return p.askedBy; }).concat((PP.list || []).map(function (p) { return p.id; }));
    var seen = {}, keep = $('f-asker').value;
    ids = ids.filter(function (v) { if (!v || seen[v]) return false; seen[v] = 1; return true; });
    if (keep && !seen[keep]) ids.push(keep);
    fillSelect('f-asker', ids, personName);
  }
  /** What a person asked that is still open on the Wall's posts. */
  function openAskedBy(id) {
    return ((S.data && S.data.posts) || []).filter(function (p) { return p.askedBy === id && isOpen(p); }).length;
  }
  function askerHref(id) { return '#status=open&asker=' + encodeURIComponent(id); }
  /** Plain words: no [agentx:…] markers, one line, capped. */
  function plain(s) {
    return String(s == null ? '' : s).replace(/\[agentx:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  function ppState(label, cls) { return '<span class="chip state ' + (cls || '') + '">' + esc(label) + '</span>'; }
  function machineState(d) {
    if (d.state === 'active') return ppState('Active', 'chip--done');
    if (d.state === 'pending' && d.answer === 'yes') return ppState('Approved', 'chip--done') + ' <small>not opened since</small>';
    if (d.state === 'pending' && d.answer === 'no') return ppState('Refused', 'chip--ghost');
    if (d.state === 'pending') return ppState('Waiting for your approval', 'chip--warn') + ' <a href="#status=open&amp;view=decide">Approve</a>';
    return ppState('Ended', 'chip--ghost') + (d.removedReason ? ' <small>' + esc(plain(d.removedReason)) + '</small>' : '');
  }
  // Not machinesHtml: the Live page's script shares this scope (#1461).
  function personMachinesHtml(p, devices) {
    if (!devices.length) return '<p class="wpp__quiet">No machine paired.' + (p.builtIn ? '' : ' Invite them with <code>agentx people invite ' + esc(p.id) + '</code>.') + '</p>';
    return '<ul class="wpp__machines">' + devices.map(function (d) {
      var end = d.state === 'removed' ? '' : '<button type="button" class="ax-btn wpp__end" data-pp-end="' + esc(d.tokenId) + '" data-pp-person="' + esc(p.id) + '" data-pp-name="' + esc(d.name) + '">End access</button>';
      return '<li><div class="wpp__mhead"><b>' + esc(d.name) + '</b> ' + machineState(d) + end + '</div>' +
        '<dl class="wpp__facts">' +
          '<div><dt>Paired from</dt><dd>' + esc(d.address || 'not recorded') + (d.network ? ' <small>as ' + esc(d.network) + '</small>' : '') + '</dd></div>' +
          '<div><dt>First use</dt><dd>' + when(Date.parse(d.createdAt)) + '</dd></div>' +
          '<div><dt>Last use</dt><dd>' + (d.lastSeenAt ? when(Date.parse(d.lastSeenAt)) + (d.lastAddress ? ' <small>from ' + esc(d.lastAddress) + '</small>' : '') : 'Not used yet') + '</dd></div>' +
        '</dl></li>';
    }).join('') + '</ul>';
  }
  /** Browsers signed in as the person (#1478). Nothing shown until one has. */
  function personSessionsHtml(p, sessions) {
    if (!sessions.length) return '';
    return '<h3>Signed-in browsers</h3><ul class="wpp__machines">' + sessions.map(function (s) {
      var end = s.endedAt ? '' : '<button type="button" class="ax-btn wpp__end" data-pp-end-session="' + esc(s.id) + '" data-pp-person="' + esc(p.id) + '" data-pp-name="' + esc(s.label) + '">End access</button>';
      var state = s.endedAt ? ppState('Ended', 'chip--ghost') + (s.endedReason ? ' <small>' + esc(plain(s.endedReason)) + '</small>' : '') : ppState('Signed in', 'chip--done');
      return '<li><div class="wpp__mhead"><b>' + esc(s.label) + '</b> ' + state + end + '</div>' +
        '<dl class="wpp__facts">' +
          '<div><dt>Signed in</dt><dd>' + when(Date.parse(s.startedAt)) + '</dd></div>' +
          '<div><dt>Last use</dt><dd>' + when(Date.parse(s.lastUsedAt)) + '</dd></div>' +
        '</dl></li>';
    }).join('') + '</ul>';
  }
  function requestHtml(r) {
    var s = PP_REQUEST[r.state] || [String(r.state).replace(/_/g, ' '), 'chip--ghost'];
    return '<li><a href="#post=' + encodeURIComponent(r.id) + '" class="wpp__text">' + esc(plain(r.text) || 'Request') + '</a>' +
      '<p class="wpp__meta">' + ppState(s[0], s[1]) + '<span>' + esc(nameOf(r.agentId)) + '</span><span>' + esc(r.channel) + '</span><span>' + when(r.createdAt) + '</span></p></li>';
  }
  function requestsHtml(p, d) {
    if (!d.database) return '<p class="wpp__quiet">The database could not be opened. Start the dashboard from the folder that holds <code>agentx.json</code>.</p>';
    var all = d.requests || [];
    if (!all.length) return '<p class="wpp__quiet">No tracked request. Requests appear here once request tracking is on (<code>agentx requests settings</code>).</p>';
    var open = all.filter(function (r) { return PP_OPEN.indexOf(r.state) >= 0; }), closed = all.filter(function (r) { return PP_OPEN.indexOf(r.state) < 0; });
    return (open.length ? '<ol class="wpp__items">' + open.map(requestHtml).join('') + '</ol>' : '<p class="wpp__quiet">Nothing open.</p>') +
      (closed.length ? '<details class="wpp__more"><summary>' + closed.length + (closed.length === 1 ? ' earlier request' : ' earlier requests') + '</summary><ol class="wpp__items">' + closed.map(requestHtml).join('') + '</ol></details>' : '');
  }
  function runsHtml(runs) {
    if (!runs.length) return '<p class="wpp__quiet">Nothing recorded yet.</p>';
    return '<ol class="wpp__items">' + runs.map(function (r) {
      var s = r.status === 'ok' ? ['Finished', 'chip--ghost'] : r.status === 'in-flight' ? ['Running', ''] : [String(r.status), 'chip--err'];
      var t = { id: r.taskId, channel: r.channel, messagePreview: plain(r.messagePreview), startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : '' };
      return '<li><a href="' + esc(wallTaskHref(t, r.agentId, null, r.status !== 'in-flight')) + '" class="wpp__text">' + esc(t.messagePreview || 'A turn') + '</a>' +
        '<p class="wpp__meta">' + ppState(s[0], s[1]) + '<span>' + esc(nameOf(r.agentId)) + '</span><span>' + esc(r.channel || '') + '</span><span>' + when(r.startedAt) + '</span></p></li>';
    }).join('') + '</ol>';
  }
  function personDetailHtml(p) {
    var d = PP.detail[p.id];
    if (!d) return '<p class="wpp__quiet">Loading…</p>';
    if (d.error) return '<p class="wpp__quiet">Could not read this person: ' + esc(d.error) + '.</p>';
    return '<h3>Machines</h3>' + personMachinesHtml(p, d.devices || []) + personSessionsHtml(p, d.sessions || []) +
      '<h3>Requests</h3>' + requestsHtml(p, d) +
      '<h3>Latest turns they started</h3>' + runsHtml(d.runs || []);
  }
  function personHtml(p) {
    var on = !!PP.open[p.id];
    var n = p.machines.active + p.machines.pending, asked = openAskedBy(p.id);
    var ids = p.identities.length ? p.identities.map(function (i) { return '<span>' + esc(i) + '</span>'; }).join('')
      : '<span>' + (p.builtIn ? 'What you do on this machine (voice, app, dashboard) is recorded here.' : 'No channel identity yet') + '</span>';
    return '<article class="wpp" id="person-' + esc(p.id) + '">' + avatar(p.id, '', true, p.name) + '<div class="wpp__b">' +
      '<div class="wp__by"><button type="button" class="name" data-pp-open="' + esc(p.id) + '" aria-expanded="' + on + '" aria-controls="pp-body-' + esc(p.id) + '">' + esc(p.name) + '</button>' +
        '<span class="h">@' + esc(p.id) + '</span><span class="chip' + (p.role === 'owner' ? '' : ' chip--ghost') + '">' + esc(PP_ROLE[p.role] || p.role) + '</span></div>' +
      '<div class="wp__meta wpp__ids">' + ids + '</div>' +
      (p.agents.length ? '<div class="wp__meta">May reach ' + p.agents.map(function (a) { return '<button type="button" data-agent="' + esc(a) + '">' + esc(nameOf(a)) + '</button>'; }).join(', ') + '</div>' : '') +
      '<div class="wpf__stats"><span><b>' + n + '</b> ' + (n === 1 ? 'machine' : 'machines') + '</span>' +
        (p.machines.pending ? '<span class="is-warn"><b>' + p.machines.pending + '</b> waiting for approval</span>' : '') +
        '<span><a href="' + askerHref(p.id) + '"><b>' + (S.data ? asked : '…') + '</b> open ' + (asked === 1 ? 'request' : 'requests') + ' on the ${HUB_NAME}</a></span></div>' +
      pictureActsHtml(p.id, true) +
      '<button type="button" class="wpp__toggle" data-pp-open="' + esc(p.id) + '" aria-expanded="' + on + '" aria-controls="pp-body-' + esc(p.id) + '">' + (on ? 'Hide machines and requests' : 'Machines and requests') + '</button>' +
      '<div class="wpp__body" id="pp-body-' + esc(p.id) + '"' + (on ? '' : ' hidden') + '>' + (on ? personDetailHtml(p) : '') + '</div>' +
      '</div></article>';
  }
  function peoplePageHtml() {
    var note = PP.note ? '<p class="wdo__n wpp__note' + (PP.bad ? ' is-bad' : '') + '" role="status">' + esc(PP.note) + '</p>' : '';
    if (PP.error && !PP.list) return note + '<p class="ax-wall__empty">Could not read the people list: ' + esc(PP.error) + '. The rest of the ${HUB_NAME} still works; reload the page if the dashboard token was set after it opened.</p>';
    if (!PP.list) return '<p class="ax-wall__empty">Loading…</p>';
    var none = PP.paired ? '' : '<section class="wpp__none" aria-labelledby="pp-none-h"><h2 id="pp-none-h">Nobody has paired a machine yet</h2>' +
      '<p>A teammate gets one page of their own, <b>My work</b>, on a machine you approve. A client gets <b>Your project</b> instead. To invite someone, from the folder that holds <code>agentx.json</code>:</p><ol>' +
      '<li>List them, with the identity they write from: <code>agentx people add sara --name "Sara B" --identity gitlab:sara.b</code>. For a client, add <code>--role client</code>.</li>' +
      '<li>Make their one-time code: <code>agentx people invite sara</code></li>' +
      '<li>Send them the address and the code it prints, then say yes to their machine in <a href="#status=open&amp;view=decide">Needs you</a>.</li></ol></section>';
    return note + none + (PP.list.length ? PP.list.map(personHtml).join('') : '<p class="ax-wall__empty">Nobody is listed.</p>');
  }
  /** Called from the Wall's render(). Keeps the keyboard on the same control across a repaint. */
  function renderPeople(page) {
    var n = $('nav-n-people');
    n.textContent = PP.list ? String(PP.list.length) : '';
    n.classList.toggle('is-zero', !(PP.list && PP.list.length));
    n.setAttribute('title', PP.list ? PP.list.length + ' people' : '');
    var el = $('wall-people');
    el.hidden = page !== 'people';
    if (page !== 'people') return;
    var a = document.activeElement, key = '';
    if (a && el.contains(a)) key = a.getAttribute('data-pp-end') ? '[data-pp-end="' + a.getAttribute('data-pp-end') + '"]'
      : a.getAttribute('data-pp-open') ? '.' + a.className.split(' ')[0] + '[data-pp-open="' + a.getAttribute('data-pp-open') + '"]' : '';
    el.innerHTML = peoplePageHtml();
    if (key) { var again = el.querySelector(key); if (again && again.focus) again.focus(); }
  }
  function endAccess(b) {
    var id = b.getAttribute('data-pp-person'), name = b.getAttribute('data-pp-name');
    var session = b.getAttribute('data-pp-end-session');
    var url = '/api/admin/people/' + encodeURIComponent(id) + (session
      ? '/sessions/' + encodeURIComponent(session) + '/end'
      : '/devices/' + encodeURIComponent(b.getAttribute('data-pp-end')) + '/end');
    var ask = session
      ? 'End access for "' + name + '"? This browser is signed out at once. The person can sign in again.'
      : 'End access for "' + name + '"? This machine stops at once. To use it again, the person needs a new invite.';
    if (typeof confirm === 'function' && !confirm(ask)) return;
    b.disabled = true;
    var h = headers(); h['Content-Type'] = 'application/json';
    fetch(url, { method: 'POST', headers: h, body: '{}' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(function () {
        PP.note = 'Access ended for "' + name + '".'; PP.bad = false;
        return loadPeople().then(function () {
          // The button is gone with the machine's access: keep the keyboard on this person.
          var box = $('wall-people'), o = box.querySelector && box.querySelector('.name[data-pp-open="' + id + '"]');
          if (o && o.focus) o.focus();
        });
      }, function (e) { PP.note = 'Could not end access: ' + e.message; PP.bad = true; b.disabled = false; render(); });
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-pp-open],[data-pp-end],[data-pp-end-session],[data-asker-clear]');
    if (!t) return;
    if (t.hasAttribute('data-asker-clear')) { $('f-asker').value = ''; writeHash(); render(); return; }
    if (t.hasAttribute('data-pp-end') || t.hasAttribute('data-pp-end-session')) { endAccess(t); return; }
    var id = t.getAttribute('data-pp-open');
    if (PP.open[id]) { delete PP.open[id]; delete PP.detail[id]; render(); return; }
    PP.open[id] = true;
    render();
    loadPerson(id);
  });
`

export const WALL_PEOPLE_CSS = `
.wpp { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.wpp__b { flex: 1; min-width: 0; }
.wpp .wp__by .name { font: inherit; font-weight: 700; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.wpp .wp__by .name:hover { text-decoration: underline; }
.wpp__ids span { overflow-wrap: anywhere; }
.wpp .wp__meta button { font: inherit; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; }
.wpp .wpf__stats .is-warn, .wpp .wpf__stats .is-warn b { color: var(--ax-amber-ink, var(--ax-warn)); }
.wpp .wpf__stats a { color: inherit; }
.wpp__toggle { margin-top: 6px; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-accent); background: none; border: 0; padding: 4px 0; cursor: pointer; }
.wpp__toggle[aria-expanded="true"]::before { content: "▾ "; } .wpp__toggle[aria-expanded="false"]::before { content: "▸ "; }
.wpp button:focus-visible, .wpp a:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.wpp__body h3 { margin: 12px 0 6px; font-size: var(--ax-fs-sm); }
.wpp__quiet { margin: 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wpp code, .wpp__none code { font-family: var(--ax-mono); font-size: 11.5px; background: var(--ax-surface-2); padding: 1px 6px; border-radius: var(--ax-radius-sm); overflow-wrap: anywhere; }
.wpp__machines, .wpp__items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.wpp__machines li, .wpp__items li { padding: 8px 0 0; border-top: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); min-width: 0; }
.wpp__mhead { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.wpp__mhead small, .wpp__facts small { color: var(--ax-muted); }
.wpp__end { margin-left: auto; font-size: var(--ax-fs-xs); padding: 3px 12px; background: none; color: var(--ax-red-ink); border: 1px solid currentColor; }
.wpp__end:hover { background: var(--ax-red-t); }
.wpp__end:disabled { opacity: .5; cursor: default; }
.wpp__facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 12px; margin: 6px 0 0; }
.wpp__facts dt { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wpp__facts dd { margin: 0; overflow-wrap: anywhere; }
.wpp__text { display: block; overflow-wrap: anywhere; color: inherit; }
.wpp__meta { margin: 2px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wpp__more summary { cursor: pointer; margin-top: 8px; font-size: var(--ax-fs-sm); color: var(--ax-accent); }
.wpp__none { margin: 12px 16px; padding: 12px 14px; border: 1px dashed var(--ax-border-2); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); }
.wpp__none h2 { margin: 0 0 6px; font-size: 15px; }
.wpp__none p { margin: 0 0 8px; color: var(--ax-text-2); }
.wpp__none ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
.wpp__note { margin: 8px 16px; } .wpp__note.is-bad { color: var(--ax-red-ink, var(--ax-err)); }
.ax-wall__asker button { font: inherit; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; }
@media (max-width: 640px) {
  .wpp { padding: 12px; }
  .wpp__facts { grid-template-columns: minmax(0, 1fr); }
  .wpp__end { margin-left: 0; }
}
`
