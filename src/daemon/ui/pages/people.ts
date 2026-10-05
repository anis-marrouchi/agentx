// --- People page (/people) (#441) ---
//
// Everyone who talks to the agents: the owner, teammates, clients and guests. Open a
// person to see the machines they paired (state, where from, first and
// last use), what they asked for, and to end one machine.
//
// API lives in people-panel.ts (dashboard side, token-gated like the rest
// of /api/admin). This file owns only the HTML, CSS and client JS.
// Client JS avoids backslash escapes: they collapse inside this template
// literal.

import { pageHead, renderShell, type TopbarPeer } from ".."

export interface PeoplePageOpts {
  peers?: TopbarPeer[]
  localToken?: string
}

export function renderPeoplePage(opts: PeoplePageOpts = {}): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const body = pageHead({
    kicker: "Operations",
    title: "People",
    lead: "Everyone who talks to your agents: you, your teammates, your clients and guests. Open a person to see the machines they paired and what they asked for.",
  }) + `
  <div class="pp">
    <div id="pp-msg" class="pp-msg" role="status" aria-live="polite"></div>
    <section id="pp-none" class="pp-none" hidden aria-labelledby="pp-none-title">
      <h2 id="pp-none-title">Nobody has paired a machine yet</h2>
      <p>A teammate gets one page of their own, <b>My work</b>, on a machine you approve. A client gets <b>Your project</b> instead. To invite someone, from the folder that holds <code>agentx.json</code>:</p>
      <ol>
        <li>List them, with the identity they write from: <code>agentx people add sara --name "Sara B" --identity gitlab:sara.b</code>. For a client, add <code>--role client</code>.</li>
        <li>Make their one-time code: <code>agentx people invite sara</code></li>
        <li>Send them the address and the code it prints, then say yes to their machine in <a href="/approvals">Approvals</a>.</li>
      </ol>
    </section>
    <ol id="pp-list" class="pp-list" aria-label="People"><li class="pp-empty">Loading…</li></ol>
  </div>`
  return renderShell({
    title: "AgentX · People",
    activeTab: "people",
    subtitle: "People",
    peers: opts.peers,
    body,
    css: PEOPLE_CSS,
    scripts: `${tokenScript}<script>${PEOPLE_SCRIPT}</script>`,
  })
}

const PEOPLE_CSS = `
.pp { max-width: 1040px; margin: 0 auto; padding: 0 24px 64px; }
.pp-msg { min-height: 1.4em; margin: 4px 0 8px; font-size: var(--ax-fs-sm); }
.pp-msg.is-bad { color: var(--ax-red-ink); }
.pp-none { margin: 0 0 16px; padding: 14px 16px; border: var(--ax-border-w) dashed var(--ax-border-2); border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.pp-none h2 { margin: 0 0 6px; font-size: 15px; }
.pp-none p { margin: 0 0 8px; color: var(--ax-text-2); }
.pp-none ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
.pp code { font-family: var(--ax-mono); font-size: 11.5px; background: var(--ax-surface-2); padding: 1px 6px; border-radius: var(--ax-radius-sm); }
.pp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.pp-empty { color: var(--ax-text-2); }
.pp-person { border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.pp-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; width: 100%; padding: 14px 16px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--ax-radius); }
.pp-head:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.pp-name { font-size: 16px; font-weight: 600; }
.pp-id { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.pp-count { margin-left: auto; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.pp-count b { color: var(--ax-amber-ink); font-weight: 600; }
.pp-caret { color: var(--ax-text-2); transition: transform 0.15s; }
.pp-head[aria-expanded="true"] .pp-caret { transform: rotate(90deg); }
.pp-ids { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.pp-ids span { font-family: var(--ax-mono); }
.pp-body { padding: 0 16px 16px; border-top: var(--ax-border-w) solid var(--ax-border); }
.pp-body h3 { margin: 16px 0 8px; font-size: 13px; }
.pp-body p.pp-quiet { margin: 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.pp-scroll { overflow-x: auto; }
.pp-table { width: 100%; border-collapse: collapse; font-size: var(--ax-fs-sm); }
.pp-table th { text-align: left; font-weight: 600; color: var(--ax-text-2); font-size: var(--ax-fs-xs); padding: 4px 12px 4px 0; white-space: nowrap; }
.pp-table td { padding: 8px 12px 8px 0; border-top: var(--ax-border-w) solid var(--ax-border); vertical-align: top; }
.pp-table td small { display: block; color: var(--ax-text-2); }
.pp-state { font-weight: 600; white-space: nowrap; }
.pp-state.is-ok { color: var(--ax-green-ink, var(--ax-text)); }
.pp-state.is-warn { color: var(--ax-amber-ink); }
.pp-state.is-bad { color: var(--ax-red-ink); }
.pp-state.is-off { color: var(--ax-text-2); font-weight: 400; }
.pp-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.pp-items li { padding-top: 8px; border-top: var(--ax-border-w) solid var(--ax-border); }
.pp-items p { margin: 0; }
.pp-text { overflow-wrap: anywhere; }
.pp-meta { margin-top: 2px; display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
@media (prefers-reduced-motion: reduce) { .pp-caret { transition: none; } }
`

const PEOPLE_SCRIPT = `
(function () {
  var list = document.getElementById('pp-list');
  var msg = document.getElementById('pp-msg');
  var none = document.getElementById('pp-none');
  var open = {};   // person id -> the last detail loaded for it
  var people = [];
  var ROLE = { owner: 'Owner', member: 'Member', client: 'Client', guest: 'Guest' };
  var REQUEST = {
    in_progress: ['In progress', 'ok'], waiting_owner: ['Waiting on you', 'warn'], waiting_other: ['Waiting on another agent', 'warn'],
    needs_attention: ['Needs attention', 'bad'], done: ['Done', 'off'], declined: ['Declined', 'off'], dropped: ['Dropped', 'off']
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers(json) {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (json) h['Content-Type'] = 'application/json';
    if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'pp-msg' + (bad ? ' is-bad' : ''); }
  function when(v) {
    var d = new Date(v);
    return v && !isNaN(d) ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  }
  function flat(s) { return String(s == null ? '' : s).split(/[ \\t\\r\\n]+/).join(' ').trim().slice(0, 200); }
  function state(label, tone) { return '<span class="pp-state is-' + tone + '">' + esc(label) + '</span>'; }
  function deviceState(d) {
    if (d.state === 'active') return state('Active', 'ok');
    if (d.state === 'pending' && d.answer === 'yes') return state('Approved', 'ok') + '<small>not opened since</small>';
    if (d.state === 'pending' && d.answer === 'no') return state('Refused', 'off');
    if (d.state === 'pending') return state('Waiting for your approval', 'warn');
    return state('Ended', 'off') + (d.removedReason ? '<small>' + esc(d.removedReason) + '</small>' : '');
  }
  function machines(id, devices, listed) {
    if (!devices.length) return '<p class="pp-quiet">No machine paired.' + (listed ? ' Invite them with <code>agentx people invite ' + esc(id) + '</code>.' : '') + '</p>';
    var rows = devices.map(function (d) {
      var end = d.state === 'removed' ? '' : '<button type="button" class="ax-btn ax-btn--danger" data-end="' + esc(d.tokenId) + '" data-person="' + esc(id) + '" data-name="' + esc(d.name) + '">End access</button>';
      return '<tr><td>' + esc(d.name) + '<small>' + esc(d.tokenId) + '</small></td>' +
        '<td>' + deviceState(d) + '</td>' +
        '<td>' + esc(d.address || 'not recorded') + (d.network ? '<small>as ' + esc(d.network) + '</small>' : '') + '</td>' +
        '<td>' + esc(when(d.createdAt)) + '</td>' +
        '<td>' + (d.lastSeenAt ? esc(when(d.lastSeenAt)) + (d.lastAddress ? '<small>from ' + esc(d.lastAddress) + '</small>' : '') : 'Not used yet') + '</td>' +
        '<td>' + end + '</td></tr>';
    }).join('');
    return '<div class="pp-scroll"><table class="pp-table"><thead><tr><th scope="col">Machine</th><th scope="col">State</th><th scope="col">Paired from</th><th scope="col">First use</th><th scope="col">Last use</th><th scope="col" aria-label="Action"></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function requests(items) {
    if (!items.length) return '<p class="pp-quiet">No tracked request. Requests appear here once request tracking is on (<code>agentx requests settings</code>).</p>';
    return '<ol class="pp-items">' + items.map(function (r) {
      var s = REQUEST[r.state] || [r.state, 'off'];
      return '<li><p class="pp-text">' + esc(flat(r.text)) + '</p><p class="pp-meta">' + state(s[0], s[1]) + '<span>' + esc(r.agentId) + '</span><span>' + esc(r.channel) + '</span><span>' + esc(when(r.createdAt)) + '</span></p></li>';
    }).join('') + '</ol>';
  }
  function runs(items) {
    if (!items.length) return '<p class="pp-quiet">Nothing recorded yet.</p>';
    return '<ol class="pp-items">' + items.map(function (r) {
      var s = r.status === 'ok' ? ['Finished', 'off'] : r.status === 'in-flight' ? ['Running', 'ok'] : [r.status, 'bad'];
      return '<li><p class="pp-text">' + esc(flat(r.messagePreview)) + '</p><p class="pp-meta">' + state(s[0], s[1]) + '<span>' + esc(r.agentId) + '</span><span>' + esc(r.channel || '') + '</span><span>' + esc(when(r.startedAt)) + '</span></p></li>';
    }).join('') + '</ol>';
  }
  function detail(id) {
    var d = open[id];
    if (!d || d === true) return '<p class="pp-quiet" style="padding-top:14px">Loading…</p>';
    return '<h3>Machines</h3>' + machines(id, d.devices || [], !(d.person && d.person.builtIn)) +
      '<h3>Requests, newest first</h3>' + (d.database ? requests(d.requests || []) : '<p class="pp-quiet">The database could not be opened. Start the dashboard from the folder that holds agentx.json.</p>') +
      '<h3>Latest turns they started</h3>' + runs(d.runs || []);
  }
  function person(p) {
    var isOpen = !!open[p.id];
    var n = p.machines.active + p.machines.pending;
    var count = (n ? n + (n === 1 ? ' machine' : ' machines') : 'No machine') + (p.machines.pending ? ', <b>' + p.machines.pending + ' waiting for approval</b>' : '');
    var ids = p.identities.length ? p.identities.map(function (i) { return '<span>' + esc(i) + '</span>'; }).join('')
      : (p.builtIn ? 'What you do on this machine (voice, app, dashboard) is recorded here.' : 'No channel identity yet');
    var limit = p.agents.length ? '<span class="ax-badge ax-badge--ghost">Agents: ' + esc(p.agents.join(', ')) + '</span>' : '';
    return '<li class="pp-person" data-person="' + esc(p.id) + '">' +
      '<button type="button" class="pp-head" aria-expanded="' + isOpen + '" aria-controls="pp-body-' + esc(p.id) + '" data-open="' + esc(p.id) + '">' +
        '<span class="pp-caret" aria-hidden="true">&#9656;</span>' +
        '<span class="pp-name">' + esc(p.name) + '</span>' +
        '<span class="ax-badge' + (p.role === 'owner' ? ' ax-badge--accent' : '') + '">' + esc(ROLE[p.role] || p.role) + '</span>' +
        '<span class="pp-id">' + esc(p.id) + '</span>' + limit +
        '<span class="pp-count">' + count + '</span>' +
        '<span class="pp-ids">' + ids + '</span>' +
      '</button>' +
      '<div class="pp-body" id="pp-body-' + esc(p.id) + '"' + (isOpen ? '' : ' hidden') + '>' + (isOpen ? detail(p.id) : '') + '</div>' +
      '</li>';
  }
  function draw() {
    // Redrawing would drop the keyboard focus: put it back on the same control.
    var a = document.activeElement, key = a && list.contains(a) ? (a.getAttribute('data-open') ? 'open:' + a.getAttribute('data-open') : a.getAttribute('data-end') ? 'end:' + a.getAttribute('data-end') : '') : '';
    list.innerHTML = people.length ? people.map(person).join('') : '<li class="pp-empty">Nobody is listed.</li>';
    if (key) {
      var again = list.querySelector(key.indexOf('open:') === 0 ? '[data-open="' + key.slice(5) + '"]' : '[data-end="' + key.slice(4) + '"]') || list.querySelector('[data-open]');
      if (again) again.focus();
    }
  }
  function get(path) {
    return fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: headers(false) }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    });
  }
  function loadOne(id) {
    return get('/api/admin/people/' + encodeURIComponent(id)).then(function (d) { if (open[id]) { open[id] = d; draw(); } })
      .catch(function (e) { say('Could not read ' + id + ': ' + e.message, true); });
  }
  function load() {
    return get('/api/admin/people').then(function (d) {
      people = d.people || [];
      none.hidden = d.paired > 0;
      Object.keys(open).forEach(function (id) { if (!people.some(function (p) { return p.id === id; })) delete open[id]; });
      draw();
      Object.keys(open).forEach(loadOne);
    }).catch(function (e) { say('Could not read the people list: ' + e.message, true); });
  }
  list.addEventListener('click', function (ev) {
    var end = ev.target.closest('button[data-end]');
    if (end) {
      var id = end.getAttribute('data-person'), token = end.getAttribute('data-end'), name = end.getAttribute('data-name');
      if (!confirm('End access for "' + name + '"? This machine stops at once. To use it again, the person needs a new invite.')) return;
      end.disabled = true;
      fetch('/api/admin/people/' + encodeURIComponent(id) + '/devices/' + encodeURIComponent(token) + '/end', { method: 'POST', credentials: 'same-origin', headers: headers(true), body: '{}' })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
        .then(function () { say('Access ended for "' + name + '".', false); return load(); })
        // The button is gone with the machine's access: keep the keyboard on this person.
        .then(function () { var h = list.querySelector('[data-open="' + id + '"]'); if (h) h.focus(); })
        .catch(function (e) { say('Could not end access: ' + e.message, true); end.disabled = false; });
      return;
    }
    var head = ev.target.closest('button[data-open]');
    if (!head) return;
    var pid = head.getAttribute('data-open');
    if (open[pid]) { delete open[pid]; draw(); return; }
    open[pid] = true;
    draw();
    loadOne(pid);
  });
  load();
  setInterval(load, 30000);
})();
`
