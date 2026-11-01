// --- Org page (/org) (#1169) ---
//
// The org chart (business.orgChart) as a tree: each agent with its role,
// who it reports to, its one-line job and its status. From a card: open the
// agent's activity, pause or resume it. Agents another agent created wait
// in Approvals; their card says so. People from `people` that a relation
// names get a card too (#1418), and a card lists its dotted-line and
// acts-for links. A problem with the relations shows above the tree.
//
// People and agents differ on sight (#1681): a tag with an icon and the
// word on each card, a person's card round-cornered with a warm fill and
// edge (an agent's stays plain), and a legend above the tree. The view
// switch sits in a toolbar row over the legend, with room for more tools. A department (#1681) is one dashed box in
// the tree: under its head, titled with its name, holding its members.
// When there are departments the page opens on the Departments view: a box
// per department, its name, the head's card on top and the members' cards
// in a grid, then "Not in a department"; "Chart" shows the tree.
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
import { ORG_EDIT_CSS, orgConfirmFor, orgEditHtml, orgEditor } from "./org-setup"
import { ORG_AGENT_ICON, ORG_PERSON_ICON } from "./org-icons"
import { ORG_PROJECTS_CSS, ORG_PROJECTS_JS } from "./org-projects"

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
      <button type="button" id="org-edit-btn" class="ax-btn" data-org-edit aria-controls="org-edit" aria-expanded="false" hidden>Edit org</button></div>
    <section id="org-edit" class="org-edit" aria-label="Edit the org chart" hidden></section>
    <section id="org-none" class="org-none" hidden aria-labelledby="org-none-title">
      <h2 id="org-none-title">No org chart yet</h2>
      <p>Give each agent a role and a boss under <code>business.orgChart</code> in <code>agentx.json</code>, with the roles under <code>business.roles</code>. Until then every agent is listed below, side by side.</p>
    </section>
    <p id="org-problem" class="org-problem" role="alert" hidden></p>
    <div class="org-toolbar" role="toolbar" aria-label="Org tools">
      <div id="org-views" class="org-views" role="group" aria-label="View"><button type="button" data-org-view="dept" aria-pressed="true" hidden>Departments</button><button type="button" data-org-view="chart" aria-pressed="false" aria-controls="org-chart-view">Chart</button><button type="button" data-org-view="projects" aria-pressed="false" aria-controls="org-projects">Projects</button></div>
      <div id="org-zoom" class="org-views org-zoom" role="group" aria-label="Zoom" hidden><button type="button" data-org-zoom="-1" aria-label="Zoom out">−</button><button type="button" id="org-zoom-at" data-org-zoom="0" title="Back to 100%">100%</button><button type="button" data-org-zoom="1" aria-label="Zoom in">+</button></div>
    </div>
    <section id="org-projects" class="org-projects" aria-label="Projects" hidden></section>
    <div id="org-chart-view">
    <ul class="org-legend" aria-label="Legend">
      <li><span class="org-tag is-agent">${ORG_AGENT_ICON}Agent</span>plain card, with its status</li>
      <li><span class="org-tag is-person">${ORG_PERSON_ICON}Person</span>round card, warm fill</li>
      <li id="org-legend-remote" hidden><span class="org-tag is-agent org-legend-remote">${ORG_AGENT_ICON}Agent</span>dashed: on another node, shown not routed; grey when that node is down</li>
      <li id="org-legend-dept" hidden><span class="org-legend-dept">Department</span>a dashed box round its members</li>
      <li id="org-legend-also" hidden><span class="org-home">Home: …</span>outlined: also works here, home is another department</li>
    </ul>
    <div id="org-depts" class="org-depts" hidden></div>
    <div id="org-more" class="org-more" hidden><button type="button" data-org-scroll="-1" aria-controls="org-tree" hidden></button><span>The chart is wider than the page. Scroll sideways to see everyone.</span><button type="button" data-org-scroll="1" aria-controls="org-tree" hidden></button></div>
    <div id="org-tree" class="org-tree" aria-label="Org chart"><p class="org-quiet">Loading…</p></div>
    <section id="org-outside" hidden aria-labelledby="org-outside-title">
      <h2 id="org-outside-title" class="org-h2">Not in the org chart</h2>
      <ul id="org-outside-list" class="org-row"></ul>
    </section>
    <section id="org-mesh" hidden aria-labelledby="org-mesh-title">
      <h2 id="org-mesh-title" class="org-h2">On other nodes, not placed yet</h2>
      <p class="org-quiet">Name one in a relation or a department as <code>agent:&lt;node&gt;/&lt;id&gt;</code> to place it. It is shown, never routed to.</p>
      <ul id="org-mesh-list" class="org-nodes"></ul>
    </section>
    </div>
  </div>`
  return renderShell({
    title: "AgentX · Org",
    activeTab: "org",
    subtitle: "Org",
    peers: opts.peers,
    body,
    css: ORG_CSS + ORG_EDIT_CSS + ORG_PROJECTS_CSS,
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
/* The chart takes the whole window width, not the text column (#1681). */
.org-tree { overflow-x: auto; padding: 12px 0 8px; width: calc(100vw - 48px); margin-left: calc(50% - 50vw + 24px); --org-fade-l: 0px; --org-fade-r: 0px; -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--org-fade-l), #000 calc(100% - var(--org-fade-r)), transparent 100%); mask-image: linear-gradient(to right, transparent 0, #000 var(--org-fade-l), #000 calc(100% - var(--org-fade-r)), transparent 100%); }
.org-tree.is-more-left { --org-fade-l: 40px; }
.org-tree.is-more-right { --org-fade-r: 40px; }
.org-more { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 6px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.org-more[hidden], .org-more button[hidden] { display: none; }
.org-more button { font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; padding: 3px 12px; border-radius: 999px; border: var(--ax-border-w) solid var(--ax-accent); background: var(--ax-bg); color: var(--ax-accent); cursor: pointer; }
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
.org-job { margin: 8px 0 0; font-size: var(--ax-fs-sm); overflow-wrap: anywhere; }
.org-state { display: inline-block; margin-top: 8px; padding: 1px 8px; border-radius: 999px; font-size: var(--ax-fs-xs); border: var(--ax-border-w) solid var(--ax-border-2); color: var(--ax-text-2); }
.org-state.is-working { color: var(--ax-green-ink, var(--ax-text)); border-color: var(--ax-green-ink, var(--ax-text)); }
.org-state.is-paused, .org-state.is-waiting { color: var(--ax-amber-ink); border-color: var(--ax-amber-ink); }
.org-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.org-acts a, .org-acts button { font: inherit; font-size: var(--ax-fs-xs); padding: 3px 9px; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-surface-2); color: var(--ax-text); text-decoration: none; cursor: pointer; }
.org-acts button:disabled { opacity: 0.6; cursor: default; }
.org-card { position: relative; }
.org { --org-person-bg: color-mix(in oklch, #f08c3c 16%, var(--ax-bg)); --org-person-ink: color-mix(in oklch, #d4691f 80%, var(--ax-text)); }
.org-card.is-person { background: var(--org-person-bg); border-color: var(--org-person-ink); border-left-width: 4px; border-radius: 22px; }
.org-card.is-remote, .org-legend-remote { border-style: dashed; }
.org-card.is-gone { opacity: .6; filter: grayscale(1); }
.org-nodes { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.org-kind { font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-tag { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; font-size: 11px; font-weight: 600; line-height: 17px; border-radius: 999px; border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text-2); white-space: nowrap; }
.org-tag svg { fill: currentColor; }
.org-tag .org-eye { fill: var(--ax-bg); }
.org-tag.is-person { border-color: var(--org-person-ink); color: var(--org-person-ink); }
.org-card > .org-tag { position: absolute; top: -9px; right: 12px; }
.org-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; margin: 0 0 14px; padding: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-legend li { display: inline-flex; align-items: center; gap: 6px; }
.org-legend li[hidden] { display: none; }
.org-legend-dept { padding: 0 8px; line-height: 17px; border: 1.5px dashed var(--ax-accent); border-radius: var(--ax-radius-sm); color: var(--ax-accent); font-weight: 600; }
.org-tree li.org-dept > .org-dept-box { padding: 10px 14px 4px; border: 1.5px dashed var(--ax-accent); border-radius: 16px; background: var(--ax-blue-t, var(--ax-surface)); }
.org-dept-name { display: block; margin: 0 0 4px; font-size: var(--ax-fs-sm); font-weight: 700; color: var(--ax-accent); text-align: center; }
.org-dept-head { display: block; margin: -2px 0 2px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); text-align: center; }
.org-tree .org-dept-box > ul { display: flex; position: relative; padding-top: 0; }
.org-tree .org-dept-box > ul > li { padding: 10px 6px 6px; }
.org-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 30px; margin: 0 0 10px; }
.org-views { display: inline-flex;border: var(--ax-border-w) solid var(--ax-border-2); border-radius: 999px; overflow: hidden; }
.org-views[hidden], .org-depts[hidden], .org-tree[hidden] { display: none; }
.org-views button { font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; background: none; border: 0; color: var(--ax-text); padding: 4px 14px; cursor: pointer; }
.org-views button[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); }
.org-depts { display: grid; gap: 16px; }
.org-dbox { padding: 12px 14px 14px; border: 1.5px dashed var(--ax-accent); border-radius: 16px; background: var(--ax-blue-t, var(--ax-surface)); }
.org-dbox.is-rest { border-color: var(--ax-border-2); background: var(--ax-surface); }
.org-dname { margin: 0 0 12px; font-size: 15px; color: var(--ax-accent); }
.org-dbox.is-rest .org-dname { color: var(--ax-text); }
.org-dhead { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 0 14px; margin: 0 0 14px; border-bottom: var(--ax-border-w) solid var(--ax-border-2); }
.org-lead { padding: 0 9px; line-height: 18px; border-radius: 999px; background: var(--ax-text); color: var(--ax-bg); font-size: 11px; font-weight: 700; }
.org-dgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px 12px; padding-top: 8px; }
.org-dgrid .org-card, .org-dhead .org-card { width: auto; max-width: none; margin: 0; }
.org-dhead .org-card { min-width: min(260px, 100%); }
/* Someone whose home is another department: an outlined card (Anis 11-01). */
.org-also { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.org-also .org-card { width: 100%; background: transparent; border-style: dashed; }
.org-also-name { margin: 14px 0 0; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-text-2); }
.org-home { padding: 0 9px; line-height: 18px; border-radius: 999px; border: var(--ax-border-w) solid var(--ax-border-2); font-size: 11px; font-weight: 600; }
#org-outside.is-in-depts { display: none; }
.org-links { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin: 0 0 12px; }
@media (max-width: 640px) {
  .org { padding: 0 16px 48px; }
  .org-card > .org-tag { position: static; display: inline-flex; margin: 0 0 6px; }
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
    var named = {}, outsiders = {};
    rels.forEach(function (r) { named[r.from] = true; named[r.to] = true; });
    (d.people || []).forEach(function (p) {
      var key = 'person:' + p.id;
      names[key] = p.name;
      // Only personnel get a card; a client or guest is a line on the other card.
      if (p.outsider) { outsiders[key] = p.name + ' (' + p.outsider + ')'; return; }
      if (named[key] || p.placed) nodes[key] = { kind: 'person', id: p.id, name: p.name, title: p.title, reports: [] };
    });
    // Agents on other nodes: the cards the view made for them, routed to never.
    ((d.diagram && d.diagram.boxes) || []).forEach(function (b) {
      if (!b.remote) return;
      names[b.key] = b.name;
      nodes[b.key] = { kind: 'agent', id: b.id, name: b.name, remote: b.remote, reports: [] };
    });
    // Departments (#1681): their members and head get a card, and a member its department.
    (d.departments || []).forEach(function (dep) {
      (dep.head ? [dep.head] : []).concat(dep.members).forEach(function (key) {
        var m = /^person:(.*)$/.exec(key);
        var p = m && (d.people || []).find(function (x) { return x.id === m[1]; });
        if (p && !p.outsider && !nodes[key]) nodes[key] ={ kind: 'person', id: p.id, name: p.name, title: p.title, reports: [] };
      });
      dep.members.forEach(function (key) { if (nodes[key] && !nodes[key].department) nodes[key].department = dep.id; });
    });
    rels.forEach(function (r) {
      if (r.type === 'acts-for') return;
      [[r.from, r.to], [r.to, r.from]].forEach(function (ends) {
        var n = nodes[ends[0]], w = outsiders[ends[1]];
        if (n && w && (n.worksWith = n.worksWith || []).indexOf(w) < 0) n.worksWith.push(w);
      });
    });
    rels.forEach(function (r) {
      var n = nodes[r.from];
      if (!n || r.type === 'reports-to' || (r.type === 'dotted-line' && outsiders[r.to])) return;
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
    Object.keys(nodes).forEach(function (key) { if (key.indexOf('person:') === 0 || nodes[key].remote) roots.push(nodes[key]); });
    d.roots.forEach(function (n) { if (/^(person:|agent:)/.test(String(n.reportsTo || ''))) moveUnder(n, n.reportsTo); });
    rels.forEach(function (r) { if (r.type === 'reports-to' && nodes[r.from] && (r.from.indexOf('person:') === 0 || nodes[r.from].remote)) moveUnder(nodes[r.from], r.to); });
    return { roots: roots, names: names, nodes: nodes };
  }
  /** The card of an agent on another node: where it is and how its node last
   *  answered, grey when it is down or unseen. No Pause or Activity: this
   *  node does not run it. tag and links are the card's Agent tag and rows. */
  function remoteCardHtml(n, tag, links, esc) {
    var r = n.remote, up = r.seen === 'up';
    var state = up ? 'On ' + r.node : r.seen === 'down' ? r.node + ' does not answer; last seen there' : 'Not seen on ' + r.node;
    return '<div class="org-card is-remote' + (up ? '' : ' is-gone') + '" data-remote="' + esc(n.id) + '">' + tag
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span><span class="org-id">' + esc(r.agent) + ' @ ' + esc(r.node) + '</span></div>'
      + links + '<span class="org-state is-remote">' + esc(state) + '</span></div>';
  }
  /** The agents mesh peers host that the chart does not place, by node. */
  function meshOthersHtml(others, esc) {
    var byNode = {};
    (others || []).forEach(function (a) { (byNode[a.node] = byNode[a.node] || []).push(a); });
    return Object.keys(byNode).map(function (node) {
      var list = byNode[node];
      return '<li class="org-node"><b>' + esc(node) + '</b>' + (list[0].healthy ? '' : ' <span class="org-quiet">(does not answer)</span>')
        + '<ul class="org-row">' + list.map(function (a) { return '<li><span class="org-name">' + esc(a.name) + '</span> <code>agent:' + esc(node) + '/' + esc(a.id) + '</code></li>'; }).join('') + '</ul></li>';
    }).join('');
  }
  /** The Departments view (#1681): per box of d.byDepartment its name, the
   *  head's card on top, the members' cards in a grid; then "Not in a
   *  department". cardOf(key) is a card's html, or '' for no card. Who also
   *  works in a box (alsoMembers) comes last in it, outlined, under a
   *  "Home: <department>" chip. */
  function deptViewHtml(by, cardOf, esc) {
    function grid(keys) { return '<div class="org-dgrid">' + keys.map(cardOf).join('') + '</div>'; }
    var boxes = (by.boxes || []).map(function (dep) {
      return '<section class="org-dbox" data-dept="' + esc(dep.id) + '" aria-label="' + esc(dep.name) + '">'
        + '<h2 class="org-dname">' + esc(dep.name) + '</h2>'
        + (dep.head ? '<div class="org-dhead"><span class="org-lead">Head</span>' + cardOf(dep.head) + '</div>' : '<p class="org-quiet">No head set</p>')
        + (dep.members.length ? grid(dep.members) : '<p class="org-quiet">No members yet</p>')
        + (dep.also ? '<h3 class="org-also-name">Also works here</h3><div class="org-dgrid">' + dep.also.map(function (a) {
          return '<div class="org-also"><span class="org-home">Home: ' + esc(a.home) + '</span>' + cardOf(a.key) + '</div>';
        }).join('') + '</div>' : '') + '</section>';
    }).join('');
    var rest = (by.rest || []).length ? '<section class="org-dbox is-rest" aria-label="Not in a department"><h2 class="org-dname">Not in a department</h2>' + grid(by.rest) + '</section>' : '';
    return boxes + rest;
  }
  /** One list of siblings as it is drawn (#1681): each department's members
   *  together in one item { dept, items }, where the first of them stood;
   *  everyone else as they were. */
  function byDept(list, depts) {
    var out = [], at = {};
    list.forEach(function (n) {
      var dep = n.department && depts[n.department];
      if (!dep) { out.push(n); return; }
      if (!at[dep.id]) { at[dep.id] = { dept: dep, items: [] }; out.push(at[dep.id]); }
      at[dep.id].items.push(n);
    });
    return out;
  }
  /** A department box's title: its name, and its head when it has one. */
  function deptTitleHtml(dep, nameOf, esc) {
    return '<span class="org-dept-name">' + esc(dep.name) + '</span>'
      + (dep.head ? '<span class="org-dept-head">Head: ' + esc(nameOf(dep.head)) + '</span>' : '');
  }
`

const ORG_SCRIPT = `
(function () {${ORG_PEOPLE_JS}${ORG_PROJECTS_JS}
  ${injectFns({ orgConfirmFor, orgEditHtml, orgEditor })}
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
  var names = {};
  function nameOf(ref) { return names[ref] || String(ref).replace(/^[a-z]+:/, ''); }
  function links(n) {
    var rows = (n.dottedLine || []).map(function (r) { return 'Dotted line to ' + nameOf(r); })
      .concat((n.actsFor || []).map(function (r) { return 'Acts for ' + nameOf(r); }))
      .concat((n.worksWith || []).map(function (w) { return 'Works with ' + w; }));
    return rows.length ? '<div class="org-links">' + rows.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</div>' : '';
  }
  var depts = {};   // department id -> department (#1681)
  // Departments, Chart or Projects (#1681, #1687); Projects is kept in the
  // address as ?view=projects. Departments falls back to Chart when there are none.
  var view = /[?&]view=projects(&|$)/.test(location.search) ? 'projects' : 'dept';
  var lastOrg = null, projHtml = '';
  function shownView() { return view === 'dept' && !(lastOrg && (lastOrg.departments || []).length) ? 'chart' : view; }
  function paintView() {
    document.querySelector('[data-org-view="dept"]').hidden = !(lastOrg && (lastOrg.departments || []).length);
    document.querySelectorAll('[data-org-view]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-org-view') === shownView() ? 'true' : 'false'); });
    var on = view === 'projects';
    document.getElementById('org-chart-view').hidden = on;
    var box = document.getElementById('org-projects');
    box.hidden = !on;
    if (on && lastOrg) document.getElementById('org-none').hidden = true;
    if (!on || !lastOrg) return;
    var html = orgProjectsHtml(lastOrg, esc);
    if (html !== projHtml) box.innerHTML = projHtml = html;
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-org-view]') : null;
    if (!b) return;
    view = b.getAttribute('data-org-view');
    var u = new URL(location.href);
    if (view === 'projects') u.searchParams.set('view', 'projects'); else u.searchParams.delete('view');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    paintView();
    if (view !== 'projects' && lastOrg) load();
  });
  function kind(person) { return person ? '<span class="org-tag is-person">${ORG_PERSON_ICON}Person</span>' : '<span class="org-tag is-agent">${ORG_AGENT_ICON}Agent</span>'; }
  function personCard(n) {
    return '<div class="org-card is-person" data-person="' + esc(n.id) + '">' + kind(true)
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + links(n) + '</div>';
  }
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'org-msg' + (bad ? ' is-bad' : ''); }
  function card(n) {
    if (n.kind === 'person') return personCard(n);
    if (n.remote) return remoteCardHtml(n, kind(false), links(n), esc);
    var id = encodeURIComponent(n.id);
    var state = n.status === 'working' && n.active > 1 ? 'Working on ' + n.active : STATE[n.status] || n.status;
    if (n.status === 'paused' && n.heldBy) state += ' by ' + n.heldBy;
    if (n.status === 'waiting' && n.heldBy) state += ' (created by ' + n.heldBy + ')';
    var acts = '<a href="${HUB_PATH}#page=activity&a-agent=' + id + '&a-period=30d">Activity</a><a href="/admin/agents/' + id + '">Agent page</a>';
    if (n.status === 'waiting') acts += '<a href="${HUB_NEEDS_YOU}">Decide in Needs you</a>';
    else if (n.status === 'paused') acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="0">Resume</button>';
    else acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="1">Pause</button>';
    return '<div class="org-card is-' + esc(n.status) + '" data-agent="' + esc(n.id) + '">' + kind(false)
      + '<div class="org-top' + (pics[n.id] ? ' org-top--pic' : '') + '">' + (pics[n.id] ? '<span class="org-av"><img src="' + esc(pics[n.id]) + '" alt=""></span>' : '') + '<span class="org-name">' + esc(n.name) + '</span><span class="org-id">' + esc(n.id) + '</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + (n.job ? '<p class="org-job">' + esc(n.job) + '</p>' : '')
      + links(n)
      + '<span class="org-state is-' + esc(n.status) + '">' + esc(state) + '</span>'
      + '<div class="org-acts">' + acts + '</div></div>';
  }
  function item(n) {
    return '<li>' + card(n) + (n.reports && n.reports.length ? branch(n.reports) : '') + '</li>';
  }
  function branch(list) {
    return '<ul>' + byDept(list, depts).map(function (x) {
      if (!x.dept) return item(x);
      return '<li class="org-dept" data-dept="' + esc(x.dept.id) + '"><div class="org-dept-box">' + deptTitleHtml(x.dept, nameOf, esc)
        + '<ul>' + x.items.map(item).join('') + '</ul></div></li>';
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
      probEl.textContent = d.problem ? 'Problem in the org chart: ' + d.problem : '';
      depts = {};
      (d.departments || []).forEach(function (dep) { depts[dep.id] = dep; });
      document.getElementById('org-legend-dept').hidden = !(d.departments || []).length;
      document.getElementById('org-legend-remote').hidden = !((d.diagram && d.diagram.boxes) || []).some(function (b) { return b.remote; });
      document.getElementById('org-legend-also').hidden = !((d.byDepartment && d.byDepartment.boxes) || []).some(function (b) { return b.also; });
      E.org = d;
      paintEdit();
      lastOrg = d;
      paintView();
      var org = withPeople(d);
      names = org.names;
      document.getElementById('org-none').hidden = org.roots.length > 0 || view === 'projects';
      tree.innerHTML = org.roots.length ? branch(org.roots) : '';
      if (tree.firstElementChild) tree.firstElementChild.style.zoom = zoom;
      var hasDepts = (d.departments || []).length > 0, deptView = hasDepts && view === 'dept';
      var deptsEl = document.getElementById('org-depts');
      deptsEl.hidden = !deptView;
      tree.hidden = deptView;
      document.getElementById('org-zoom').hidden = deptView || view === 'projects' || !org.roots.length;
      if (!deptView && view !== 'projects') { fit(); showStart(); }
      zoomLabel();
      moreCue();
      if (deptView) {
        var byKey = org.nodes;
        d.outside.forEach(function (n) { byKey['agent:' + n.id] = byKey['agent:' + n.id] || n; });
        deptsEl.innerHTML = deptViewHtml(d.byDepartment || { boxes: [], rest: [] }, function (k) { return byKey[k] ? card(byKey[k]) : ''; }, esc);
      }
      document.getElementById('org-outside').classList.toggle('is-in-depts', deptView);
      var out = document.getElementById('org-outside');
      out.hidden = d.outside.length === 0;
      document.getElementById('org-outside-list').innerHTML = d.outside.map(function (n) { return '<li>' + card(n) + '</li>'; }).join('');
      var others = (d.mesh && d.mesh.others) || [];
      document.getElementById('org-mesh').hidden = others.length === 0;
      document.getElementById('org-mesh-list').innerHTML = meshOthersHtml(others, esc);
      // Only clear the daemon warning, not the answer to a click.
      if (!d.live) { say('The daemon did not answer, so working or idle is unknown. Start it with: agentx daemon start', true); warned = true; }
      else if (warned) { say(''); warned = false; }
    } catch (e) { say('Could not load the org chart: ' + e.message, true); }
  }
  // Fit to width (#1681), as the Hub's Chart view: on the first paint of the
  // Chart view the chart shrinks to the page width, never under 60% and never
  // over 100%. Once fitted, or once the reader zooms, it is never refitted.
  var zoom = 1, fitted = false, FIT_FLOOR = 0.6;
  function fit() {
    var ul = tree.firstElementChild;
    if (fitted || !ul) return;
    var w = ul.getBoundingClientRect().width / zoom, room = tree.clientWidth;
    if (!(w > 0 && room > 0)) return;
    fitted = true;
    setZoom(Math.max(FIT_FLOOR, Math.min(1, Math.floor(room / w * 100) / 100)));
  }
  function setZoom(z) {
    zoom = z;
    if (tree.firstElementChild) tree.firstElementChild.style.zoom = z;
    zoomLabel();
  }
  function zoomLabel() {
    document.getElementById('org-zoom-at').textContent = Math.round(zoom * 100) + '%';
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-org-zoom]') : null;
    if (!b) return;
    var step = Number(b.getAttribute('data-org-zoom'));
    fitted = true;
    setZoom(step === 0 ? 1 : Math.min(1.5, Math.max(0.4, Math.round((zoom + step * 0.1) * 10) / 10)));
    moreCue();
  });
  // Still wider than the page at 60%: start with the left edge of the widest
  // department box in view (else the chart's left edge), never centred on the
  // head. Once; later repaints keep the reader's scroll.
  var startShown = false;
  function showStart() {
    if (startShown || !(tree.scrollWidth > tree.clientWidth)) return;
    var box = tree.getBoundingClientRect(), widest = null;
    tree.querySelectorAll('.org-dept-box').forEach(function (d) {
      if (!widest || d.getBoundingClientRect().width > widest.getBoundingClientRect().width) widest = d;
    });
    tree.scrollLeft = widest ? Math.max(0, widest.getBoundingClientRect().left - box.left + tree.scrollLeft - 8) : 0;
    startShown = true;
  }
  // The cue above a chart wider than the page: who is off screen on each
  // side, as buttons that scroll that way, and a fade on the cut edge.
  var more = document.getElementById('org-more');
  function moreSide(btn, who, before, after) {
    btn.hidden = !who.length;
    var list = who.length > 3 ? who.slice(0, 3).join(', ') + ', …' : who.join(', ');
    btn.textContent = before + who.length + ' more: ' + list + after;
  }
  function moreCue() {
    var wide = !tree.hidden && tree.scrollWidth > tree.clientWidth + 1;
    more.hidden = !wide;
    tree.classList.toggle('is-more-left', wide && tree.scrollLeft > 1);
    tree.classList.toggle('is-more-right', wide && tree.scrollLeft + tree.clientWidth < tree.scrollWidth - 1);
    if (!wide) return;
    var box = tree.getBoundingClientRect(), left = [], right = [];
    tree.querySelectorAll(':scope > ul > li > ul > li').forEach(function (li) {
      var r = li.getBoundingClientRect(), n = li.querySelector('.org-dept-name, .org-name');
      if (r.left < box.left - 1) left.push(n ? n.textContent : '?');
      if (r.right > box.right + 1) right.push(n ? n.textContent : '?');
    });
    moreSide(more.querySelector('[data-org-scroll="-1"]'), left, '← ', '');
    moreSide(more.querySelector('[data-org-scroll="1"]'), right, '', ' →');
  }
  tree.addEventListener('scroll', moreCue, { passive: true });
  window.addEventListener('resize', moreCue);
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-org-scroll]') : null;
    if (b) tree.scrollBy({ left: Number(b.getAttribute('data-org-scroll')) * tree.clientWidth * 0.8, behavior: 'smooth' });
  });
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
  // --- Edit org, owner only (#1420): the shared editor (org-setup.ts) ---
  // The panel repaints only when what it shows changed, so the 15-second
  // refresh never resets a field in use.
  var editBtn = document.getElementById('org-edit-btn');
  var editBox = document.getElementById('org-edit');
  var E = { open: /^#edit$/.test(location.hash || ''), org: null, painted: '' };
  var ED = orgEditor({
    org: function () { return E.org; },
    post: async function (change) {
      var r = await fetch('/api/admin/org/chart', { method: 'POST', headers: headers(true), body: JSON.stringify(change) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      return d;
    },
    reload: function () { return load(); },
    paint: function () { paintEdit(); },
  });
  function paintEdit() {
    var can = !!(E.org && E.org.canEdit && E.org.setup && E.org.choices);
    if (!can) E.open = false;
    editBtn.hidden = !can;
    editBtn.textContent = E.open ? 'Done editing' : 'Edit org';
    editBtn.setAttribute('aria-expanded', E.open ? 'true' : 'false');
    editBox.hidden = !E.open;
    if (!E.open) { ED.E.pending = null; E.painted = ''; editBox.innerHTML = ''; return; }
    var key = JSON.stringify([E.org.setup, E.org.choices, ED.E.msg, ED.E.bad, ED.E.pending && ED.E.pending.text]);
    if (key === E.painted) return;
    E.painted = key;
    editBox.innerHTML = ED.html();
    ED.focus();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('[data-org-edit]')) { E.open = !E.open; ED.E.msg = ''; ED.E.bad = false; paintEdit(); return; }
    ED.click(t);
  });
  document.addEventListener('keydown', function (ev) { ED.key(ev); });
  load();
  setInterval(load, 15000);
})();
`
