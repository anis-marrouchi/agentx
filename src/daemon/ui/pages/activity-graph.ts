import { renderShell, type TopbarPeer } from ".."

// --- /admin/activity-graph — Activity perspective lens ---
//
// Two layout modes:
//   "All"     — clients along the top as boundary boxes (containing
//               their projects + active subjects), agent ring at the
//               bottom, channels along the left edge, initiators on
//               the right. Edges curve from initiator → channel →
//               subject → agent.
//   "Rooted"  — selected node sits in the centre. 1-hop neighbours
//               distributed around an inner ring, 2-hop around an
//               outer ring. Click any node to re-root.
//
// All rendering is hand-rolled SVG — no chart lib. Active edges
// pulse via a CSS-animated stroke-dashoffset. Hover an edge or
// node for the tooltip with sub/preview.

export interface ActivityGraphPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderActivityGraphPage(opts: ActivityGraphPageOpts = {}): string {
  const body = `<div class="ax-graph">
  <header class="ax-graph__head">
    <h1>Activity Graph</h1>
    <p class="ax-graph__sub">Live perspective lens over recent activity. Click any node to re-root the view from there.</p>
    <nav class="ax-graph__crumbs" id="ax-graph-crumbs">
      <a class="ax-graph__crumb is-active" data-root="" href="#">All</a>
    </nav>
    <div class="ax-graph__controls">
      <div class="ax-graph__view-toggle">
        <button class="is-active" data-view="timeline" type="button">Timeline</button>
        <button data-view="lens" type="button">Lens</button>
      </div>
      <label>Window
        <select id="ax-graph-window">
          <option value="1">1 hour</option>
          <option value="6" selected>6 hours</option>
          <option value="24">24 hours</option>
          <option value="72">3 days</option>
          <option value="168">7 days</option>
        </select>
      </label>
      <label class="ax-graph__chk"><input type="checkbox" id="ax-graph-active-only" /> active only</label>
      <button id="ax-graph-refresh" type="button">↻ Refresh</button>
      <span class="ax-graph__hint" id="ax-graph-stamp"></span>
    </div>
  </header>

  <section class="ax-graph__canvas-wrap">
    <svg id="ax-graph-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 700" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrow-dispatch" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#2da44e"/>
        </marker>
        <marker id="arrow-resolve" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#6b7280" opacity="0.6"/>
        </marker>
        <marker id="arrow-a2a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#bf8700"/>
        </marker>
      </defs>
      <g id="ax-graph-edges"></g>
      <g id="ax-graph-nodes"></g>
    </svg>
    <div class="ax-graph__legend">
      <span><i style="background:#e07a3a"></i>Client</span>
      <span><i style="background:#3a7bd5"></i>Project</span>
      <span><i style="background:#6b7280"></i>Subject</span>
      <span><i style="background:#2da44e"></i>Agent</span>
      <span><i style="background:#9333ea"></i>Channel</span>
      <span><i style="background:#f59e0b"></i>Initiator</span>
      <span class="ax-graph__legend-sep">·</span>
      <span class="ax-graph__legend-edge"><svg width="20" height="6" viewBox="0 0 20 6"><line x1="1" y1="3" x2="19" y2="3" stroke="#2da44e" stroke-width="2"/></svg>dispatch</span>
      <span class="ax-graph__legend-edge"><svg width="20" height="6" viewBox="0 0 20 6"><line x1="1" y1="3" x2="19" y2="3" stroke="#bf8700" stroke-width="2" stroke-dasharray="4 2"/></svg>a2a</span>
      <span class="ax-graph__legend-edge"><svg width="20" height="6" viewBox="0 0 20 6"><line x1="1" y1="3" x2="19" y2="3" stroke="#6b7280" stroke-width="1" opacity="0.6"/></svg>resolve</span>
      <span class="ax-graph__legend-pulse"><span class="ax-graph__pulse-dot"></span>active (pulsing)</span>
    </div>
    <div id="ax-graph-tip" class="ax-graph__tip" hidden></div>
    <p id="ax-graph-empty" class="ax-graph__empty" hidden>No activity in this window.</p>
  </section>
</div>`

  return renderShell({
    title: "AgentX · Activity Graph",
    activeTab: "graph",
    subtitle: "Activity Graph",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: GRAPH_CSS,
    scripts: `<script>${GRAPH_SCRIPT}</script>`,
  })
}

const GRAPH_CSS = `
.ax-graph { padding: 16px 24px; }
.ax-graph__head { margin-bottom: 12px; }
.ax-graph__head h1 { margin: 0 0 4px; font-size: 18px; }
.ax-graph__sub { color: var(--ax-muted); font-size: 13px; margin: 0 0 12px; }
.ax-graph__crumbs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.ax-graph__crumb {
  padding: 4px 10px; border-radius: 999px; background: var(--ax-surface-2);
  font-size: 12px; color: var(--ax-text); text-decoration: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.ax-graph__crumb:hover { background: var(--ax-border); }
.ax-graph__crumb.is-active { background: var(--ax-accent, #3a7bd5); color: white; }
.ax-graph__crumb-type { font-size: 10px; opacity: 0.7; text-transform: uppercase; }
.ax-graph__controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 4px 0 8px; }
.ax-graph__controls label { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ax-muted); }
.ax-graph__controls select {
  font: inherit; padding: 4px 8px; border: 1px solid var(--ax-border);
  border-radius: 6px; background: var(--ax-bg); color: var(--ax-text);
}
.ax-graph__controls button {
  padding: 4px 12px; border: 1px solid var(--ax-border); background: var(--ax-bg);
  color: var(--ax-text); border-radius: 6px; cursor: pointer; font: inherit;
}
.ax-graph__chk { cursor: pointer; user-select: none; }
.ax-graph__hint { color: var(--ax-muted); font-size: 11px; margin-left: auto; }
.ax-graph__hint.is-stale { color: #cf222e; }
.ax-graph__hint.is-stale::before { content: "⚠ "; }

/* View toggle */
.ax-graph__view-toggle { display: inline-flex; border: 1px solid var(--ax-border); border-radius: 6px; overflow: hidden; }
.ax-graph__view-toggle button {
  padding: 4px 12px; border: 0; background: var(--ax-bg); color: var(--ax-muted);
  cursor: pointer; font: inherit; border-right: 1px solid var(--ax-border);
}
.ax-graph__view-toggle button:last-child { border-right: 0; }
.ax-graph__view-toggle button:hover { background: var(--ax-surface-2); color: var(--ax-text); }
.ax-graph__view-toggle button.is-active { background: var(--ax-accent, #3a7bd5); color: white; }

/* Timeline mode */
.ax-tl-lane-row { stroke: var(--ax-border); stroke-width: 0.5; }
.ax-tl-lane-bg-even { fill: rgba(127, 127, 127, 0.04); }
.ax-tl-lane-bg-odd { fill: transparent; }
.ax-tl-lane-label {
  font-size: 13px; font-weight: 600; fill: var(--ax-text);
  cursor: pointer;
}
.ax-tl-lane-label:hover { fill: var(--ax-accent, #3a7bd5); text-decoration: underline; }
.ax-tl-lane-label--type {
  font-size: 10px; fill: var(--ax-muted); text-transform: uppercase; letter-spacing: 0.05em;
}
.ax-tl-time-tick { stroke: var(--ax-border); stroke-width: 0.5; stroke-dasharray: 2 2; }
.ax-tl-time-label { font-size: 11px; fill: var(--ax-muted); text-anchor: middle; }
.ax-tl-now-line { stroke: #2da44e; stroke-width: 1.5; }
.ax-tl-now-line--pulse { animation: ax-tl-now-pulse 1.6s ease-in-out infinite; }
@keyframes ax-tl-now-pulse { 50% { stroke-width: 3; opacity: 0.5; } }
.ax-tl-now-label { font-size: 10px; fill: #2da44e; font-weight: 600; }

.ax-tl-dot { cursor: pointer; transition: r 0.18s ease; }
.ax-tl-dot:hover { r: 7; }
.ax-tl-dot--dispatched { fill: #2da44e; stroke: white; stroke-width: 1.5; }
.ax-tl-dot--halted { fill: #6b7280; stroke: white; stroke-width: 1.5; }
.ax-tl-dot--deduped { fill: #9333ea; stroke: white; stroke-width: 1.5; opacity: 0.7; }
.ax-tl-dot--error { fill: #cf222e; stroke: white; stroke-width: 1.5; }
.ax-tl-dot.is-active { animation: ax-tl-dot-pulse 1.4s ease-in-out infinite; }
@keyframes ax-tl-dot-pulse {
  0%,100% { filter: drop-shadow(0 0 0 transparent); }
  50% { filter: drop-shadow(0 0 6px rgba(46, 160, 67, 0.7)); }
}

.ax-tl-arc { fill: none; stroke-width: 1.6; pointer-events: stroke; }
.ax-tl-arc--a2a { stroke: #bf8700; stroke-dasharray: 5 3; }
.ax-tl-arc--resolve { stroke: #6b7280; opacity: 0.5; }
.ax-tl-arc:hover { stroke-width: 3; opacity: 1; cursor: pointer; }
.ax-tl-arc.is-active { animation: ax-edge-flow-a2a 1s linear infinite; }

.ax-graph__canvas-wrap {
  position: relative; border: 1px solid var(--ax-border); border-radius: 8px;
  background: var(--ax-bg); overflow: hidden;
  height: calc(100vh - 240px); min-height: 500px;
}
#ax-graph-svg { width: 100%; height: 100%; cursor: default; }

/* Node styles */
.ax-node-client {
  rx: 14; ry: 14;
  fill: rgba(224, 122, 58, 0.06);
  stroke: rgba(224, 122, 58, 0.5);
  stroke-width: 1.2;
  stroke-dasharray: 4 3;
}
.ax-node-client--label {
  font-size: 14px; font-weight: 600; fill: #e07a3a;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.ax-node-project {
  rx: 8; ry: 8;
  fill: rgba(58, 123, 213, 0.10);
  stroke: rgba(58, 123, 213, 0.7);
  stroke-width: 1.2;
}
.ax-node-project--label {
  font-size: 13px; font-weight: 500; fill: #3a7bd5;
}
.ax-node-subject {
  fill: #6b7280; opacity: 0.85;
}
.ax-node-subject--label {
  font-size: 11px; fill: var(--ax-muted);
}
.ax-node-agent {
  fill: rgba(46, 160, 67, 0.18);
  stroke: #2da44e;
  stroke-width: 1.6;
}
.ax-node-agent--label {
  font-size: 13px; font-weight: 600; fill: var(--ax-text);
}
.ax-node-channel {
  fill: rgba(147, 51, 234, 0.16);
  stroke: #9333ea;
  stroke-width: 1.2;
}
.ax-node-channel--label {
  font-size: 13px; font-weight: 500; fill: #9333ea;
}
.ax-node-initiator {
  fill: rgba(245, 158, 11, 0.20);
  stroke: #f59e0b;
  stroke-width: 1.4;
}
.ax-node-initiator--label {
  font-size: 12px; fill: #d97706; font-weight: 600;
}
.ax-node-group { cursor: pointer; transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease; }
.ax-node-group .ax-node-shape { transition: transform 0.18s ease, fill 0.2s; transform-box: fill-box; transform-origin: center; }
.ax-node-group:hover .ax-node-shape { transform: scale(1.06); }
.ax-node-group.is-root { filter: drop-shadow(0 0 8px rgba(255, 200, 0, 0.7)); }
.ax-node-group.is-dim { opacity: 0.35; }
.ax-node-group.is-entering { animation: ax-node-enter 0.4s ease-out; }
.ax-node-group.is-exiting { animation: ax-node-exit 0.3s ease-in forwards; }
@keyframes ax-node-enter {
  0% { opacity: 0; }
  60% { opacity: 0.6; }
  100% { opacity: 1; }
}
@keyframes ax-node-exit {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
.ax-edge.is-entering { animation: ax-edge-fadein 0.4s ease-out; }
@keyframes ax-edge-fadein {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
/* Particle traveling along an a2a or dispatch path while in-flight */
.ax-particle { fill: #bf8700; }
.ax-particle--dispatch { fill: #2da44e; }
.ax-node-count {
  font-size: 10px; fill: white; font-weight: 700; text-anchor: middle; dominant-baseline: central; pointer-events: none;
}
.ax-node-count-bg { fill: #cf222e; }

/* Edges */
.ax-edge { fill: none; stroke-linecap: round; pointer-events: stroke; }
.ax-edge--contains { stroke: var(--ax-border); stroke-width: 1; opacity: 0.5; }
.ax-edge--arrives { stroke: #9333ea; stroke-width: 1.2; opacity: 0.55; }
.ax-edge--starts { stroke: #f59e0b; stroke-width: 1.2; opacity: 0.55; }
.ax-edge--dispatches { stroke: #2da44e; stroke-width: 1.6; }
.ax-edge--a2a { stroke: #bf8700; stroke-width: 1.6; stroke-dasharray: 5 3; }
.ax-edge--resolves { stroke: #6b7280; stroke-width: 1; opacity: 0.55; }
.ax-edge.is-active { stroke-dasharray: 6 6; animation: ax-edge-flow 1.2s linear infinite; }
.ax-edge--a2a.is-active { stroke-dasharray: 5 3; animation: ax-edge-flow-a2a 1s linear infinite; }
.ax-edge:hover { opacity: 1; stroke-width: 3; cursor: pointer; }
@keyframes ax-edge-flow { to { stroke-dashoffset: -24; } }
@keyframes ax-edge-flow-a2a { to { stroke-dashoffset: -16; } }

/* Pulsing active dot for legend */
.ax-graph__pulse-dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  background: #2da44e; margin-right: 6px;
  animation: ax-pulse 1.4s ease-in-out infinite;
}
@keyframes ax-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(46,160,67,0.6); }
  50% { box-shadow: 0 0 0 6px rgba(46,160,67,0); }
}

.ax-graph__legend {
  position: absolute; bottom: 8px; left: 8px;
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  font-size: 11px; color: var(--ax-muted);
  padding: 6px 10px; border: 1px solid var(--ax-border); border-radius: 6px;
  background: var(--ax-bg); box-shadow: 0 2px 6px rgba(0,0,0,0.06);
}
.ax-graph__legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.ax-graph__legend-sep { opacity: 0.4; }
.ax-graph__legend-edge { display: inline-flex; align-items: center; gap: 4px; }
.ax-graph__legend-pulse { display: inline-flex; align-items: center; }

.ax-graph__tip {
  position: absolute; pointer-events: none; max-width: 320px;
  padding: 8px 10px; background: var(--ax-text); color: var(--ax-bg);
  border-radius: 6px; font-size: 11px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  z-index: 10;
}
.ax-graph__tip-title { font-weight: 600; margin-bottom: 4px; }
.ax-graph__tip-row { opacity: 0.85; margin-bottom: 2px; }
.ax-graph__tip-preview { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); font-family: monospace; word-break: break-word; }

.ax-graph__empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: var(--ax-muted); font-size: 14px; }
`

const GRAPH_SCRIPT = `
(function(){
  var svg = document.getElementById('ax-graph-svg');
  var nodesG = document.getElementById('ax-graph-nodes');
  var edgesG = document.getElementById('ax-graph-edges');
  var crumbs = document.getElementById('ax-graph-crumbs');
  var stamp = document.getElementById('ax-graph-stamp');
  var emptyEl = document.getElementById('ax-graph-empty');
  var tipEl = document.getElementById('ax-graph-tip');
  var winSelect = document.getElementById('ax-graph-window');
  var activeOnlyChk = document.getElementById('ax-graph-active-only');

  // Perspective stack for the breadcrumb. Each entry: {root: 'agent:foo', label: 'foo', type: 'agent'}.
  var stack = [];
  var snapshot = null;

  function svgEl(name, attrs, txt) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) {
      for (var k in attrs) {
        if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      }
    }
    if (txt != null) el.textContent = String(txt);
    return el;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c){
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  // ---- LAYOUT ----------------------------------------------------------
  // Two layout modes:
  //   - rooted: center node, neighbours by depth in concentric rings
  //   - all:    semantic clusters (clients top, agents bottom, channels left, initiators right)

  function layout(snap) {
    var W = 1400, H = 700;
    var positions = {};
    if (snap.root) {
      // rooted mode
      var rootId = snap.root;
      // Compute hop distance via BFS
      var hop = {}; hop[rootId] = 0;
      var q = [rootId];
      while (q.length) {
        var cur = q.shift();
        var d = hop[cur];
        for (var i = 0; i < snap.edges.length; i++) {
          var e = snap.edges[i];
          if (e.from === cur && hop[e.to] == null) { hop[e.to] = d + 1; q.push(e.to); }
          if (e.to === cur && hop[e.from] == null) { hop[e.from] = d + 1; q.push(e.from); }
        }
      }
      var byDepth = {};
      for (var j = 0; j < snap.nodes.length; j++) {
        var n = snap.nodes[j];
        var d = hop[n.id] != null ? hop[n.id] : 99;
        if (!byDepth[d]) byDepth[d] = [];
        byDepth[d].push(n);
      }
      // Place root
      positions[rootId] = { x: W/2, y: H/2 };
      // Concentric rings
      var rings = [220, 360];
      for (var depth = 1; depth <= 2; depth++) {
        var ring = byDepth[depth] || [];
        // Group by type so neighbours of a kind cluster on the same arc
        var grouped = {};
        for (var k = 0; k < ring.length; k++) {
          var t = ring[k].type;
          if (!grouped[t]) grouped[t] = [];
          grouped[t].push(ring[k]);
        }
        var typeOrder = ['client', 'project', 'subject', 'agent', 'channel', 'initiator'];
        var ordered = [];
        for (var ti = 0; ti < typeOrder.length; ti++) {
          if (grouped[typeOrder[ti]]) ordered = ordered.concat(grouped[typeOrder[ti]]);
        }
        var n = ordered.length;
        var angleStart = -Math.PI / 2 + (depth === 1 ? 0 : 0.15);
        var R = rings[depth - 1];
        for (var idx = 0; idx < n; idx++) {
          var a = angleStart + (idx / Math.max(1, n)) * Math.PI * 2;
          positions[ordered[idx].id] = {
            x: W/2 + Math.cos(a) * R,
            y: H/2 + Math.sin(a) * R,
          };
        }
      }
    } else {
      // "All" mode — semantic swim lanes
      // Channels: left edge column
      var channels = snap.nodes.filter(function(n){ return n.type === 'channel'; });
      channels.forEach(function(c, i){
        positions[c.id] = { x: 80, y: 80 + i * 60 };
      });
      // Initiators: right edge column
      var initiators = snap.nodes.filter(function(n){ return n.type === 'initiator'; });
      initiators.forEach(function(c, i){
        positions[c.id] = { x: W - 80, y: 80 + i * 50 };
      });
      // Agents: bottom row (closer to bottom edge but still in view)
      var agents = snap.nodes.filter(function(n){ return n.type === 'agent'; });
      var agentY = H - 70;
      var agentSpan = W - 280;
      agents.forEach(function(a, i){
        positions[a.id] = { x: 160 + (agents.length === 1 ? agentSpan/2 : (i / (agents.length - 1)) * agentSpan), y: agentY };
      });
      // Clients: arrange as boundary boxes across the top half
      // Compute bbox per client based on contained projects' subject counts.
      var clients = snap.nodes.filter(function(n){ return n.type === 'client'; });
      var projects = snap.nodes.filter(function(n){ return n.type === 'project'; });
      var subjects = snap.nodes.filter(function(n){ return n.type === 'subject'; });
      // Map project -> client via "contains" edges.
      var projToClient = {};
      var subjToProj = {};
      snap.edges.forEach(function(e){
        if (e.kind !== 'contains') return;
        if (e.from.indexOf('client:') === 0 && e.to.indexOf('project:') === 0) projToClient[e.to] = e.from;
        if (e.from.indexOf('project:') === 0 && e.to.indexOf('subject:') === 0) subjToProj[e.to] = e.from;
      });
      var clientCols = clients.length;
      var clientWidth = clientCols > 0 ? (W - 320) / clientCols : 0;
      var clientHeight = 320;
      clients.forEach(function(c, ci){
        var x0 = 180 + ci * clientWidth;
        var y0 = 60;
        positions[c.id] = { x: x0 + clientWidth/2, y: y0, _bbox: { x: x0, y: y0, w: clientWidth - 16, h: clientHeight }};
      });
      // Projects within client box
      var projsByClient = {};
      projects.forEach(function(p){
        var ck = projToClient[p.id];
        if (!ck) return;
        if (!projsByClient[ck]) projsByClient[ck] = [];
        projsByClient[ck].push(p);
      });
      Object.keys(projsByClient).forEach(function(ck){
        var bbox = positions[ck] && positions[ck]._bbox;
        if (!bbox) return;
        var ps = projsByClient[ck];
        var pHeight = (bbox.h - 50) / Math.max(1, ps.length);
        ps.forEach(function(p, pi){
          var px = bbox.x + bbox.w / 2;
          var py = bbox.y + 40 + pi * pHeight + pHeight / 2;
          positions[p.id] = { x: px, y: py, _bbox: { x: bbox.x + 12, y: py - pHeight/2 + 8, w: bbox.w - 24, h: pHeight - 16 } };
        });
      });
      // Subjects as dots inside their project's bbox, max 6 visible
      var subjsByProj = {};
      subjects.forEach(function(s){
        var pk = subjToProj[s.id];
        // Subjects without a project skip the project-bbox bucketing and
        // get distributed by the orphan handler below.
        if (!pk) return;
        if (!subjsByProj[pk]) subjsByProj[pk] = [];
        subjsByProj[pk].push(s);
      });
      Object.keys(subjsByProj).forEach(function(pk){
        var bbox = positions[pk] && positions[pk]._bbox;
        if (!bbox) return;
        var ss = subjsByProj[pk].slice(0, 12);
        var cols = 4;
        ss.forEach(function(s, si){
          var col = si % cols;
          var row = Math.floor(si / cols);
          var sx = bbox.x + 16 + (col + 0.5) * (bbox.w - 32) / cols;
          var sy = bbox.y + 14 + row * 14;
          positions[s.id] = { x: sx, y: sy };
        });
      });
      // Subjects without a project — distribute across the middle of the
      // canvas in a grid so they don't all stack at center (the default
      // when there are zero clients/projects, common on local dev nodes).
      var orphanSubjects = subjects.filter(function(s){ return !positions[s.id]; });
      if (orphanSubjects.length) {
        var cols2 = Math.ceil(Math.sqrt(orphanSubjects.length * 1.5));
        var rows2 = Math.ceil(orphanSubjects.length / cols2);
        var midY0 = 80, midY1 = H - 200;
        var midX0 = 200, midX1 = W - 200;
        orphanSubjects.forEach(function(s, i){
          var c = i % cols2, r = Math.floor(i / cols2);
          var x = midX0 + (cols2 === 1 ? (midX1 - midX0)/2 : (c / (cols2 - 1)) * (midX1 - midX0));
          var y = midY0 + (rows2 === 1 ? (midY1 - midY0)/2 : (r / (rows2 - 1)) * (midY1 - midY0));
          positions[s.id] = { x: x, y: y };
        });
      }
      // Default for any still-missed nodes
      snap.nodes.forEach(function(n){
        if (!positions[n.id]) positions[n.id] = { x: W/2, y: H/2 };
      });
    }
    return positions;
  }

  // ---- RENDER (incremental — reuses DOM nodes across snapshots so CSS
  // transitions on transform animate position changes smoothly) ---------

  // DOM caches keyed by node-id / edge-id so renders are diffs.
  var nodeEls = new Map();        // node.id -> <g>
  var edgeEls = new Map();        // edge.id -> <path>
  var bboxEls = new Map();        // node.id -> <rect> + <text> (client/project boundary in "All" mode)
  var particleEls = new Map();    // edge.id -> <circle> with <animateMotion>

  function clearAll() {
    nodeEls.forEach(function(el){ el.remove(); }); nodeEls.clear();
    edgeEls.forEach(function(el){ el.remove(); }); edgeEls.clear();
    bboxEls.forEach(function(b){ b.rect.remove(); b.label.remove(); }); bboxEls.clear();
    particleEls.forEach(function(el){ el.remove(); }); particleEls.clear();
  }

  function render(snap) {
    if (!snap.nodes.length) {
      clearAll();
      emptyEl.hidden = false;
      stamp.textContent = '';
      return;
    }
    emptyEl.hidden = true;

    var activeOnly = activeOnlyChk.checked;
    var keepNodes = new Set();
    var renderEdges = snap.edges;
    if (activeOnly) {
      renderEdges = renderEdges.filter(function(e){ return e.active || e.kind === 'contains'; });
      renderEdges.forEach(function(e){ keepNodes.add(e.from); keepNodes.add(e.to); });
      if (snap.root) keepNodes.add(snap.root);
    }
    var renderNodes = activeOnly ? snap.nodes.filter(function(n){ return keepNodes.has(n.id); }) : snap.nodes;

    // Skip invisible kinds in "All" mode (handled by bbox)
    var skipNode = function(n){ return !snap.root && (n.type === 'client' || n.type === 'project'); };
    // In "All" mode skip containment edges (bbox conveys it)
    var visibleEdges = renderEdges.filter(function(e){ return snap.root || e.kind !== 'contains'; });

    var pos = layout({ nodes: renderNodes, edges: renderEdges, root: snap.root });

    var seenNodeIds = new Set();
    var seenEdgeIds = new Set();
    var seenBboxIds = new Set();

    // ---- Boundary boxes (clients + projects in "All" mode) ----
    if (!snap.root) {
      renderNodes.forEach(function(n){
        var p = pos[n.id];
        if (!p || !p._bbox) return;
        if (n.type !== 'client' && n.type !== 'project') return;
        seenBboxIds.add(n.id);
        var entry = bboxEls.get(n.id);
        var cls = n.type === 'client' ? 'ax-node-client' : 'ax-node-project';
        var lblCls = n.type === 'client' ? 'ax-node-client--label' : 'ax-node-project--label';
        var lblOffsetY = n.type === 'client' ? 22 : 14;
        if (!entry) {
          var rect = svgEl('rect', { x: p._bbox.x, y: p._bbox.y, width: p._bbox.w, height: p._bbox.h, class: cls });
          edgesG.appendChild(rect);
          var lbl = svgEl('text', { x: p._bbox.x + (n.type === 'client' ? 12 : 8), y: p._bbox.y + lblOffsetY, class: lblCls }, n.label);
          edgesG.appendChild(lbl);
          rect.addEventListener('click', function(){ pushPerspective(n); });
          rect.addEventListener('mouseenter', function(ev){ showNodeTip(n, ev); });
          rect.addEventListener('mousemove', moveTip);
          rect.addEventListener('mouseleave', hideTip);
          rect.style.cursor = 'pointer';
          bboxEls.set(n.id, { rect: rect, label: lbl });
        } else {
          // Animate position via CSS transition on attribute change isn't
          // free for SVG <rect> — use inline style transitions on x/y.
          entry.rect.setAttribute('x', p._bbox.x);
          entry.rect.setAttribute('y', p._bbox.y);
          entry.rect.setAttribute('width', p._bbox.w);
          entry.rect.setAttribute('height', p._bbox.h);
          entry.label.setAttribute('x', p._bbox.x + (n.type === 'client' ? 12 : 8));
          entry.label.setAttribute('y', p._bbox.y + lblOffsetY);
          entry.label.textContent = n.label;
        }
      });
    }
    // Remove bboxes that aren't in the new snapshot
    bboxEls.forEach(function(entry, id){
      if (!seenBboxIds.has(id)) {
        entry.rect.remove();
        entry.label.remove();
        bboxEls.delete(id);
      }
    });

    // ---- Edges (paths + particles) ----
    visibleEdges.forEach(function(e){
      var from = pos[e.from], to = pos[e.to];
      if (!from || !to) return;
      seenEdgeIds.add(e.id);

      var dx = to.x - from.x, dy = to.y - from.y;
      var cx = (from.x + to.x) / 2 + (dy * 0.18);
      var cy = (from.y + to.y) / 2 - (dx * 0.18);
      var d = 'M' + from.x + ',' + from.y + ' Q' + cx + ',' + cy + ' ' + to.x + ',' + to.y;
      var pathId = 'p-' + e.id.replace(/[^a-zA-Z0-9]/g, '-');
      var marker = (e.kind === 'dispatches') ? 'arrow-dispatch' : (e.kind === 'a2a') ? 'arrow-a2a' : (e.kind === 'resolves') ? 'arrow-resolve' : null;
      var nextCls = 'ax-edge ax-edge--' + e.kind + (e.active ? ' is-active' : '');

      var path = edgeEls.get(e.id);
      if (!path) {
        path = svgEl('path', {
          d: d,
          id: pathId,
          class: nextCls + ' is-entering',
          'data-edge': e.id,
        });
        if (marker) path.setAttribute('marker-end', 'url(#' + marker + ')');
        path.addEventListener('mouseenter', function(ev){ showEdgeTip(e, ev); });
        path.addEventListener('mousemove', moveTip);
        path.addEventListener('mouseleave', hideTip);
        edgesG.appendChild(path);
        edgeEls.set(e.id, path);
      } else {
        path.setAttribute('d', d);
        path.setAttribute('class', nextCls);
        if (marker) path.setAttribute('marker-end', 'url(#' + marker + ')');
        else path.removeAttribute('marker-end');
        path.id = pathId; // ensure stable id
      }

      // Particle on active dispatch and a2a edges. SVG <animateMotion> draws
      // a small filled circle traveling along the path at a constant rate —
      // the visual cue that "work is moving" between nodes.
      var wantsParticle = e.active && (e.kind === 'a2a' || e.kind === 'dispatches');
      var particle = particleEls.get(e.id);
      if (wantsParticle) {
        if (!particle) {
          particle = svgEl('circle', { r: 3.5, class: 'ax-particle' + (e.kind === 'dispatches' ? ' ax-particle--dispatch' : '') });
          var motion = svgEl('animateMotion', { dur: e.kind === 'a2a' ? '1.4s' : '1.8s', repeatCount: 'indefinite' });
          var mpath = svgEl('mpath');
          mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + pathId);
          mpath.setAttribute('href', '#' + pathId);
          motion.appendChild(mpath);
          particle.appendChild(motion);
          edgesG.appendChild(particle);
          particleEls.set(e.id, particle);
        }
      } else if (particle) {
        particle.remove();
        particleEls.delete(e.id);
      }
    });
    // Remove edges that left the snapshot
    edgeEls.forEach(function(el, id){
      if (!seenEdgeIds.has(id)) {
        el.remove();
        edgeEls.delete(id);
        var p = particleEls.get(id);
        if (p) { p.remove(); particleEls.delete(id); }
      }
    });

    // ---- Nodes ----
    renderNodes.forEach(function(n){
      var p = pos[n.id];
      if (!p) return;
      if (skipNode(n)) return;
      seenNodeIds.add(n.id);
      var g = nodeEls.get(n.id);
      var transform = 'translate(' + p.x + ',' + p.y + ')';
      if (!g) {
        g = svgEl('g', {
          class: 'ax-node-group is-entering' + (n.id === snap.root ? ' is-root' : ''),
          'data-node': n.id,
          transform: transform,
        });
        drawNode(g, n);
        g.addEventListener('mouseenter', function(ev){ showNodeTip(n, ev); });
        g.addEventListener('mousemove', moveTip);
        g.addEventListener('mouseleave', hideTip);
        g.addEventListener('click', function(){ pushPerspective(n); });
        nodesG.appendChild(g);
        nodeEls.set(n.id, g);
      } else {
        // Existing node — just update transform; CSS transition animates
        g.setAttribute('transform', transform);
        var cls = 'ax-node-group' + (n.id === snap.root ? ' is-root' : '');
        g.setAttribute('class', cls);
        // Update active count badge if changed
        updateNodeCount(g, n);
      }
    });
    // Remove nodes that left
    nodeEls.forEach(function(el, id){
      if (!seenNodeIds.has(id)) {
        el.classList.add('is-exiting');
        setTimeout(function(){ el.remove(); }, 320);
        nodeEls.delete(id);
      }
    });

    stamp.textContent = renderNodes.length + ' nodes · ' + visibleEdges.length + ' edges · streamed ' + new Date(snap.ts).toLocaleTimeString();
  }

  function updateNodeCount(g, n) {
    // Find existing badge group
    var badge = g.querySelector('.ax-node-count-bg');
    if (n.count && n.count > 0) {
      if (!badge) {
        // Compute badge offset based on node type
        var dx = n.type === 'agent' ? 22 : 24;
        var dy = n.type === 'agent' ? -22 : -16;
        drawCountBadge(g, n.count, dx, dy);
      } else {
        var txt = g.querySelector('.ax-node-count');
        if (txt) txt.textContent = String(n.count);
      }
    } else if (badge) {
      var txtEl = g.querySelector('.ax-node-count');
      badge.remove();
      if (txtEl) txtEl.remove();
    }
  }

  function drawNode(g, n) {
    if (n.type === 'agent') {
      g.appendChild(svgEl('circle', { r: 26, class: 'ax-node-agent' }));
      g.appendChild(svgEl('text', { 'text-anchor': 'middle', dy: 4, class: 'ax-node-agent--label' }, truncate(n.label, 14)));
      if (n.count && n.count > 0) drawCountBadge(g, n.count, 22, -22);
    } else if (n.type === 'channel') {
      g.appendChild(svgEl('rect', { x: -36, y: -14, width: 72, height: 28, rx: 14, class: 'ax-node-channel' }));
      g.appendChild(svgEl('text', { 'text-anchor': 'middle', dy: 4, class: 'ax-node-channel--label' }, n.label));
    } else if (n.type === 'initiator') {
      g.appendChild(svgEl('circle', { r: 18, class: 'ax-node-initiator' }));
      g.appendChild(svgEl('text', { 'text-anchor': 'middle', dy: 4, class: 'ax-node-initiator--label' }, initials(n.label)));
    } else if (n.type === 'subject') {
      g.appendChild(svgEl('circle', { r: 5, class: 'ax-node-subject' }));
      g.appendChild(svgEl('text', { x: 9, dy: 3, class: 'ax-node-subject--label' }, truncate(shortSubject(n.label), 22)));
    } else if (n.type === 'project') {
      // Only used in "rooted" view; in "All" we draw as bbox above.
      g.appendChild(svgEl('rect', { x: -60, y: -14, width: 120, height: 28, class: 'ax-node-project' }));
      g.appendChild(svgEl('text', { 'text-anchor': 'middle', dy: 4, class: 'ax-node-project--label' }, truncate(n.label, 18)));
    } else if (n.type === 'client') {
      g.appendChild(svgEl('rect', { x: -50, y: -16, width: 100, height: 32, class: 'ax-node-client' }));
      g.appendChild(svgEl('text', { 'text-anchor': 'middle', dy: 4, class: 'ax-node-client--label' }, n.label));
    }
  }

  function drawCountBadge(g, n, dx, dy) {
    g.appendChild(svgEl('circle', { cx: dx, cy: dy, r: 8, class: 'ax-node-count-bg' }));
    g.appendChild(svgEl('text', { x: dx, y: dy, class: 'ax-node-count' }, String(n)));
  }

  function shortSubject(s) {
    // Trim "merge_request:957:..." to "MR #957" etc.
    if (!s) return '';
    var m = s.match(/^merge_request:(\\d+)/);
    if (m) return 'MR #' + m[1];
    var i = s.match(/^issue:(\\d+)/);
    if (i) return 'issue #' + i[1];
    return s;
  }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function initials(s) {
    s = String(s || '?');
    var parts = s.split(/\\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  // ---- TIP -------------------------------------------------------------
  function showNodeTip(n, ev) {
    var html = '<div class="ax-graph__tip-title">' + esc(n.label) + '</div>'
      + '<div class="ax-graph__tip-row">type: ' + esc(n.type) + (n.sub ? ' · ' + esc(n.sub) : '') + '</div>'
      + (n.count ? '<div class="ax-graph__tip-row">' + n.count + ' active connection' + (n.count === 1 ? '' : 's') + '</div>' : '')
      + '<div class="ax-graph__tip-row" style="opacity:0.6">click to view from this perspective</div>';
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    moveTip(ev);
  }
  function showEdgeTip(e, ev) {
    var html = '<div class="ax-graph__tip-title">' + e.kind + (e.active ? ' · in-flight' : '') + '</div>'
      + (e.outcome ? '<div class="ax-graph__tip-row">outcome: ' + esc(e.outcome) + '</div>' : '')
      + (e.startedAt ? '<div class="ax-graph__tip-row">started ' + new Date(e.startedAt).toLocaleString() + '</div>' : '')
      + (e.resolvedAt ? '<div class="ax-graph__tip-row">resolved ' + new Date(e.resolvedAt).toLocaleString() + '</div>' : '')
      + (e.preview ? '<div class="ax-graph__tip-preview">' + esc(e.preview.slice(0, 200)) + '</div>' : '');
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    var rect = svg.getBoundingClientRect();
    var x = Math.min(ev.clientX - rect.left + 14, rect.width - 340);
    var y = Math.min(ev.clientY - rect.top + 14, rect.height - 80);
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }
  function hideTip() { tipEl.hidden = true; }

  // ---- BREADCRUMB ------------------------------------------------------
  function pushPerspective(n) {
    stack.push({ root: n.id, label: n.label, type: n.type });
    renderCrumbs();
    connect();
  }
  function popTo(idx) {
    stack = stack.slice(0, idx);
    renderCrumbs();
    connect();
  }
  function renderCrumbs() {
    var html = '<a class="ax-graph__crumb' + (stack.length === 0 ? ' is-active' : '') + '" data-pop="0" href="#">All</a>';
    for (var i = 0; i < stack.length; i++) {
      var s = stack[i];
      html += '<span style="opacity:.5">›</span>'
        + '<a class="ax-graph__crumb' + (i === stack.length - 1 ? ' is-active' : '') + '" data-pop="' + (i + 1) + '" href="#">'
        + '<span class="ax-graph__crumb-type">' + esc(s.type) + '</span>' + esc(s.label) + '</a>';
    }
    crumbs.innerHTML = html;
    crumbs.querySelectorAll('[data-pop]').forEach(function(a){
      a.addEventListener('click', function(ev){
        ev.preventDefault();
        popTo(parseInt(a.getAttribute('data-pop'), 10));
      });
    });
  }

  // ---- TIMELINE (git-graph-style) -------------------------------------
  // Lanes = entities (agents in default; root + 1-hop neighbours when
  // rooted). Time axis = horizontal, oldest left, "now" right. Each
  // dispatch decision is a dot on its agent's lane at decision_time.
  // a2a calls draw a curved arc from the caller's lane to the callee's
  // lane (forward in time). Resolutions draw a thinner arc back.

  function renderTimeline(snap) {
    if (!snap.nodes.length) {
      clearAll();
      emptyEl.hidden = false;
      stamp.textContent = '';
      return;
    }
    emptyEl.hidden = true;

    var W = 1400, H = 700;
    var leftPad = 180, rightPad = 60, topPad = 50, bottomPad = 40;
    var laneAreaH = H - topPad - bottomPad;
    var timeAreaW = W - leftPad - rightPad;

    var hoursWindow = parseInt(winSelect.value, 10);
    var nowMs = snap.ts;
    var startMs = nowMs - hoursWindow * 3600 * 1000;

    // ---- Lane assignment ----
    // Default: top-N agents by activity in the window
    // Rooted: root + 1-hop neighbours of compatible types
    var laneEntities = computeTimelineLanes(snap);
    var laneById = {};
    laneEntities.forEach(function(n, i){ laneById[n.id] = i; });
    var laneH = Math.max(36, Math.min(70, laneAreaH / Math.max(1, laneEntities.length)));

    function laneY(i) { return topPad + i * laneH + laneH / 2; }
    function timeX(ts) {
      var t = Math.max(startMs, Math.min(nowMs, ts || startMs));
      return leftPad + ((t - startMs) / Math.max(1, nowMs - startMs)) * timeAreaW;
    }

    // ---- Reset DOM caches that this mode owns ----
    nodeEls.forEach(function(el){ el.remove(); }); nodeEls.clear();
    edgeEls.forEach(function(el){ el.remove(); }); edgeEls.clear();
    bboxEls.forEach(function(b){ b.rect.remove(); b.label.remove(); }); bboxEls.clear();
    particleEls.forEach(function(el){ el.remove(); }); particleEls.clear();
    nodesG.innerHTML = '';
    edgesG.innerHTML = '';

    // ---- Lane rows ----
    laneEntities.forEach(function(n, i){
      var y0 = topPad + i * laneH;
      var bg = svgEl('rect', {
        x: leftPad, y: y0, width: timeAreaW, height: laneH,
        class: i % 2 === 0 ? 'ax-tl-lane-bg-even' : 'ax-tl-lane-bg-odd',
      });
      edgesG.appendChild(bg);
      var sep = svgEl('line', {
        x1: leftPad, y1: y0 + laneH, x2: leftPad + timeAreaW, y2: y0 + laneH,
        class: 'ax-tl-lane-row',
      });
      edgesG.appendChild(sep);

      // Label group on the left, clickable
      var labelTypeY = y0 + laneH/2 - 6;
      var labelMainY = y0 + laneH/2 + 7;
      var typeText = svgEl('text', {
        x: leftPad - 12, y: labelTypeY, 'text-anchor': 'end',
        class: 'ax-tl-lane-label--type',
      }, n.type);
      var mainText = svgEl('text', {
        x: leftPad - 12, y: labelMainY, 'text-anchor': 'end',
        class: 'ax-tl-lane-label',
      }, truncate(n.label, 22));
      typeText.style.cursor = 'pointer';
      mainText.addEventListener('click', function(){ pushPerspective(n); });
      typeText.addEventListener('click', function(){ pushPerspective(n); });
      mainText.addEventListener('mouseenter', function(ev){ showNodeTip(n, ev); });
      mainText.addEventListener('mousemove', moveTip);
      mainText.addEventListener('mouseleave', hideTip);
      nodesG.appendChild(typeText);
      nodesG.appendChild(mainText);
    });

    // ---- Time-axis ticks ----
    var ticks = computeTimeTicks(startMs, nowMs);
    ticks.forEach(function(t){
      var x = timeX(t.ts);
      edgesG.appendChild(svgEl('line', {
        x1: x, y1: topPad, x2: x, y2: topPad + laneAreaH,
        class: 'ax-tl-time-tick',
      }));
      nodesG.appendChild(svgEl('text', {
        x: x, y: topPad + laneAreaH + 16, class: 'ax-tl-time-label',
      }, t.label));
    });
    // "Now" line
    var nowX = leftPad + timeAreaW;
    edgesG.appendChild(svgEl('line', {
      x1: nowX, y1: topPad - 4, x2: nowX, y2: topPad + laneAreaH + 4,
      class: 'ax-tl-now-line ax-tl-now-line--pulse',
    }));
    nodesG.appendChild(svgEl('text', {
      x: nowX, y: topPad - 8, class: 'ax-tl-now-label', 'text-anchor': 'end',
    }, 'now'));

    // ---- Edges (a2a + resolves) — drawn behind dots ----
    // Per-edge arc from (caller_lane, started_at) to (callee_lane, started_at)
    var activeOnlyEdges = activeOnlyChk.checked;
    snap.edges.forEach(function(e){
      var fromLane = laneById[e.from], toLane = laneById[e.to];
      if (fromLane == null || toLane == null) return;
      if (e.kind !== 'a2a' && e.kind !== 'resolves' && e.kind !== 'dispatches') return;
      if (activeOnlyEdges && !e.active) return;
      // Skip dispatches between lanes that aren't both shown (e.g. subject->agent
      // when subject not in lane). Only draw when both endpoints are lanes.
      var startTs = e.startedAt || e.resolvedAt;
      var endTs = e.resolvedAt || e.startedAt;
      if (!startTs) return;
      var x1 = timeX(startTs), y1 = laneY(fromLane);
      var x2 = timeX(endTs || startTs), y2 = laneY(toLane);
      // Bezier control: pull horizontally for the lane jump
      var midX = (x1 + x2) / 2;
      var d = 'M' + x1 + ',' + y1 +
              ' C' + midX + ',' + y1 + ' ' + midX + ',' + y2 + ' ' + x2 + ',' + y2;
      var cls = 'ax-tl-arc ax-tl-arc--' + (e.kind === 'a2a' ? 'a2a' : 'resolve') + (e.active ? ' is-active' : '');
      var path = svgEl('path', { d: d, class: cls, 'data-edge': e.id });
      path.addEventListener('mouseenter', function(ev){ showEdgeTip(e, ev); });
      path.addEventListener('mousemove', moveTip);
      path.addEventListener('mouseleave', hideTip);
      edgesG.appendChild(path);
      edgeEls.set(e.id, path);
    });

    // ---- Dots (one per dispatch decision) ----
    // Plot each dispatch as a dot on the receiving agent's lane.
    // Group dots that fall within ~6px of each other on the same lane
    // and stack them vertically so each is hoverable / clickable.
    var activeOnly = activeOnlyChk.checked;
    var dispatchEdges = snap.edges.filter(function(e){
      if (e.kind !== 'dispatches' || laneById[e.to] == null || !e.startedAt) return false;
      if (activeOnly && !e.active) return false;
      return true;
    });
    // Group key = "<lane>|<roundedX>" with 6px buckets
    var bucket = {};
    dispatchEdges.forEach(function(e){
      var lane = laneById[e.to];
      var x = timeX(e.startedAt);
      var key = lane + '|' + Math.round(x / 6);
      if (!bucket[key]) bucket[key] = { lane: lane, x: x, items: [] };
      bucket[key].items.push(e);
    });
    Object.values(bucket).forEach(function(b){
      var baseY = laneY(b.lane);
      b.items.forEach(function(e, i){
        var x = b.x + (i - (b.items.length - 1) / 2) * 0; // x stays anchored
        // Stack vertically when more than one in the same bucket
        var off = b.items.length === 1 ? 0 : ((i - (b.items.length - 1) / 2) * 5);
        var y = baseY + off;
        var status = e.outcome || 'dispatched';
        var dotCls = 'ax-tl-dot ax-tl-dot--' +
          (status === 'dispatched' && !e.resolvedAt ? 'dispatched'
            : status === 'halted' ? 'halted'
            : status === 'deduped' ? 'deduped'
            : status === 'error' ? 'error'
            : 'dispatched')
          + (e.active ? ' is-active' : '');
        var dot = svgEl('circle', { cx: x, cy: y, r: 5, class: dotCls, 'data-edge': e.id });
        dot.addEventListener('mouseenter', function(ev){ showEdgeTip(e, ev); });
        dot.addEventListener('mousemove', moveTip);
        dot.addEventListener('mouseleave', hideTip);
        dot.addEventListener('click', function(){
          var agentNode = snap.nodes.find(function(n){ return n.id === e.to; });
          if (agentNode) pushPerspective(agentNode);
        });
        nodesG.appendChild(dot);
      });
    });

    stamp.textContent = laneEntities.length + ' lanes · ' + snap.edges.filter(function(e){ return e.kind === 'dispatches'; }).length + ' dispatches · streamed ' + new Date(snap.ts).toLocaleTimeString();
  }

  function computeTimelineLanes(snap) {
    // Score each node by participation in dispatch/a2a edges.
    var score = {};
    snap.edges.forEach(function(e){
      if (e.kind === 'a2a' || e.kind === 'dispatches' || e.kind === 'resolves') {
        score[e.from] = (score[e.from] || 0) + 1;
        score[e.to] = (score[e.to] || 0) + 1;
      }
    });
    // Lane candidates = agents (always), plus root + neighbours when rooted
    var candidates = snap.nodes.filter(function(n){
      return n.type === 'agent' || n.id === snap.root;
    });
    if (snap.root) {
      // Add 1-hop neighbours of any type so the root's lane has its connections rendered
      var neighbours = new Set();
      snap.edges.forEach(function(e){
        if (e.from === snap.root) neighbours.add(e.to);
        if (e.to === snap.root) neighbours.add(e.from);
      });
      snap.nodes.forEach(function(n){
        if (neighbours.has(n.id) && !candidates.find(function(c){ return c.id === n.id; })) {
          candidates.push(n);
        }
      });
    }
    candidates.sort(function(a, b){
      // Root first
      if (a.id === snap.root) return -1;
      if (b.id === snap.root) return 1;
      // Then by score desc, then alphabetical
      var d = (score[b.id] || 0) - (score[a.id] || 0);
      if (d !== 0) return d;
      return a.label < b.label ? -1 : 1;
    });
    // Cap at a reasonable number to keep lanes readable
    return candidates.slice(0, 18);
  }

  function computeTimeTicks(startMs, nowMs) {
    var span = nowMs - startMs;
    // Pick a tick interval roughly 6-10 ticks across the range
    var hourMs = 3600 * 1000;
    var step;
    if (span <= 1.5 * hourMs) step = 10 * 60 * 1000;        // 10 min
    else if (span <= 8 * hourMs) step = hourMs;             // 1 hr
    else if (span <= 36 * hourMs) step = 4 * hourMs;        // 4 hr
    else if (span <= 8 * 24 * hourMs) step = 24 * hourMs;   // 1 day
    else step = 7 * 24 * hourMs;                            // 1 wk

    var ticks = [];
    // Anchor on 'now', step backwards
    var t = nowMs;
    while (t >= startMs - step) {
      ticks.push({ ts: t, label: fmtTickLabel(t, step) });
      t -= step;
    }
    return ticks;
  }
  function fmtTickLabel(ts, step) {
    var d = new Date(ts);
    if (step < 3600 * 1000) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    if (step < 24 * 3600 * 1000) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- VIEW DISPATCH ---------------------------------------------------
  var view = 'timeline'; // default
  var lastView = null;
  function dispatchRender(snap) {
    // When switching modes, clear ALL DOM children first because each mode
    // appends its own elements directly to edgesG / nodesG (lane rows in
    // timeline, boundary boxes in lens) that the other mode's renderer
    // doesn't track or remove.
    if (view !== lastView) {
      nodesG.innerHTML = '';
      edgesG.innerHTML = '';
      nodeEls.clear();
      edgeEls.clear();
      bboxEls.clear();
      particleEls.clear();
      lastView = view;
    }
    if (view === 'timeline') return renderTimeline(snap);
    return render(snap);
  }

  // ---- LIVE STREAM (SSE) ----------------------------------------------
  // Fresh snapshot every TICK_MS from the server. The render is
  // incremental — same DOM nodes get reused across snapshots so the CSS
  // transition on .ax-node-group { transition: transform } animates
  // position changes smoothly. Reconnects on error/close.
  var es = null;
  var reconnectTimer = null;

  function streamUrl() {
    var hours = winSelect.value;
    var root = stack.length ? stack[stack.length - 1].root : '';
    return '/api/admin/activity-graph/stream?hours=' + encodeURIComponent(hours) + (root ? '&root=' + encodeURIComponent(root) : '');
  }

  function connect() {
    if (es) { try { es.close(); } catch(_){} es = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    es = new EventSource(streamUrl(), { withCredentials: true });
    es.addEventListener('snapshot', function(ev){
      try {
        snapshot = JSON.parse(ev.data);
        dispatchRender(snapshot);
        stamp.classList.remove('is-stale');
      } catch (e) { console.error('snapshot parse failed', e); }
    });
    es.addEventListener('error', function(){
      stamp.classList.add('is-stale');
      // EventSource auto-reconnects on transient errors, but on a clean
      // 4xx/5xx the readyState becomes CLOSED and we need to retry manually.
      if (es && es.readyState === 2) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    });
  }

  // One-shot fetch fallback (used by the manual refresh button so the
  // button does something visible even when the SSE is mid-tick).
  async function fetchOnce() {
    var hours = winSelect.value;
    var root = stack.length ? stack[stack.length - 1].root : '';
    var qs = '?hours=' + encodeURIComponent(hours) + (root ? '&root=' + encodeURIComponent(root) : '');
    try {
      var r = await fetch('/api/admin/activity-graph' + qs, { credentials: 'same-origin' });
      snapshot = await r.json();
      dispatchRender(snapshot);
    } catch (e) { console.error('graph fetch failed', e); }
  }

  document.getElementById('ax-graph-refresh').addEventListener('click', function(){
    fetchOnce();      // immediate render
    connect();        // re-connect SSE so we don't wait a full tick
  });
  winSelect.addEventListener('change', connect);
  activeOnlyChk.addEventListener('change', function(){ if (snapshot) dispatchRender(snapshot); });

  // View toggle (Timeline ↔ Lens)
  var toggleBtns = document.querySelectorAll('.ax-graph__view-toggle button');
  toggleBtns.forEach(function(b){
    b.addEventListener('click', function(){
      toggleBtns.forEach(function(x){ x.classList.toggle('is-active', x === b); });
      view = b.getAttribute('data-view');
      // Adjust SVG viewBox per mode for best layout. Timeline benefits
      // from a wider canvas; lens prefers a square-ish ratio.
      svg.setAttribute('viewBox', view === 'timeline' ? '0 0 1400 800' : '0 0 1400 800');
      if (snapshot) dispatchRender(snapshot);
    });
  });

  connect();
  // Tab visibility: pause stream when tab hidden, reopen on return
  document.addEventListener('visibilitychange', function(){
    if (document.hidden) {
      if (es) { try { es.close(); } catch(_){} es = null; }
    } else {
      connect();
    }
  });
})();
`
