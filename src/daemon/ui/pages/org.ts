// --- Org page (/org) (#1169) ---
//
// The org chart (business.orgChart) as a diagram (#1419): a box for each
// agent and person, and a line for each relation, one style per type. An
// agent's box has its role, its one-line job and its status; from it, open
// the agent's activity, pause or resume it. Agents another agent created
// wait in Approvals; their box says so.
//
// Boxes sit in a CSS grid at the place src/business/org-layout.ts gives
// them; the lines are an SVG drawn over the grid from the boxes' places,
// again on every resize. On a phone the boxes stack in one column,
// indented by level, and each box says its relations in words.
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
    lead: "Who your agents are, who each one reports to, and what each one is doing now. Pause an agent here; it starts nothing until you resume it.",
  }) + `
  <div class="org">
    <div id="org-msg" class="org-msg" role="status" aria-live="polite"></div>
    <section id="org-none" class="org-none" hidden aria-labelledby="org-none-title">
      <h2 id="org-none-title">No org chart yet</h2>
      <p>Give each agent a role and a boss under <code>business.orgChart</code> in <code>agentx.json</code>, with the roles under <code>business.roles</code>. Until then every agent is listed below, side by side.</p>
    </section>
    <div id="org-legend" class="org-legend" hidden aria-label="What the boxes and lines mean">
      <span class="org-key"><span class="org-swatch"></span>Agent</span>
      <span class="org-key"><span class="org-swatch is-person"></span>Person</span>
      <span class="org-key"><svg width="36" height="10" aria-hidden="true"><line class="org-edge is-reports-to" x1="2" y1="5" x2="34" y2="5"/></svg>Reports to</span>
      <span class="org-key"><svg width="36" height="10" aria-hidden="true"><line class="org-edge is-dotted-line" x1="2" y1="5" x2="34" y2="5"/></svg>Dotted line (a second boss for one topic)</span>
      <span class="org-key"><svg width="36" height="10" aria-hidden="true"><line class="org-edge is-acts-for" x1="2" y1="5" x2="34" y2="5"/></svg>Acts for (an agent working for a person)</span>
    </div>
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
.org-row { list-style: none; margin: 0; padding: 0; }
.org-diagram { --org-half: 120px; position: relative; display: grid; grid-template-columns: repeat(var(--org-cols, 2), var(--org-half)); grid-auto-rows: auto; row-gap: 44px; justify-content: center; width: max-content; min-width: 100%; padding: 6px 0; }
.org-diagram > .org-card { position: relative; z-index: 1; width: 224px; justify-self: center; align-self: start; }
.org-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.org-edge { fill: none; stroke-width: 1.5; }
.org-edge.is-reports-to { stroke: var(--ax-text-2); }
.org-edge.is-dotted-line { stroke: var(--ax-text-2); stroke-dasharray: 7 5; }
.org-edge.is-acts-for { stroke: var(--ax-blue); stroke-width: 2.5; stroke-dasharray: 0.5 5; stroke-linecap: round; }
.org-arrow { fill: var(--ax-text-2); }
.org-arrow.is-acts-for { fill: var(--ax-blue); }
.org-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 14px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-key { display: inline-flex; align-items: center; gap: 6px; }
.org-swatch { display: inline-block; width: 22px; height: 12px; border: var(--ax-border-w) solid var(--ax-border); border-radius: 3px; background: var(--ax-surface); }
.org-swatch.is-person { border: 2px solid var(--ax-blue); border-radius: 999px; }
.org-rel { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.org-row { display: flex; flex-wrap: wrap; gap: 12px; }
.org-card { box-sizing: border-box; width: 236px; padding: 12px 14px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); text-align: left; }
.org-card.is-paused, .org-card.is-waiting { border-style: dashed; }
.org-card.is-person { border: 2px solid var(--ax-blue); border-radius: 22px; background: var(--ax-surface-2); }
.org-kind { margin: 0 0 2px; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-blue); text-transform: uppercase; letter-spacing: 0.04em; }
.org-name a { color: inherit; text-decoration: none; }
.org-name a:hover, .org-name a:focus-visible { text-decoration: underline; }
@media (max-width: 640px) {
  .org { padding: 0 16px 48px; }
  .org-diagram { display: flex; flex-direction: column; gap: 10px; width: auto; min-width: 0; }
  .org-diagram > .org-card { width: auto; margin-left: calc(min(var(--org-level, 0), 4) * 16px); }
  .org-lines { display: none; }
  .org-rel { position: static; width: auto; height: auto; overflow: visible; clip: auto; white-space: normal; margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
}
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
  function say(t, bad) { msg.textContent = t || ''; msg.className = 'org-msg' + (bad ? ' is-bad' : ''); }
  var RELATION = { 'reports-to': 'Reports to', 'dotted-line': 'Dotted line to', 'acts-for': 'Acts for' };
  var last = null;
  function card(n, extra) {
    var id = encodeURIComponent(n.id);
    var state = n.status === 'working' && n.active > 1 ? 'Working on ' + n.active : STATE[n.status] || n.status;
    if (n.status === 'paused' && n.heldBy) state += ' by ' + n.heldBy;
    if (n.status === 'waiting' && n.heldBy) state += ' (created by ' + n.heldBy + ')';
    var acts = '<a href="/agents/' + id + '/history">Activity</a><a href="/admin/agents/' + id + '">Agent page</a>';
    if (n.status === 'waiting') acts += '<a href="/approvals">Decide in Approvals</a>';
    else if (n.status === 'paused') acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="0">Resume</button>';
    else acts += '<button type="button" data-hold="' + esc(n.id) + '" data-paused="1">Pause</button>';
    return '<div class="org-card is-' + esc(n.status) + '" data-agent="' + esc(n.id) + '"' + (extra || '') + '>'
      + '<div class="org-top"><span class="org-name"><a href="/admin/agents/' + id + '">' + esc(n.name) + '</a></span><span class="org-id">' + esc(n.id) + '</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + (n.job ? '<p class="org-job">' + esc(n.job) + '</p>' : '')
      + '<span class="org-state is-' + esc(n.status) + '">' + esc(state) + '</span>'
      + '<div class="org-acts">' + acts + '</div>' + (n.said || '') + '</div>';
  }
  function personCard(n, extra) {
    return '<div class="org-card is-person" data-person="' + esc(n.id) + '"' + (extra || '') + '>'
      + '<p class="org-kind">Person</p>'
      + '<div class="org-top"><span class="org-name">' + esc(n.name) + '</span><span class="org-id">' + esc(n.id) + '</span></div>'
      + (n.title ? '<p class="org-title">' + esc(n.title) + '</p>' : '')
      + (n.said || '') + '</div>';
  }
  function diagram(d) {
    var byKey = {};
    d.boxes.forEach(function (b) { byKey[b.key] = b; });
    // The lines in words, for screen readers and the stacked phone view:
    // each box says its own relations.
    var said = {};
    d.edges.forEach(function (e) {
      var to = byKey[e.to];
      said[e.from] = (said[e.from] || '') + ' ' + RELATION[e.type] + ' ' + (to ? to.name : e.to) + '.';
    });
    var boxes = d.boxes.map(function (b) {
      var n = Object.assign({}, b, { said: said[b.key] ? '<p class="org-rel">' + esc(said[b.key].trim()) + '</p>' : '' });
      var at = ' data-key="' + esc(b.key) + '" style="grid-column: ' + b.col + ' / span 2; grid-row: ' + (b.level + 1) + '; --org-level: ' + b.level + '"';
      return b.kind === 'person' ? personCard(n, at) : card(n, at);
    }).join('');
    return '<div class="org-diagram" style="--org-cols: ' + d.columns + '"><svg class="org-lines" aria-hidden="true"></svg>' + boxes + '</div>';
  }
  // A line from the edge of one box that faces the other, curving out.
  // Shifted sideways at a top or bottom edge, so it does not lie on a
  // reports-to line between the same two boxes.
  function side(r, o, shift) {
    var dx = (o.left + o.width / 2) - (r.left + r.width / 2);
    var dy = (o.top + o.height / 2) - (r.top + r.height / 2);
    if (Math.abs(dy) > Math.abs(dx) || Math.abs(dy) > r.height) return dy > 0 ? [r.left + r.width / 2 + shift, r.bottom, 0, 1] : [r.left + r.width / 2 + shift, r.top, 0, -1];
    return dx > 0 ? [r.right, r.top + r.height / 2, 1, 0] : [r.left, r.top + r.height / 2, -1, 0];
  }
  function drawLines() {
    var box = tree.querySelector('.org-diagram');
    var svg = box && box.querySelector('.org-lines');
    if (!svg || !last || !svg.getClientRects().length) return;
    var o = box.getBoundingClientRect();
    function rect(key) {
      var el = box.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top, width: r.width, height: r.height };
    }
    var gap = parseFloat(getComputedStyle(box).rowGap) || 44;
    var out = '<defs>' + ['reports-to', 'dotted-line', 'acts-for'].map(function (t) {
      return '<marker id="org-arrow-' + t + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="org-arrow is-' + t + '" d="M0 0 L10 5 L0 10 z"/></marker>';
    }).join('') + '</defs>';
    last.edges.forEach(function (e) {
      var a = rect(e.from), b = rect(e.to);
      if (!a || !b) return;
      var d;
      if (e.type === 'reports-to') {
        // From the boss down to the report, with the elbow just above the report's row.
        var x1 = b.left + b.width / 2, x2 = a.left + a.width / 2, mid = a.top - gap / 2;
        d = 'M' + x1 + ' ' + b.bottom + ' V' + mid + ' H' + x2 + ' V' + a.top;
        out += '<path class="org-edge is-reports-to" d="' + d + '"/>';
        return;
      }
      var shift = e.type === 'acts-for' ? 32 : -32;
      var p = side(a, b, shift), q = side(b, a, shift), k = 40;
      d = 'M' + p[0] + ' ' + p[1] + ' C' + (p[0] + p[2] * k) + ' ' + (p[1] + p[3] * k) + ' ' + (q[0] + q[2] * k) + ' ' + (q[1] + q[3] * k) + ' ' + q[0] + ' ' + q[1];
      out += '<path class="org-edge is-' + e.type + '" d="' + d + '" marker-end="url(#org-arrow-' + e.type + ')"/>';
    });
    svg.innerHTML = out;
  }
  async function load() {
    try {
      var r = await fetch('/api/admin/org', { headers: headers(false) });
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      if (!d.exists) { tree.innerHTML = '<p class="org-quiet">No agentx.json in this folder.</p>'; return; }
      var any = d.diagram && d.diagram.boxes.length > 0;
      document.getElementById('org-none').hidden = any;
      document.getElementById('org-legend').hidden = !any;
      last = any ? d.diagram : null;
      // Keep focus on a Pause or Resume button across the refresh.
      var focused = document.activeElement && tree.contains(document.activeElement) ? document.activeElement.getAttribute('data-hold') : null;
      tree.innerHTML = any ? diagram(d.diagram) : '';
      drawLines();
      if (focused) { var f = tree.querySelector('button[data-hold="' + CSS.escape(focused) + '"]'); if (f) f.focus(); }
      var out = document.getElementById('org-outside');
      out.hidden = d.outside.length === 0;
      document.getElementById('org-outside-list').innerHTML = d.outside.map(function (n) { return '<li>' + card(n) + '</li>'; }).join('');
      // Only clear the daemon warning, not the answer to a click.
      if (!d.live) { say('The daemon did not answer, so working or idle is unknown. Start it with: agentx daemon start', true); warned = true; }
      else if (warned) { say(''); warned = false; }
    } catch (e) { say('Could not load the org chart: ' + e.message, true); }
  }
  var frame = 0;
  function redraw() { cancelAnimationFrame(frame); frame = requestAnimationFrame(drawLines); }
  window.addEventListener('resize', redraw);
  if (window.ResizeObserver) new ResizeObserver(redraw).observe(tree);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
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
