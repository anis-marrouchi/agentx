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
      <label>Window
        <select id="ax-graph-window">
          <option value="1">1 hour</option>
          <option value="6">6 hours</option>
          <option value="24" selected>24 hours</option>
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
    <svg id="ax-graph-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 800" preserveAspectRatio="xMidYMid meet">
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
    activeTab: "observability",
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
  font-size: 12px; color: var(--ax-fg); text-decoration: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.ax-graph__crumb:hover { background: var(--ax-border); }
.ax-graph__crumb.is-active { background: var(--ax-accent, #3a7bd5); color: white; }
.ax-graph__crumb-type { font-size: 10px; opacity: 0.7; text-transform: uppercase; }
.ax-graph__controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 4px 0 8px; }
.ax-graph__controls label { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ax-muted); }
.ax-graph__controls select {
  font: inherit; padding: 4px 8px; border: 1px solid var(--ax-border);
  border-radius: 6px; background: var(--ax-bg); color: var(--ax-fg);
}
.ax-graph__controls button {
  padding: 4px 12px; border: 1px solid var(--ax-border); background: var(--ax-bg);
  color: var(--ax-fg); border-radius: 6px; cursor: pointer; font: inherit;
}
.ax-graph__chk { cursor: pointer; user-select: none; }
.ax-graph__hint { color: var(--ax-muted); font-size: 11px; margin-left: auto; }

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
  font-size: 11px; font-weight: 600; fill: #e07a3a;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.ax-node-project {
  rx: 8; ry: 8;
  fill: rgba(58, 123, 213, 0.10);
  stroke: rgba(58, 123, 213, 0.7);
  stroke-width: 1.2;
}
.ax-node-project--label {
  font-size: 11px; font-weight: 500; fill: #3a7bd5;
}
.ax-node-subject {
  fill: #6b7280; opacity: 0.85;
}
.ax-node-subject--label {
  font-size: 9.5px; fill: var(--ax-muted);
}
.ax-node-agent {
  fill: rgba(46, 160, 67, 0.18);
  stroke: #2da44e;
  stroke-width: 1.6;
}
.ax-node-agent--label {
  font-size: 11px; font-weight: 600; fill: var(--ax-fg);
}
.ax-node-channel {
  fill: rgba(147, 51, 234, 0.16);
  stroke: #9333ea;
  stroke-width: 1.2;
}
.ax-node-channel--label {
  font-size: 11px; font-weight: 500; fill: #9333ea;
}
.ax-node-initiator {
  fill: rgba(245, 158, 11, 0.20);
  stroke: #f59e0b;
  stroke-width: 1.4;
}
.ax-node-initiator--label {
  font-size: 10px; fill: #b45309; font-weight: 600;
}
.ax-node-group { cursor: pointer; transition: transform 0.18s ease; transform-box: fill-box; transform-origin: center; }
.ax-node-group:hover { transform: scale(1.06); }
.ax-node-group.is-root { filter: drop-shadow(0 0 6px rgba(255, 200, 0, 0.6)); }
.ax-node-group.is-dim { opacity: 0.35; }
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
  padding: 8px 10px; background: var(--ax-fg); color: var(--ax-bg);
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
    var W = 1400, H = 800;
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
        positions[c.id] = { x: 80, y: 80 + i * 80 };
      });
      // Initiators: right edge column
      var initiators = snap.nodes.filter(function(n){ return n.type === 'initiator'; });
      initiators.forEach(function(c, i){
        positions[c.id] = { x: W - 80, y: 80 + i * 50 };
      });
      // Agents: bottom row
      var agents = snap.nodes.filter(function(n){ return n.type === 'agent'; });
      var agentY = H - 90;
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
        if (!pk) { positions[s.id] = { x: W/2, y: H/2 }; return; }
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
      // Default for any missed nodes
      snap.nodes.forEach(function(n){
        if (!positions[n.id]) positions[n.id] = { x: W/2, y: H/2 };
      });
    }
    return positions;
  }

  // ---- RENDER ----------------------------------------------------------
  function render(snap) {
    nodesG.innerHTML = '';
    edgesG.innerHTML = '';
    if (!snap.nodes.length) {
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
      // Keep only nodes touched by active edges (or root + containment ancestors)
      renderEdges.forEach(function(e){ keepNodes.add(e.from); keepNodes.add(e.to); });
      if (snap.root) keepNodes.add(snap.root);
    }
    var renderNodes = activeOnly ? snap.nodes.filter(function(n){ return keepNodes.has(n.id); }) : snap.nodes;

    var pos = layout({ nodes: renderNodes, edges: renderEdges, root: snap.root });

    // ---- Boundary boxes (clients + projects in "All" mode) ----
    if (!snap.root) {
      renderNodes.forEach(function(n){
        var p = pos[n.id];
        if (n.type === 'client' && p && p._bbox) {
          var rect = svgEl('rect', { x: p._bbox.x, y: p._bbox.y, width: p._bbox.w, height: p._bbox.h, class: 'ax-node-client' });
          edgesG.appendChild(rect); // behind nodes
          var lbl = svgEl('text', { x: p._bbox.x + 12, y: p._bbox.y + 22, class: 'ax-node-client--label' }, n.label);
          edgesG.appendChild(lbl);
        }
        if (n.type === 'project' && p && p._bbox) {
          var rect2 = svgEl('rect', { x: p._bbox.x, y: p._bbox.y, width: p._bbox.w, height: p._bbox.h, class: 'ax-node-project' });
          edgesG.appendChild(rect2);
          var lbl2 = svgEl('text', { x: p._bbox.x + 8, y: p._bbox.y + 14, class: 'ax-node-project--label' }, n.label);
          edgesG.appendChild(lbl2);
        }
      });
    }

    // ---- Edges (beziers) ----
    renderEdges.forEach(function(e){
      // Skip containment edges in "All" mode (the boundary boxes already convey it visually)
      if (!snap.root && e.kind === 'contains') return;
      var from = pos[e.from], to = pos[e.to];
      if (!from || !to) return;
      var dx = to.x - from.x, dy = to.y - from.y;
      // Bezier control point — perpendicular offset for curvature
      var cx = (from.x + to.x) / 2 + (dy * 0.18);
      var cy = (from.y + to.y) / 2 - (dx * 0.18);
      var d = 'M' + from.x + ',' + from.y + ' Q' + cx + ',' + cy + ' ' + to.x + ',' + to.y;
      var marker = (e.kind === 'dispatches') ? 'arrow-dispatch' : (e.kind === 'a2a') ? 'arrow-a2a' : (e.kind === 'resolves') ? 'arrow-resolve' : null;
      var pathAttrs = {
        d: d,
        class: 'ax-edge ax-edge--' + e.kind + (e.active ? ' is-active' : ''),
        'data-edge': e.id,
      };
      if (marker) pathAttrs['marker-end'] = 'url(#' + marker + ')';
      var path = svgEl('path', pathAttrs);
      path.addEventListener('mouseenter', function(ev){ showEdgeTip(e, ev); });
      path.addEventListener('mousemove', function(ev){ moveTip(ev); });
      path.addEventListener('mouseleave', hideTip);
      edgesG.appendChild(path);
    });

    // ---- Nodes ----
    renderNodes.forEach(function(n){
      var p = pos[n.id];
      if (!p) return;
      // Skip rendering visual on client/project in "All" mode (already drawn as bbox)
      if (!snap.root && (n.type === 'client' || n.type === 'project')) return;
      var g = svgEl('g', { class: 'ax-node-group' + (n.id === snap.root ? ' is-root' : ''), 'data-node': n.id, transform: 'translate(' + p.x + ',' + p.y + ')' });
      drawNode(g, n);
      g.addEventListener('mouseenter', function(ev){ showNodeTip(n, ev); });
      g.addEventListener('mousemove', function(ev){ moveTip(ev); });
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', function(){ pushPerspective(n); });
      nodesG.appendChild(g);
    });

    stamp.textContent = renderNodes.length + ' nodes · ' + renderEdges.length + ' edges · ' + new Date(snap.ts).toLocaleTimeString();
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
    fetchAndRender();
  }
  function popTo(idx) {
    stack = stack.slice(0, idx);
    renderCrumbs();
    fetchAndRender();
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

  // ---- FETCH -----------------------------------------------------------
  async function fetchAndRender() {
    var hours = winSelect.value;
    var root = stack.length ? stack[stack.length - 1].root : '';
    var qs = '?hours=' + encodeURIComponent(hours) + (root ? '&root=' + encodeURIComponent(root) : '');
    try {
      var r = await fetch('/api/admin/activity-graph' + qs, { credentials: 'same-origin' });
      var data = await r.json();
      snapshot = data;
      render(snapshot);
    } catch (e) { console.error('graph fetch failed', e); }
  }

  document.getElementById('ax-graph-refresh').addEventListener('click', fetchAndRender);
  winSelect.addEventListener('change', fetchAndRender);
  activeOnlyChk.addEventListener('change', function(){ if (snapshot) render(snapshot); });

  fetchAndRender();
})();
`
