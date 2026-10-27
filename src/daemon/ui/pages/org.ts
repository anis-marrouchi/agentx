// --- Org page (/org) (#1169) ---
//
// The org chart (business.orgChart) as a tree: each agent with its role,
// who it reports to, its one-line job and its status. From a card: open the
// agent's activity, pause or resume it. Agents another agent created wait
// in Approvals; their card says so. People from `people` sit in the tree
// once a relation names them (#1418); a card lists its dotted-line and
// acts-for links.
//
// API: GET /api/admin/org and POST /api/admin/org/hold, in admin-panel.ts.
// Client JS avoids backslash escapes: they collapse inside this template
// literal.

import { pageHead, renderShell, type TopbarPeer } from ".."

export interface OrgPageOpts {
  peers?: TopbarPeer[]
  localToken?: string
}

export function renderOrgPage(opts: OrgPageOpts = {}): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const body = pageHead({
    kicker: "Operations",
    title: "Org",
    lead: "Who your people and agents are, who each one reports to, and what each agent is doing now. Pause an agent here; it starts nothing until you resume it.",
  }) + `
  <div class="org">
    <div id="org-msg" class="org-msg" role="status" aria-live="polite"></div>
    <section id="org-none" class="org-none" hidden aria-labelledby="org-none-title">
      <h2 id="org-none-title">No org chart yet</h2>
      <p>Give each agent a role and a boss under <code>business.orgChart</code> in <code>agentx.json</code>, with the roles under <code>business.roles</code>. Until then every agent is listed below, side by side.</p>
    </section>
    <ul id="org-problems" class="org-problems" hidden></ul>
    <div id="org-tree" class="org-tree" aria-label="Org chart"><p class="org-quiet">Loading…</p></div>
    <section id="org-outside" hidden aria-labelledby="org-outside-title">
      <h2 id="org-outside-title" class="org-h2">Not in the org chart</h2>
      <ul id="org-outside-list" class="org-row"></ul>
    </section>
  </div>`
  return renderShell({
    title: "AgentX · Org",
    activeTab: "org",
    subtitle: "Org",
    peers: opts.peers,
    body,
    css: ORG_CSS,
    scripts: `${tokenScript}<script>${ORG_SCRIPT}</script>`,
  })
}

const ORG_CSS = `
.org { max-width: 1040px; margin: 0 auto; padding: 0 24px 64px; }
.org-msg { min-height: 1.4em; margin: 4px 0 8px; font-size: var(--ax-fs-sm); }
.org-msg.is-bad { color: var(--ax-red-ink); }
.org-quiet { color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.org-none { margin: 0 0 16px; padding: 14px 16px; border: var(--ax-border-w) dashed var(--ax-border-2); border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.org-none h2 { margin: 0 0 6px; font-size: 15px; }
.org-none p { margin: 0; color: var(--ax-text-2); }
.org code { font-family: var(--ax-mono); font-size: 11.5px; background: var(--ax-surface-2); padding: 1px 6px; border-radius: var(--ax-radius-sm); }
.org-h2 { margin: 28px 0 10px; font-size: 14px; }
.org-tree { overflow-x: auto; padding-bottom: 8px; }
.org-tree ul, .org-row { list-style: none; margin: 0; padding: 0; }
.org-tree > ul { display: flex; gap: 24px; justify-content: center; }
.org-tree li { position: relative; display: flex; flex-direction: column; align-items: center; }
.org-tree li > ul { display: flex; padding-top: 22px; position: relative; }
.org-tree li > ul::before { content: ""; position: absolute; top: 0; left: 50%; height: 11px; border-left: var(--ax-border-w) solid var(--ax-border-2); }
.org-tree li > ul > li { padding: 11px 8px 0; }
.org-tree li > ul > li::before { content: ""; position: absolute; top: 0; left: 0; right: 0; border-top: var(--ax-border-w) solid var(--ax-border-2); }
.org-tree li > ul > li:first-child::before { left: 50%; }
.org-tree li > ul > li:last-child::before { right: 50%; }
.org-tree li > ul > li:only-child::before { display: none; }
.org-tree li > ul > li::after { content: ""; position: absolute; top: 0; left: 50%; height: 11px; border-left: var(--ax-border-w) solid var(--ax-border-2); }
.org-row { display: flex; flex-wrap: wrap; gap: 12px; }
.org-card { width: 236px; padding: 12px 14px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); text-align: left; }
.org-card.is-paused, .org-card.is-waiting { border-style: dashed; }
.org-top { display: flex; align-items: baseline; gap: 8px; }
.org-name { font-size: 15px; font-weight: 600; }
.org-id { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-title { margin: 2px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.org-job { margin: 8px 0 0; font-size: var(--ax-fs-sm); }
.org-state { display: inline-block; margin-top: 8px; padding: 1px 8px; border-radius: 999px; font-size: var(--ax-fs-xs); border: var(--ax-border-w) solid var(--ax-border-2); color: var(--ax-text-2); }
.org-state.is-working { color: var(--ax-green-ink, var(--ax-text)); border-color: var(--ax-green-ink, var(--ax-text)); }
.org-state.is-paused, .org-state.is-waiting { color: var(--ax-amber-ink); border-color: var(--ax-amber-ink); }
.org-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.org-acts a, .org-acts button { font: inherit; font-size: var(--ax-fs-xs); padding: 3px 9px; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-surface-2); color: var(--ax-text); text-decoration: none; cursor: pointer; }
.org-acts button:disabled { opacity: 0.6; cursor: default; }
.org-card.is-person { background: var(--ax-surface-2); }
.org-kind { font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-links { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-problems { margin: 0 0 12px; padding: 10px 14px 10px 30px; border: var(--ax-border-w) solid var(--ax-amber-ink); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); color: var(--ax-amber-ink); }
`

const ORG_SCRIPT = `
(function () {
  var tree = document.getElementById('org-tree');
  var msg = document.getElementById('org-msg');
  var warned = false;
  var STATE = { working: 'Working', idle: 'Idle', paused: 'Paused', waiting: 'Waits for your approval', unknown: 'Status unknown' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers(json) {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (json) h['Content-Type'] = 'application/json';
    if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  var names = {};
  function nameOf(ref) { return names[ref] || String(ref).replace(/^[a-z]+:/, ''); }
  function index(list) { (list || []).forEach(function (n) { names[n.kind + ':' + n.id] = n.name; index(n.reports); }); }
  function links(n) {
    var rows = (n.dottedLine || []).map(function (r) { return 'Dotted line to ' + nameOf(r); })
      .concat((n.actsFor || []).map(function (r) { return 'Acts for ' + nameOf(r); }));
    return rows.length ? '<div class="org-links">' + rows.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</div>' : '';
  }
  function personCard(n) {
    return '<div class="org-card is-person" data-person="' + esc(n.id) + '">'
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span><span class="org-kind">Person</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + links(n) + '</div>';
  }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'org-msg' + (bad ? ' is-bad' : ''); }
  function card(n) {
    if (n.kind === 'person') return personCard(n);
    var id = encodeURIComponent(n.id);
    var state = n.status === 'working' && n.active > 1 ? 'Working on ' + n.active : STATE[n.status] || n.status;
    if (n.status === 'paused' && n.heldBy) state += ' by ' + n.heldBy;
    if (n.status === 'waiting' && n.heldBy) state += ' (created by ' + n.heldBy + ')';
    var acts = '<a href="/agents/' + id + '/history">Activity</a><a href="/admin/agents/' + id + '">Agent page</a>';
    if (n.status === 'waiting') acts += '<a href="/approvals">Decide in Approvals</a>';
    else if (n.status === 'paused') acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="0">Resume</button>';
    else acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="1">Pause</button>';
    return '<div class="org-card is-' + esc(n.status) + '" data-agent="' + esc(n.id) + '">'
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span><span class="org-id">' + esc(n.id) + '</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + (n.job ? '<p class="org-job">' + esc(n.job) + '</p>' : '')
      + links(n)
      + '<span class="org-state is-' + esc(n.status) + '">' + esc(state) + '</span>'
      + '<div class="org-acts">' + acts + '</div></div>';
  }
  function branch(list) {
    return '<ul>' + list.map(function (n) {
      return '<li>' + card(n) + (n.reports && n.reports.length ? branch(n.reports) : '') + '</li>';
    }).join('') + '</ul>';
  }
  async function load() {
    try {
      var r = await fetch('/api/admin/org', { headers: headers(false) });
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      if (!d.exists) { tree.innerHTML = '<p class="org-quiet">No agentx.json in this folder.</p>'; return; }
      names = {}; index(d.roots);
      var probs = document.getElementById('org-problems');
      probs.hidden = !(d.problems && d.problems.length);
      probs.innerHTML = (d.problems || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      document.getElementById('org-none').hidden = d.roots.length > 0;
      tree.innerHTML = d.roots.length ? branch(d.roots) : '';
      var out = document.getElementById('org-outside');
      out.hidden = d.outside.length === 0;
      document.getElementById('org-outside-list').innerHTML = d.outside.map(function (n) { return '<li>' + card(n) + '</li>'; }).join('');
      // Only clear the daemon warning, not the answer to a click.
      if (!d.live) { say('The daemon did not answer, so working or idle is unknown. Start it with: agentx daemon start', true); warned = true; }
      else if (warned) { say(''); warned = false; }
    } catch (e) { say('Could not load the org chart: ' + e.message, true); }
  }
  document.addEventListener('click', async function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-hold]') : null;
    if (!b) return;
    b.disabled = true;
    try {
      var r = await fetch('/api/admin/org/hold', { method: 'POST', headers: headers(true), body: JSON.stringify({ agent: b.getAttribute('data-hold'), paused: b.getAttribute('data-paused') === '1' }) });
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      say(d.summary || 'Saved.');
      await load();
    } catch (e) { say(e.message, true); b.disabled = false; }
  });
  load();
  setInterval(load, 15000);
})();
`
