// --- Guest meshes: the host's panel (/guests) (#380) ---
//
// Every grant this node opened to another organisation: what it may
// reach, what it is doing, what it did, with pause, resume, widen,
// narrow and end at hand. Data from /api/guests, which the dashboard
// proxies to the daemon's /mesh/guests.

import { pageHead, renderShell, type TopbarPeer } from "../index"

export function renderGuestsPage(opts: { peers?: TopbarPeer[] }): string {
  const body = pageHead({
    kicker: "Operations",
    title: "Guest meshes",
    lead: "Other organisations let into part of this mesh. Each grant names one agent of yours, what it may touch for them, how much freedom it has and until when. Nothing is shared until you open it.",
  }) + `
  <div id="gm-msg" class="gm-msg" role="status" aria-live="polite"></div>
  <ol id="gm-list" class="gm-list" aria-label="Grants"><li class="gm-empty">Loading…</li></ol>
  <p class="gm-note">Open a grant from a terminal: <code>agentx mesh guests invite --name "…" --guest "…" --agent &lt;id&gt;</code>. The guest joins with the code; its join arrives as a card in Approvals.</p>`
  return renderShell({
    title: "AgentX · Guest meshes",
    activeTab: "mesh",
    subtitle: "Guest meshes",
    peers: opts.peers,
    body,
    css: GUESTS_CSS,
    scripts: `<script>${GUESTS_SCRIPT}</script>`,
  })
}

const GUESTS_CSS = `
.gm-list { list-style: none; margin: 16px 0; padding: 0; display: grid; gap: 12px; }
.gm-empty { color: var(--ax-text-2); }
.gm-item { padding: 14px 16px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); }
.gm-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
.gm-head h2 { margin: 0; font-size: 16px; }
.gm-state { font-weight: 600; }
.gm-state.is-active { color: var(--ax-green-ink, var(--ax-text)); }
.gm-state.is-pending, .gm-state.is-paused { color: var(--ax-amber-ink); }
.gm-state.is-ended { color: var(--ax-text-2); }
.gm-meta { margin: 6px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); display: flex; flex-wrap: wrap; gap: 4px 14px; }
.gm-scope { margin: 8px 0 0; font-size: var(--ax-fs-sm); display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
.gm-scope b { font-weight: 600; }
.gm-btns { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.gm-trail { margin: 10px 0 0; padding: 0; list-style: none; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.gm-msg { min-height: 1.4em; margin: 8px 0 0; }
.gm-msg.is-bad { color: var(--ax-red-ink); }
.gm-note { color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
`

const GUESTS_SCRIPT = `
(function () {
  var list = document.getElementById('gm-list');
  var msg = document.getElementById('gm-msg');
  var STATE = { active: 'Active', pending: 'Waiting for your approval', paused: 'Paused', ended: 'Ended' };
  var LEVEL = { report: 'report: read only', propose: 'propose: no merge, deploy or delete', act: 'act: free inside the grant' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'gm-msg' + (bad ? ' is-bad' : ''); }
  function when(s) { return s ? String(s).slice(0, 16).replace('T', ' ') + ' UTC' : '-'; }
  function item(g) {
    var state = g.state === 'pending' && !g.guestNode ? 'Not joined yet' : (STATE[g.state] || g.state);
    var btns = '';
    if (g.state === 'active') btns += '<button type="button" class="ax-btn" data-act="pause" data-id="' + esc(g.id) + '">Pause</button>';
    if (g.state === 'paused') btns += '<button type="button" class="ax-btn" data-act="resume" data-id="' + esc(g.id) + '">Resume</button>';
    if (g.state !== 'ended') btns += '<button type="button" class="ax-btn" data-act="end" data-id="' + esc(g.id) + '">End</button>';
    var trail = (g.trail || []).map(function (e) { return '<li>' + esc(when(e.at)) + ' · ' + esc(e.event) + (e.detail ? ' · ' + esc(e.detail) : '') + '</li>'; }).join('');
    return '<li class="gm-item">' +
      '<div class="gm-head"><h2>' + esc(g.name) + '</h2><span class="gm-state is-' + esc(g.state) + '">' + esc(state) + '</span></div>' +
      '<p class="gm-meta"><span>Guest: ' + esc(g.guest) + (g.guestNode && g.guestNode.name ? ' (' + esc(g.guestNode.name) + ')' : '') + '</span><span>Agent: ' + esc(g.agentId) + '</span><span>Until ' + esc(String(g.expiresAt).slice(0, 10)) + '</span><span>' + esc(g.usage.turns) + ' turn(s), ' + esc(g.usage.tokens) + ' tokens</span>' + (g.usage.lastAt ? '<span>Last ' + esc(when(g.usage.lastAt)) + '</span>' : '') + '</p>' +
      '<div class="gm-scope"><b>Freedom</b><span>' + esc(LEVEL[g.level] || g.level) + '</span><b>Folders</b><span>' + esc(g.folders.join(', ') || 'none') + '</span><b>Skills</b><span>' + esc(g.skills.join(', ') || 'none') + '</span><b>Commands</b><span>' + esc(g.commands.join(', ') || 'none') + '</span></div>' +
      (btns ? '<div class="gm-btns">' + btns + '</div>' : '') +
      (trail ? '<ul class="gm-trail">' + trail + '</ul>' : '') +
      '</li>';
  }
  function load() {
    fetch('/api/guests', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { say(d.error, true); return; }
      var grants = d.grants || [];
      list.innerHTML = grants.length ? grants.map(item).join('') : '<li class="gm-empty">No guest grants yet.</li>';
    }).catch(function () { say('Could not read the grants. Is the daemon running?', true); });
  }
  list.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'end' && !confirm('End this grant for good? The guest loses access at once.')) return;
    b.disabled = true;
    fetch('/api/guests/' + encodeURIComponent(id) + '/' + act, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { say(d.error, true); b.disabled = false; return; }
        say((d.grant && d.grant.name) + ': ' + (STATE[d.grant.state] || d.grant.state) + (d.stopped ? ', ' + d.stopped + ' running turn(s) stopped' : ''), false);
        load();
      }).catch(function () { say('The daemon did not answer.', true); b.disabled = false; });
  });
  load();
  setInterval(load, 30000);
})();
`
