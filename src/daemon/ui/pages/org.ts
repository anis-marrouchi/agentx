// --- Org page (/org) (#1169) ---
//
// The org chart (business.orgChart) as a tree: each agent with its role,
// who it reports to, its one-line job and its status. From a card: open the
// agent's activity, pause or resume it. Agents another agent created wait
// in Approvals; their card says so. People from `people` that a relation
// names get a card too (#1418), and a card lists its dotted-line and
// acts-for links. A problem with the relations shows above the tree.
//
// People and agents look different at a glance (#1681): a person's card is
// round-cornered with a thick accent border and a person icon; an agent's is
// square-cornered with a robot icon. Both say "Person" or "Agent" in words,
// and a legend above the chart says so too. Departments (#1681,
// business.departments) show under the tree as one band each: the head's
// card first, then the members; each card in the tree names its department.
//
// Edit org (#1420), owner only: who is in the chart, their roles and the
// lines between them, with a confirm step for moves and removals. The
// panel is org-setup.ts; anyone else sees no Edit button. /org#edit opens
// it straight away. The Wall's org pages only read and link here.
//
// API: GET /api/admin/org, POST /api/admin/org/hold and
// POST /api/admin/org/chart, in admin-panel.ts.
// Pictures (#1425): GET /api/admin/pictures, in pictures-panel.ts.
// Client JS avoids backslash escapes: they collapse inside this template
// literal.

import { pageHead, renderShell, type TopbarPeer } from ".."
import { injectFns } from "../inject"
import { HUB_NEEDS_YOU, HUB_PATH } from "../hub-name"
import { orgConfirmFor, orgEditHtml } from "./org-setup"
import { AGENT_ICON, PERSON_ICON } from "./org-icons"

export { AGENT_ICON, PERSON_ICON }

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
    lead: "Who your people and agents are, who each one reports to, and what each agent is doing now. Pause an agent here; it starts nothing until you resume it. The owner also changes the chart here, with Edit org.",
  }) + `
  <div class="org">
    <div id="org-msg" class="org-msg" role="status" aria-live="polite"></div>
    <div class="org-bar">
      <ul class="org-legend" aria-label="Legend">
        <li><span class="org-key is-agent">${AGENT_ICON}</span>Agent: square corners, status and Pause</li>
        <li><span class="org-key is-person">${PERSON_ICON}</span>Person: round corners, no status</li>
      </ul>
      <button type="button" id="org-edit-btn" class="ax-btn" data-org-edit aria-controls="org-edit" aria-expanded="false" hidden>Edit org</button></div>
    <section id="org-edit" class="org-edit" aria-label="Edit the org chart" hidden></section>
    <section id="org-none" class="org-none" hidden aria-labelledby="org-none-title">
      <h2 id="org-none-title">No org chart yet</h2>
      <p>Give each agent a role and a boss under <code>business.orgChart</code> in <code>agentx.json</code>, with the roles under <code>business.roles</code>. Until then every agent is listed below, side by side.</p>
    </section>
    <p id="org-problem" class="org-problem" role="alert" hidden></p>
    <div id="org-tree" class="org-tree" aria-label="Org chart"><p class="org-quiet">Loading…</p></div>
    <section id="org-depts" hidden aria-labelledby="org-depts-title">
      <h2 id="org-depts-title" class="org-h2">Departments</h2>
      <div id="org-depts-list" class="org-depts"></div>
    </section>
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
.org-tree > ul { display: flex; gap: 24px; width: max-content; margin: 0 auto; }
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
.org-top--pic { align-items: center; }
.org-av { width: 32px; height: 32px; border-radius: 50%; flex: none; overflow: hidden; background: var(--ax-surface-2); }
.org-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
/* Person vs agent (#1681): shape, border and icon, never colour alone. */
.org-card { border-radius: var(--ax-radius-sm); }
.org-card.is-person { background: var(--ax-surface-2); border: 2px solid var(--ax-accent); border-radius: 22px; }
.org-kind { font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-badge { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex: none; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-badge.is-person { color: var(--ax-accent); font-weight: 600; }
.org-ico { flex: none; display: block; }
.org-dept-tag { display: inline-block; margin: 6px 6px 0 0; padding: 0 8px; border-radius: var(--ax-radius-sm); font-size: var(--ax-fs-xs); background: var(--ax-surface-2); color: var(--ax-text-2); border: var(--ax-border-w) solid var(--ax-border); }
.org-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 auto 0 0; padding: 0; list-style: none; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-legend li { display: inline-flex; align-items: center; gap: 6px; }
.org-key { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 18px; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: 3px; background: var(--ax-surface); color: var(--ax-text-2); }
.org-key.is-person { border: 2px solid var(--ax-accent); border-radius: 9px; background: var(--ax-surface-2); color: var(--ax-accent); }
.org-depts { display: flex; flex-direction: column; gap: 12px; }
.org-band { padding: 12px 14px; border: var(--ax-border-w) solid var(--ax-border); border-left: 4px solid var(--ax-accent); border-radius: var(--ax-radius); background: var(--ax-surface); }
.org-band-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0 0 10px; }
.org-band-head h3 { margin: 0; font-size: 15px; }
.org-band-head span { font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-band-lead { margin: 0 0 8px; }
.org-band-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.org-mini { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 10px; font-size: var(--ax-fs-sm); color: var(--ax-text); text-decoration: none; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-sm); background: var(--ax-bg); }
.org-mini.is-person { border: 2px solid var(--ax-accent); border-radius: 999px; background: var(--ax-surface-2); }
.org-mini .org-ico { color: var(--ax-text-2); }
.org-mini.is-person .org-ico { color: var(--ax-accent); }
.org-mini small { font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-mini b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org-head-tag { padding: 0 6px; border-radius: 999px; font-size: var(--ax-fs-xs); font-weight: 600; background: var(--ax-accent); color: var(--ax-bg); }
.org-links { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 12px; margin: 0 0 8px; }
.org-edit { margin: 0 0 24px; padding: 12px 16px 16px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.oe-lead { margin: 0 0 6px; color: var(--ax-text-2); }
.oe-msg { min-height: 1.4em; margin: 0 0 6px; }
.oe-msg.is-bad { color: var(--ax-red-ink); }
.oe-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 8px; padding: 10px 12px; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius); background: var(--ax-surface-2); }
.oe-confirm-text { flex: 1 1 240px; margin: 0; }
.oe-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin: 6px 0 10px; }
.oe-form label, .oe-role { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-edit select, .org-edit input { font: inherit; font-size: var(--ax-fs-sm); min-width: 0; max-width: 100%; padding: 5px 8px; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.oe-rows { list-style: none; margin: 0; padding: 0; }
.oe-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-bottom: var(--ax-border-w) solid var(--ax-border); }
.oe-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; flex: 1 1 160px; min-width: 0; }
.oe-role { flex: 0 1 200px; }
.oe-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.oe-legend { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 16px 0 0; padding: 10px 12px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); }
.oe-legend dt { font-weight: 600; }
.oe-legend dd { margin: 0; color: var(--ax-text-2); }
@media (max-width: 640px) {
  .org { padding: 0 16px 48px; }
  .org-edit { padding: 10px 12px 14px; }
  .oe-form > *, .oe-role { flex: 1 1 100%; }
  .oe-legend { grid-template-columns: 1fr; }
  .org-legend { flex-direction: column; }
  .org-band { padding: 10px 12px; }
}
.org-problem { margin: 0 0 12px; padding: 10px 14px; border: var(--ax-border-w) solid var(--ax-amber-ink); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); color: var(--ax-amber-ink); }
`

/** Client helpers for people in the tree (#1418), kept apart so a test can
 *  run them. withPeople(d) gives each person a relation names a card in
 *  d.roots: under its reports-to boss when that boss is in the tree, and
 *  with the agents that report to it underneath. names maps `agent:<id>` and
 *  `person:<id>` to a display name. */
export const ORG_PEOPLE_JS = `
  function withPeople(d) {
    var rels = d.relations || [], names = {}, nodes = {};
    (function index(list) { (list || []).forEach(function (n) { nodes['agent:' + n.id] = n; names['agent:' + n.id] = n.name; index(n.reports); }); })(d.roots);
    (d.outside || []).forEach(function (n) { names['agent:' + n.id] = n.name; });
    var named = {};
    rels.forEach(function (r) { named[r.from] = true; named[r.to] = true; });
    (d.departments || []).forEach(function (dep) { (dep.head ? [dep.head] : []).concat(dep.members || []).forEach(function (k) { named[k] = true; }); });
    (d.people || []).forEach(function (p) {
      var key = 'person:' + p.id;
      names[key] = p.name;
      if (named[key] || p.placed) nodes[key] = { kind: 'person', id: p.id, name: p.name, title: p.title, reports: [] };
    });
    rels.forEach(function (r) {
      var n = nodes[r.from];
      if (!n || r.type === 'reports-to') return;
      var k = r.type === 'dotted-line' ? 'dottedLine' : 'actsFor';
      (n[k] = n[k] || []).push(r.to);
    });
    function within(n, target) { return n === target || (n.reports || []).some(function (c) { return within(c, target); }); }
    var roots = d.roots.slice();
    function moveUnder(n, key) {
      var boss = nodes[key];
      if (!boss || within(n, boss)) return;
      var i = roots.indexOf(n);
      if (i < 0) return;
      roots.splice(i, 1);
      boss.reports.push(n);
    }
    Object.keys(nodes).forEach(function (key) { if (key.indexOf('person:') === 0) roots.push(nodes[key]); });
    d.roots.forEach(function (n) { if (String(n.reportsTo || '').indexOf('person:') === 0) moveUnder(n, n.reportsTo); });
    rels.forEach(function (r) { if (r.type === 'reports-to' && r.from.indexOf('person:') === 0 && nodes[r.from]) moveUnder(nodes[r.from], r.to); });
    return { roots: roots, names: names };
  }
`

const ORG_SCRIPT = `
(function () {${ORG_PEOPLE_JS}
  ${injectFns({ orgConfirmFor, orgEditHtml })}
  var tree = document.getElementById('org-tree');
  var msg = document.getElementById('org-msg');
  var warned = false;
  var pics = {};   // agent id -> picture address (#1425); none keeps the card as it was
  var STATE = { working: 'Working', idle: 'Idle', paused: 'Paused', waiting: 'Waits for your approval', unknown: 'Status unknown' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers(json) {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (json) h['Content-Type'] = 'application/json';
    if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  var PERSON_ICON = '${PERSON_ICON}', AGENT_ICON = '${AGENT_ICON}';
  var names = {}, deptsOf = {};
  function badge(person) {
    return person ? '<span class="org-badge is-person">' + PERSON_ICON + 'Person</span>' : '<span class="org-badge is-agent">' + AGENT_ICON + 'Agent</span>';
  }
  function deptTags(key) {
    return (deptsOf[key] || []).map(function (n) { return '<span class="org-dept-tag">' + esc(n) + '</span>'; }).join('');
  }
  function nameOf(ref) { return names[ref] || String(ref).replace(/^[a-z]+:/, ''); }
  function links(n) {
    var rows = (n.dottedLine || []).map(function (r) { return 'Dotted line to ' + nameOf(r); })
      .concat((n.actsFor || []).map(function (r) { return 'Acts for ' + nameOf(r); }));
    return rows.length ? '<div class="org-links">' + rows.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</div>' : '';
  }
  function personCard(n) {
    return '<div class="org-card is-person" data-person="' + esc(n.id) + '">'
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span>' + badge(true) + '</div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + deptTags('person:' + n.id)
      + links(n) + '</div>';
  }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'org-msg' + (bad ? ' is-bad' : ''); }
  function card(n) {
    if (n.kind === 'person') return personCard(n);
    var id = encodeURIComponent(n.id);
    var state = n.status === 'working' && n.active > 1 ? 'Working on ' + n.active : STATE[n.status] || n.status;
    if (n.status === 'paused' && n.heldBy) state += ' by ' + n.heldBy;
    if (n.status === 'waiting' && n.heldBy) state += ' (created by ' + n.heldBy + ')';
    var acts = '<a href="${HUB_PATH}#page=activity&a-agent=' + id + '&a-period=30d">Activity</a><a href="/admin/agents/' + id + '">Agent page</a>';
    if (n.status === 'waiting') acts += '<a href="${HUB_NEEDS_YOU}">Decide in Needs you</a>';
    else if (n.status === 'paused') acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="0">Resume</button>';
    else acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="1">Pause</button>';
    return '<div class="org-card is-' + esc(n.status) + '" data-agent="' + esc(n.id) + '">'
      + '<div class="org-top' + (pics[n.id] ? ' org-top--pic' : '') + '">' + (pics[n.id] ? '<span class="org-av"><img src="' + esc(pics[n.id]) + '" alt=""></span>' : '') + '<span class="org-name">' + esc(n.name) + '</span><span class="org-id">' + esc(n.id) + '</span>' + badge(false) + '</div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + deptTags('agent:' + n.id)
      + (n.job ? '<p class="org-job">' + esc(n.job) + '</p>' : '')
      + links(n)
      + '<span class="org-state is-' + esc(n.status) + '">' + esc(state) + '</span>'
      + '<div class="org-acts">' + acts + '</div></div>';
  }
  // One band per department (#1681): the head first, then the members.
  function mini(key, head) {
    var person = key.indexOf('person:') === 0, id = key.replace(/^[a-z]+:/, '');
    var inner = (person ? PERSON_ICON : AGENT_ICON) + '<b>' + esc(nameOf(key)) + '</b><small>' + (person ? 'Person' : 'Agent') + '</small>'
      + (head ? '<span class="org-head-tag">Head</span>' : '');
    var cls = 'org-mini ' + (person ? 'is-person' : 'is-agent');
    return person ? '<span class="' + cls + '">' + inner + '</span>'
      : '<a class="' + cls + '" href="/admin/agents/' + encodeURIComponent(id) + '">' + inner + '</a>';
  }
  function band(dep) {
    var n = dep.members.length;
    return '<section class="org-band" data-dept="' + esc(dep.id) + '" aria-labelledby="org-band-' + esc(dep.id) + '">'
      + '<div class="org-band-head"><h3 id="org-band-' + esc(dep.id) + '">' + esc(dep.name) + '</h3>'
      + '<span>' + (dep.head ? 'Headed by ' + esc(nameOf(dep.head)) : 'No head yet') + ' · ' + n + (n === 1 ? ' member' : ' members') + '</span></div>'
      + (dep.head ? '<div class="org-band-lead">' + mini(dep.head, true) + '</div>' : '')
      + (n ? '<ul class="org-band-row">' + dep.members.map(function (k) { return '<li>' + mini(k, false) + '</li>'; }).join('') + '</ul>' : '')
      + '</section>';
  }
  function branch(list) {
    return '<ul>' + list.map(function (n) {
      return '<li>' + card(n) + (n.reports && n.reports.length ? branch(n.reports) : '') + '</li>';
    }).join('') + '</ul>';
  }
  async function load() {
    try {
      var pr = fetch('/api/admin/pictures', { headers: headers(false) }).then(function (x) { return x.ok ? x.json() : null; }).catch(function () { return null; });
      var r = await fetch('/api/admin/org', { headers: headers(false) });
      var d = await r.json();
      var p = await pr;
      pics = (p && p.agent) || {};
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      if (!d.exists) { tree.innerHTML = '<p class="org-quiet">No agentx.json in this folder.</p>'; return; }
      var probEl = document.getElementById('org-problem');
      probEl.hidden = !d.problem;
      probEl.textContent = d.problem ? 'Problem in the org relations: ' + d.problem : '';
      E.org = d;
      paintEdit();
      var org = withPeople(d);
      names = org.names;
      var depts = d.departments || [];
      deptsOf = {};
      depts.forEach(function (dep) { (dep.head ? [dep.head] : []).concat(dep.members).forEach(function (k) { (deptsOf[k] = deptsOf[k] || []).push(dep.name); }); });
      document.getElementById('org-none').hidden = org.roots.length > 0;
      tree.innerHTML = org.roots.length ? branch(org.roots) : '';
      document.getElementById('org-depts').hidden = depts.length === 0;
      document.getElementById('org-depts-list').innerHTML = depts.map(band).join('');
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
  // --- Edit org, owner only (#1420): the panel is orgEditHtml ---
  // E.pending: a move or removal waiting for Save the move or Cancel;
  // nothing is sent before Save the move. The panel repaints only when what
  // it shows changed, so the 15-second refresh never resets a field in use.
  var editBtn = document.getElementById('org-edit-btn');
  var editBox = document.getElementById('org-edit');
  var E = { open: /^#edit$/.test(location.hash || ''), org: null, msg: '', bad: false, pending: null, painted: '', focus: false };
  function paintEdit() {
    var can = !!(E.org && E.org.canEdit && E.org.setup && E.org.choices);
    if (!can) E.open = false;
    editBtn.hidden = !can;
    editBtn.textContent = E.open ? 'Done editing' : 'Edit org';
    editBtn.setAttribute('aria-expanded', E.open ? 'true' : 'false');
    editBox.hidden = !E.open;
    if (!E.open) { E.pending = null; E.painted = ''; editBox.innerHTML = ''; return; }
    var key = JSON.stringify([E.org.setup, E.org.choices, E.msg, E.bad, E.pending && E.pending.text]);
    if (key === E.painted) return;
    E.painted = key;
    editBox.innerHTML = orgEditHtml(E.org, { text: E.msg, bad: E.bad }, E.pending ? E.pending.text : '');
    if (E.focus) { var sv = document.getElementById('oe-confirm-save'); if (sv && sv.focus) sv.focus(); }
    E.focus = false;
  }
  function field(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  async function postChart(change) {
    var r = await fetch('/api/admin/org/chart', { method: 'POST', headers: headers(true), body: JSON.stringify(change) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }
  // Sends the steps in order. If a later one is refused, the undo steps put
  // back what the earlier ones changed.
  async function saveChart(steps, undo, button) {
    if (button) button.disabled = true;
    var done = 0, d = {};
    try {
      for (; done < steps.length; done++) d = await postChart(steps[done]);
      E.msg = (d.summary || 'Saved') + '. Saved.'; E.bad = false;
    } catch (e) {
      E.msg = e.message; E.bad = true;
      if (done > 0) {
        try { for (var i = 0; i < undo.length; i++) await postChart(undo[i]); E.msg += ' Nothing was changed.'; }
        catch (e2) { E.msg += ' Putting the old line back failed too: ' + e2.message + '. Check the chart below.'; }
      }
    }
    await load();
    paintEdit();
    if (button) button.disabled = false;
  }
  function ask(change, button) {
    var c = E.org && E.org.setup ? orgConfirmFor(E.org.setup, change) : null;
    if (!c) { saveChart([change], [], button); return; }
    E.pending = c; E.msg = ''; E.bad = false; E.focus = true;
    paintEdit();
  }
  function cancel() {
    E.pending = null; E.msg = 'Cancelled. Nothing changed.'; E.bad = false;
    paintEdit();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('[data-org-edit]')) { E.open = !E.open; E.msg = ''; E.bad = false; paintEdit(); return; }
    var b = t && t.closest ? t.closest('[data-oe]') : null;
    if (!b) return;
    var op = b.getAttribute('data-oe');
    if (op === 'confirm') {
      var p = E.pending;
      if (!p) return;
      E.pending = null;
      saveChart(p.steps, p.undo, b);
    } else if (op === 'cancel') {
      cancel();
    } else if (op === 'add-member') {
      if (!field('oe-add-member')) return;
      saveChart([{ op: op, member: field('oe-add-member'), role: field('oe-add-role') }], [], b);
    } else if (op === 'set-role') {
      saveChart([{ op: op, member: b.getAttribute('data-oe-member'), role: field('oe-role-' + b.getAttribute('data-oe-i')) }], [], b);
    } else if (op === 'add-relation') {
      ask({ op: op, from: field('oe-rel-from'), type: field('oe-rel-type'), to: field('oe-rel-to') }, b);
    } else if (op === 'remove-member') {
      ask({ op: op, member: b.getAttribute('data-oe-member') }, b);
    } else if (op === 'remove-relation') {
      ask({ op: op, from: b.getAttribute('data-oe-from'), type: b.getAttribute('data-oe-type'), to: b.getAttribute('data-oe-to') }, b);
    }
  });
  // Escape cancels a change waiting for Save the move.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && E.pending) { ev.preventDefault(); cancel(); }
  });
  load();
  setInterval(load, 15000);
})();
`
