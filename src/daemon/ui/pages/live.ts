// --- Live dashboard page ---
//
// Real-time view of every reachable daemon's agents. The HTML here is a
// skeleton; everything interesting is painted by LIVE_PAGE_SCRIPT after an
// SSE snapshot lands from /api/live/stream.
//
// Ownership split vs the old board-dashboard.ts monolith:
//   ui/tokens.ts         — :root / theme tokens (was at the top of LIVE_CSS)
//   ui/components.css.ts — .ax-dot, .ax-badge, .ax-statstrip, .ax-chip,
//                          .ax-card (was also at the top of LIVE_CSS)
//   topbar.ts            — .ax-topbar, .ax-theme-switch, .ax-mesh-sel
//   HERE                 — layout + agent cards + history panel + task modal
//
// That's ~300 lines of CSS reclaimed from LIVE_CSS onto shared modules.

import { renderShell, esc, type TopbarPeer } from ".."
import { UI_LABELS } from "../../ui-labels"

export interface LivePageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderLivePage(opts: LivePageOpts = {}): string {
  const labelsScript = `<script>window.UI_LABELS = ${JSON.stringify(UI_LABELS)};</script>`
  const rightExtras = `<span id="ts" class="ax-mono" title="Last update">—</span>
    <span id="conn-dot" class="ax-dot ax-dot--ok ax-dot--pulse" title="connected"></span>
    <span id="conn-label">live</span>`

  const body = `<div class="ax-app-live">
  <section id="statstrip" class="ax-statstrip"></section>
  <main id="grid" class="ax-live__body"></main>
</div>
`

  return renderShell({
    title: `${UI_LABELS.brand} · ${UI_LABELS.subtitle}`,
    activeTab: "live",
    subtitle: UI_LABELS.subtitle,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    // Paste rightExtras manually since renderShell doesn't forward them to
    // renderTopbar — the Live page is the only one that uses them (ticking
    // timestamp + connection dot), not worth a config knob.
    customHeader: undefined,  // let shell emit the standard topbar
    noMain: true,
    body,
    css: LIVE_PAGE_CSS,
    scripts: labelsScript + `<script>${LIVE_PAGE_SCRIPT}</script>`,
    headExtras: `<script>
      // rightExtras for the topbar are injected at runtime — they reference
      // IDs (#ts, #conn-dot) that the script below addresses directly.
      document.addEventListener('DOMContentLoaded', () => {
        const right = document.querySelector('.ax-topbar__right');
        if (!right) return;
        const extras = document.createElement('div');
        extras.style.cssText = 'display:flex;gap:10px;align-items:center;font-size:var(--ax-fs-xs);color:var(--ax-muted)';
        extras.innerHTML = ${JSON.stringify(rightExtras)};
        right.insertBefore(extras, right.firstChild);
      });
    </script>`,
  })
}

/** CSS specific to the Live page. Tokens + .ax-badge/.ax-dot/.ax-statstrip/
 *  .ax-chip/.ax-card / topbar all live in shared modules — this file owns
 *  only layout (app flex column, node sections, agent grid) + the agent
 *  card internals + history panel + task modal + event timeline. */
const LIVE_PAGE_CSS = `
/* --- Page frame --- */
.ax-app-live { min-height: 100vh; display: flex; flex-direction: column; }

/* --- Live body (list of node sections) --- */
.ax-live__body { display: flex; flex-direction: column; gap: var(--ax-gap); padding: var(--ax-pad); }
.ax-node {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 8px; overflow: hidden;
}
.ax-node > header {
  background: transparent; padding: 12px 16px;
  border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; gap: 10px;
}
.ax-node__name { font-weight: 600; font-size: 14px; }
.ax-node__url { color: var(--ax-muted); font-family: var(--ax-mono); font-size: 11px; }
.ax-node__tag {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  padding: 2px 7px; border-radius: 3px; border: 1px solid var(--ax-border-2);
  color: var(--ax-text-2); font-family: var(--ax-mono);
}
.ax-node__tag--up { color: var(--ax-accent); border-color: color-mix(in oklch, var(--ax-accent) 50%, transparent); }
.ax-node__tag--down { color: var(--ax-err); border-color: color-mix(in oklch, var(--ax-err) 50%, transparent); }
.ax-grid--agents {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--ax-gap); padding: 12px 14px;
}

/* --- Agent cards --- */
.ax-agent {
  display: flex; flex-direction: column; gap: 10px;
  transition: border-color 200ms ease, box-shadow 200ms ease, background 200ms ease;
}
/* Idle agents are context, not content: tighter padding, muted, no shadow.
   A working agent should be visibly heavier than a resting one. */
.ax-agent.is-collapsed {
  gap: 6px; padding: 12px 14px; box-shadow: none;
  background: var(--ax-surface-2); opacity: 0.78;
}
.ax-agent.is-collapsed:hover { opacity: 1; }
.ax-agent.is-collapsed .ax-agent__foot { border-top: none; padding-top: 0; }
.ax-agent__spark { color: var(--ax-accent); }
.ax-agent__spark svg { display: block; width: 100%; height: 22px; }
.ax-agent__spark-caption {
  display: flex; justify-content: space-between; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--ax-muted); margin-top: 1px;
}
.ax-agent.is-collapsed .ax-agent__spark { opacity: 0.75; }

/* Active agents inside the "running now" tile — each row opens that
   conversation. */
.ax-stat__running { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.ax-stat__running-row { display: block; text-decoration: none; color: inherit; border-radius: 8px; padding: 3px 6px; margin: 0 -6px; }
.ax-stat__running-row:hover { background: var(--ax-surface-2); text-decoration: none; }
.ax-stat__running-line { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); min-width: 0; }
.ax-stat__running-ch { color: var(--ax-muted); text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; }
.ax-stat__running-el { margin-left: auto; color: var(--ax-muted); }
.ax-agent.is-handling {
  border-color: color-mix(in oklch, var(--ax-accent) 75%, var(--ax-border));
  background: linear-gradient(180deg,
    color-mix(in oklch, var(--ax-accent) 6%, var(--ax-surface)) 0%,
    var(--ax-surface) 38%);
  animation: ax-agent-breathe 2.2s ease-in-out infinite;
}
.ax-agent.is-errored {
  border-color: color-mix(in oklch, var(--ax-err) 55%, var(--ax-border));
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--ax-err) 25%, transparent);
}
@keyframes ax-agent-breathe {
  0%, 100% {
    box-shadow:
      0 0 0 1px color-mix(in oklch, var(--ax-accent) 45%, transparent),
      0 0 20px -6px color-mix(in oklch, var(--ax-accent) 30%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 1px color-mix(in oklch, var(--ax-accent) 70%, transparent),
      0 0 32px -2px color-mix(in oklch, var(--ax-accent) 55%, transparent);
  }
}
.ax-agent__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ax-agent__id { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
.ax-mention {
  color: var(--ax-accent); font-size: 15px; font-weight: 500;
  font-family: var(--ax-mono); letter-spacing: -0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ax-agent__name {
  font-size: var(--ax-fs-sm); color: var(--ax-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ax-agent__tier { display: flex; gap: 4px; flex-shrink: 0; }
.ax-agent__model {
  font-size: var(--ax-fs-xs); color: var(--ax-muted);
  font-family: var(--ax-mono); margin-top: -4px;
}
.ax-agent__running { display: flex; flex-direction: column; gap: 6px; }
.ax-agent__task {
  text-align: left; background: var(--ax-bg);
  border: 1px solid color-mix(in oklch, var(--ax-accent) 30%, var(--ax-border));
  padding: 8px 10px; border-radius: 4px; cursor: pointer;
  font: inherit; color: var(--ax-text);
}
.ax-agent__task:hover { border-color: var(--ax-accent); }
.ax-agent__task-head {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--ax-fs-xs); color: var(--ax-accent);
}
.ax-agent__task-head .elapsed { margin-left: auto; font-family: var(--ax-mono); color: var(--ax-muted); }
.ax-agent__task-body {
  font-size: var(--ax-fs-sm); margin-top: 4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; line-height: 1.35;
}
.ax-agent__task-actions {
  display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;
}
.ax-task-action {
  font: inherit; font-size: 11px; line-height: 1;
  padding: 4px 8px; border-radius: 3px; cursor: pointer;
  border: 1px solid var(--ax-border); background: transparent; color: var(--ax-muted);
}
.ax-task-action:hover { border-color: var(--ax-accent); color: var(--ax-text); }
.ax-task-action--stop:hover { border-color: #d33; color: #d33; }
.ax-agent__summary { border-top: 1px dashed var(--ax-border); padding-top: 8px; }
.ax-agent__summary-caption {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ax-muted);
}
.ax-agent__summary-text {
  font-size: var(--ax-fs-sm); color: var(--ax-text-2);
  line-height: 1.45; margin-top: 4px; text-wrap: pretty;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.ax-agent__summary.is-fail .ax-agent__summary-caption { color: var(--ax-err); }
.ax-agent__foot {
  display: flex; justify-content: space-between; align-items: center;
  font-size: var(--ax-fs-xs); color: var(--ax-muted);
  border-top: 1px solid var(--ax-border); padding-top: 8px;
}
.ax-linkbtn {
  background: transparent; border: none; color: var(--ax-text-2);
  padding: 2px 6px; font: inherit; cursor: pointer;
  font-size: var(--ax-fs-sm); text-decoration: none;
}
.ax-linkbtn:hover { color: var(--ax-accent); }

.ax-empty {
  padding: 32px 10px; text-align: center; color: var(--ax-muted);
  font-size: var(--ax-fs-sm); border: 1px dashed var(--ax-border);
  border-radius: 4px; margin: 12px 14px;
}

/* --- History panel (right-docked sheet) --- */
.ax-ev { border-left: 2px solid var(--ax-border-2); padding: 2px 0 2px 12px; }
.ax-ev--tool { border-color: var(--ax-info); }
.ax-ev--tool-result { border-color: var(--ax-border-2); }
.ax-ev--tool-result.is-err { border-color: var(--ax-err); }
.ax-ev--thought { border-color: var(--ax-muted); }
.ax-ev--text { border-color: var(--ax-accent); }
.ax-ev--system {
  border-color: var(--ax-border-2); color: var(--ax-muted); font-size: var(--ax-fs-xs);
  font-family: var(--ax-mono); padding-top: 4px; padding-bottom: 4px;
}
.ax-ev--system.is-done { border-color: var(--ax-accent); }
.ax-ev--error { border-color: var(--ax-err); }
.ax-ev__head { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.ax-ev__label { text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; font-family: var(--ax-mono); }
.ax-ev__label--soft { color: var(--ax-muted); }
.ax-ev__label--tool { color: var(--ax-info); }
.ax-ev__label--result { color: var(--ax-muted); }
.ax-ev__label--text { color: var(--ax-accent); }
.ax-ev__label--error { color: var(--ax-err); }
.ax-ev__time { margin-left: auto; font-family: var(--ax-mono); color: var(--ax-muted); }
.ax-ev__tool { font-family: var(--ax-mono); color: var(--ax-info); font-size: var(--ax-fs-xs); }
.ax-ev__code {
  margin: 4px 0 0; padding: 8px 10px; background: var(--ax-bg-elev);
  border: 1px solid var(--ax-border); border-radius: 3px; font-family: var(--ax-mono);
  font-size: var(--ax-fs-xs); white-space: pre-wrap; word-break: break-word;
  line-height: 1.5; color: var(--ax-text-2); max-height: 200px; overflow: auto;
}
.ax-ev__code--muted { color: var(--ax-muted); }
.ax-ev__code--err { color: var(--ax-err); border-color: color-mix(in oklch, var(--ax-err) 35%, var(--ax-border)); }
.ax-ev__thought {
  margin-top: 4px; color: var(--ax-text-2); font-style: italic;
  font-size: var(--ax-fs-sm); line-height: 1.55; text-wrap: pretty;
}
.ax-ev__text {
  margin-top: 4px; color: var(--ax-text); font-size: var(--ax-fs-sm);
  line-height: 1.55; text-wrap: pretty; white-space: pre-wrap; word-break: break-word;
}
.ax-ev--thinking {
  display: flex; align-items: center; gap: 8px; padding: 8px 0 0 12px;
  color: var(--ax-muted); font-size: var(--ax-fs-sm);
}
.ax-ev__spinner {
  width: 10px; height: 10px; border: 1.5px solid var(--ax-border-2);
  border-top-color: var(--ax-accent); border-radius: 50%;
  animation: ax-spin 800ms linear infinite; display: inline-block;
}
@keyframes ax-spin { to { transform: rotate(360deg); } }`

/** Live-page client script — SSE snapshot handler, agent card renderer,
 *  task modal + history panel. 650-ish lines of straight JS; moving it
 *  here doesn't change it. */
const LIVE_PAGE_SCRIPT = `
'use strict';

const ui = { nodes: new Map(), summary: { nodes: 0, agents: 0, busy: 0, errors: 0 } };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtElapsed(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); const rs = s % 60;
  if (m < 60) return m + 'm ' + (rs < 10 ? '0' : '') + rs + 's';
  const h = Math.floor(m / 60); const rm = m % 60;
  return h + 'h ' + (rm < 10 ? '0' : '') + rm + 'm';
}

function render(snapshot) {
  const grid = document.getElementById('grid');
  const nowTs = new Date(snapshot.ts).toLocaleTimeString();
  document.getElementById('ts').textContent = nowTs;
  const summary = { nodes: snapshot.nodes.length, reachable: 0, agents: 0, busy: 0, errors: 0 };
  grid.innerHTML = '';
  for (const node of snapshot.nodes) {
    if (node.reachable) summary.reachable++;
    summary.agents += node.agents.length;
    for (const a of node.agents) {
      const busy = (a.runningTasks && a.runningTasks.length > 0) || (a.active || 0) > 0;
      if (busy) summary.busy++;
      summary.errors += (a.errors || 0);
    }
    grid.appendChild(renderNode(node));
  }
  const L = window.UI_LABELS || {};
  renderStatStrip(snapshot, summary);
  // The connection dot in the topbar gets pulsed only when tasks are running.
  const connDot = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');
  if (connDot) connDot.classList.toggle('ax-dot--pulse', summary.busy > 0);
  if (connLabel) connLabel.textContent = summary.busy > 0 ? 'running ' + summary.busy : 'idle';
}

/**
 * Paint the stat strip: agents online, running tasks, tasks today, tokens, errors.
 * The legacy "today-strip" logic is absorbed here — same underlying data.
 */
function renderStatStrip(snapshot, summary) {
  const strip = document.getElementById('statstrip');
  if (!strip) return;
  const L = window.UI_LABELS || {};
  // Only what the two tiles need: the error count, and which channels are
  // carrying the currently-running work. Token and duration totals moved out
  // with the cost tiles.
  let errors = 0;
  const byChannel = {};
  for (const node of snapshot.nodes) {
    if (!node.usage || !node.usage.agents) continue;
    for (const agentId of Object.keys(node.usage.agents)) {
      const u = node.usage.agents[agentId];
      errors += u.errors || 0;
      if (u.byChannel) for (const ch of Object.keys(u.byChannel)) {
        byChannel[ch] = (byChannel[ch] || 0) + (u.byChannel[ch].tasks || 0);
      }
    }
  }

  // Two tiles, because this page answers one question: who is alive, and what
  // are they doing right now. "tasks today" and "tokens today" answer a cost
  // question that /admin/cost owns; "failed" answers a health question that
  // /admin/health owns. Five tiles made the page look like a status report
  // and buried the two numbers someone opening Live actually came for.
  const failing = errors + summary.errors;
  const runningRows = collectRunning(snapshot);
  strip.innerHTML =
    stat({ label: 'agents online', value: summary.reachable + '/' + summary.nodes + ' machines',
           sub: summary.agents + ' agents', variant: 'live', pulse: summary.reachable > 0 }) +
    // The busy COUNT and the running-task LIST come from different parts of
    // the snapshot and can lag each other by a poll: an agent flips to active
    // before its task appears, and the task disappears before the count drops.
    // Without a fallback the tile then renders a number and nothing else,
    // which reads as broken. Never let this tile be blank.
    stat({ label: 'running now', value: summary.busy,
           sub: runningRows.length ? '' :
                (summary.busy > 0 ? 'starting…' : 'nothing active'),
           bodyHtml: runningRows.length ? runningBodyHtml(runningRows) : '',
           variant: summary.busy > 0 ? 'live' : '' }) +
    // Failures are the one exception: they earn a tile only when non-zero,
    // because a silent failure is the thing you most need pulled forward.
    (failing > 0
      ? stat({ label: L.errorsCount || 'failed', value: failing,
               sub: 'see health →', variant: 'err' })
      : '');
}

function stat({ label, value, sub, variant, pulse, bodyHtml }) {
  const cls = 'ax-stat' + (variant ? ' ax-stat--' + variant : '');
  const dot = pulse ? '<span class="ax-dot ax-dot--live ax-dot--pulse"></span>' : '';
  return '<div class="' + cls + '">' +
    '<div class="ax-stat__label">' + dot + escapeHtml(String(label)) + '</div>' +
    '<div class="ax-stat__value">' + escapeHtml(String(value)) + '</div>' +
    (bodyHtml || (sub ? '<div class="ax-stat__sub">' + escapeHtml(String(sub)) + '</div>' : '')) +
  '</div>';
}

/** The "running now" tile, when something IS running, lists who — each a link
 *  straight into that conversation.
 *
 *  A count alone made you hunt: read "2", then scan 31 cards for the two that
 *  are lit. The tile already knows which agents they are, so it should hand
 *  them over. This is the page's one shortcut — everything else is a roster. */
function collectRunning(snapshot) {
  const rows = [];
  for (const node of (snapshot && snapshot.nodes) || []) {
    for (const a of (node.agents || [])) {
      for (const t of (a.runningTasks || [])) {
        rows.push({
          agentId: a.id,
          agentName: a.name || a.id,
          nodeUrl: (node && node.url) || '',
          taskId: t.id,
          channel: t.channel || '',
          preview: t.messagePreview || '',
          startedAt: t.startedAt,
        });
      }
    }
  }
  return rows;
}

function runningBodyHtml(rows) {
  if (!rows.length) return '';
  return '<div class="ax-stat__running">' + rows.slice(0, 4).map(function (r) {
    const href = r.taskId ? taskPageUrl(r) : '';  // r carries preview + startedAt
    const elapsed = r.startedAt ? fmtElapsed(Date.now() - new Date(r.startedAt).getTime()) : '';
    const inner =
      '<span class="ax-mention">@' + escapeHtml(r.agentId) + '</span>' +
      (r.channel ? '<span class="ax-stat__running-ch">' + escapeHtml(r.channel) + '</span>' : '') +
      '<span class="ax-stat__running-el ax-mono">' + escapeHtml(elapsed) + '</span>';
    const line = '<div class="ax-stat__running-line" title="' + escapeHtml(r.preview) + '">' + inner + '</div>';
    return href ? '<a class="ax-stat__running-row" href="' + escapeHtml(href) + '">' + line + '</a>'
                : '<div class="ax-stat__running-row">' + line + '</div>';
  }).join('') +
  (rows.length > 4 ? '<div class="ax-stat__sub">+' + (rows.length - 4) + ' more</div>' : '') +
  '</div>';
}



function renderNode(node) {
  const sec = document.createElement('section');
  sec.className = 'ax-node';
  const tag = node.reachable
    ? '<span class="ax-node__tag ax-node__tag--up">online · ' + (node.uptimeSec ? Math.round(node.uptimeSec / 60) + 'm' : '—') + '</span>'
    : '<span class="ax-node__tag ax-node__tag--down">offline — ' + escapeHtml(node.error || 'unreachable') + '</span>';
  sec.innerHTML = '<header>' +
    '<span class="ax-node__name">' + escapeHtml(node.name) + '</span>' +
    '<span class="ax-node__url">' + escapeHtml(node.url) + '</span>' +
    tag + '</header><div class="ax-grid--agents"></div>';
  const g = sec.querySelector('.ax-grid--agents');
  if (!node.reachable || node.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ax-empty';
    const L = window.UI_LABELS || {};
    empty.textContent = node.reachable ? (L.noAgentsOnNode || 'No agents on this node.') : (L.unreachable || 'Unreachable.');
    g.appendChild(empty);
  } else {
    for (const a of node.agents) g.appendChild(renderAgent(a, node));
  }
  return sec;
}

function renderAgent(a, node) {
  const card = document.createElement('div');
  const busy = (a.runningTasks && a.runningTasks.length > 0) || (a.active || 0) > 0;
  // Error border reflects the MOST RECENT task's status, not the cumulative
  // error count. A red border drops the moment a new task succeeds — it should
  // not persist forever because of a failure an hour ago. The cumulative
  // a.errors count stays visible in the "failed" ministat below as an
  // informational value.
  const errored = a.lastSummary && a.lastSummary.ok === false;
  card.className = 'ax-card ax-agent' + (busy ? ' is-handling' : '') + (errored ? ' is-errored' : '');
  const nodeUrl = (node && node.url) || '';
  const L = window.UI_LABELS || {};
  const tierLabels = (L.tierLabels) || {};
  const tierDisplay = tierLabels[a.tier] || a.tier || '';

  // Running task card (clickable → opens live stream modal). Wrapper is a
  // <div role="button"> so we can nest the Stop / Update action buttons
  // inside (button-in-button is invalid HTML); click handler is delegated
  // via the .ax-agent__task class.
  const taskHtml = (a.runningTasks || []).map(t => {
    const elapsed = fmtElapsed(Date.now() - new Date(t.startedAt).getTime());
    const dataAttrs = t.id
      ? ' data-task-id="' + escapeHtml(t.id) + '" data-agent-id="' + escapeHtml(a.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '" data-channel="' + escapeHtml(t.channel || '') + '" data-agent-name="' + escapeHtml(a.name || a.id) + '"'
      : '';
    const actions = t.id
      ? '<div class="ax-agent__task-actions">' +
          '<button type="button" class="ax-task-action ax-task-action--update" data-action="followup" data-task-id="' + escapeHtml(t.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '" title="Add a message to this chat — the current turn keeps running, your message dispatches as the next turn">✎ update</button>' +
          '<button type="button" class="ax-task-action ax-task-action--stop" data-action="cancel" data-task-id="' + escapeHtml(t.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '" title="Stop this running task">✕ stop</button>' +
        '</div>'
      : '';
    return '<div class="ax-agent__task" role="button" tabindex="0"' + dataAttrs + ' data-started-at="' + escapeHtml(t.startedAt || '') + '" title="' + escapeHtml(t.messagePreview || '') + '">' +
      '<div class="ax-agent__task-head">' +
        '<span class="ax-dot ax-dot--live ax-dot--pulse"></span>' +
        '<span>running · ' + escapeHtml(t.channel || '') + '</span>' +
        '<span class="elapsed">' + elapsed + '</span>' +
      '</div>' +
      '<div class="ax-agent__task-body">' + escapeHtml(t.messagePreview || '(no preview)') + '</div>' +
      actions +
    '</div>';
  }).join('');
  const runningBlock = taskHtml
    ? '<div class="ax-agent__running">' + taskHtml + '</div>'
    : (busy ? '<div class="ax-agent__running"><div class="ax-agent__task"><div class="ax-agent__task-head"><span class="ax-dot ax-dot--live ax-dot--pulse"></span>' + escapeHtml(L.runningNoPreview || 'working · preparing reply') + '</div></div></div>' : '');

  // Last-reply summary (shown when idle)
  const summaryBlock = (!busy && a.lastSummary && a.lastSummary.text)
    ? '<div class="ax-agent__summary' + (a.lastSummary.ok === false ? ' is-fail' : '') + '">' +
        '<div class="ax-agent__summary-caption">last reply' + (a.lastSummary.at ? ' · ' + escapeHtml(fmtAgo(a.lastSummary.at)) : '') + '</div>' +
        '<div class="ax-agent__summary-text" title="' + escapeHtml(a.lastSummary.text) + '">' + escapeHtml(a.lastSummary.text) + '</div>' +
      '</div>'
    : (busy ? '' : '<div class="ax-agent__summary"><div class="ax-agent__summary-caption">' + escapeHtml(L.idle || 'idle') + '</div><div class="ax-agent__summary-text" style="font-style:italic;color:var(--ax-muted)">' + escapeHtml(L.neverRan || 'awaiting first task') + '</div></div>');

  const lastActiveText = a.lastActive ? 'last active ' + fmtAgo(a.lastActive) : (L.neverRan || 'not used yet');
  const lastActiveAttr = a.lastActive ? ' data-last-active="' + escapeHtml(a.lastActive) + '"' : '';
  const recentLink = nodeUrl
    ? '<button class="ax-linkbtn" data-agent-id="' + escapeHtml(a.id) + '" data-agent-name="' + escapeHtml(a.name || a.id) + '" data-node-url="' + escapeHtml(nodeUrl) + '" data-recent="1">history →</button>'
    : '';

  // Head: mention (trigger) + human name + tier badge + live/idle badge
  const mention = (a.mentions && a.mentions.length) ? '@' + a.mentions[0].replace(/^@/, '') : '@' + a.id;
  const liveBadge = busy
    ? '<span class="ax-badge ax-badge--mono ax-badge--live"><span class="ax-dot ax-dot--live ax-dot--pulse"></span> live</span>'
    : (errored ? '<span class="ax-badge ax-badge--mono ax-badge--warn">errored</span>' : '<span class="ax-badge ax-badge--mono ax-badge--ghost">idle</span>');
  const tierBadge = tierDisplay ? '<span class="ax-badge ax-badge--mono ax-badge--ghost" title="AI engine">' + escapeHtml(tierDisplay) + '</span>' : '';

  const head =
    '<div class="ax-agent__head">' +
      '<div class="ax-agent__id">' +
        '<span class="ax-mention">' + escapeHtml(mention) + '</span>' +
        '<span class="ax-agent__name">' + escapeHtml(a.name || a.id) + '</span>' +
      '</div>' +
      '<div class="ax-agent__tier">' + tierBadge + liveBadge + '</div>' +
    '</div>';

  // An idle agent collapses to one line.
  //
  // The page's job is "who is alive and what are they doing RIGHT NOW". Giving
  // an idle agent the same real estate as a working one — model, last-reply
  // excerpt, footer — is exactly backwards: it makes the answer harder to see
  // the more agents you run. On clawd (22 agents) the busy ones were lost in a
  // wall of identical idle cards.
  //
  // Collapsed still carries what the question needs: who, engine, and when it
  // was last active. Everything else is one click away in history.
  if (!busy) {
    card.className += ' is-collapsed';
    card.innerHTML = head + sparkBlockFor(a) +
      '<div class="ax-agent__foot"' + lastActiveAttr + '><span class="last-active">' +
        escapeHtml(lastActiveText) + '</span>' + recentLink + '</div>';
    return card;
  }

  card.innerHTML =
    head +
    (a.model ? '<div class="ax-agent__model">' + escapeHtml(shortenModel(a.model)) + '</div>' : '') +
    sparkBlockFor(a) +
    runningBlock +
    summaryBlock +
    '<div class="ax-agent__foot"' + lastActiveAttr + '><span class="last-active">' + escapeHtml(lastActiveText) + '</span>' + recentLink + '</div>';
  return card;
}

/** Inline SVG sparkline of the last 24 hourly task counts.
 *
 *  This came out with the per-agent stat boxes and shouldn't have. The stat
 *  boxes were three numbers restating what the row already said; the chart is
 *  the one thing on the card that carries information nothing else does — the
 *  SHAPE of an agent's day. A flat line beside a busy one is a real signal,
 *  and it costs 22px. */
function renderSpark(data) {
  const w = 280, h = 22;
  const max = Math.max.apply(null, data.concat([1]));
  const step = w / Math.max(data.length - 1, 1);
  let pts = '';
  for (let i = 0; i < data.length; i++) {
    const x = (i * step).toFixed(1);
    const y = (h - (data[i] / max) * (h - 4) - 2).toFixed(1);
    pts += (i ? ' ' : '') + x + ',' + y;
  }
  const lastX = ((data.length - 1) * step).toFixed(1);
  const lastY = (h - (data[data.length - 1] / max) * (h - 4) - 2).toFixed(1);
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />' +
    '<circle cx="' + lastX + '" cy="' + lastY + '" r="2" fill="currentColor" />' +
  '</svg>';
}

function sparkBlockFor(a) {
  if (!Array.isArray(a.hourlyTasks) || !a.hourlyTasks.length) return '';
  const total = a.hourlyTasks.reduce(function (s, v) { return s + v; }, 0);
  if (!total) return '';
  return '<div class="ax-agent__spark">' + renderSpark(a.hourlyTasks) +
    '<div class="ax-agent__spark-caption"><span>last 24h</span>' +
    '<span class="ax-mono">' + total + '</span></div></div>';
}

function shortenModel(m) {
  if (!m) return '';
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\\d{8}$/, '')
    .replace(/\\[1m\\]$/, ' · 1M');
}

function fmtAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); return d + 'd ago';
}

function connect() {
  // #conn exists on the Kanban page; the Live page only has #conn-dot/#conn-label
  // in the topbar. Guard it or the snapshot handler throws before render runs,
  // which silently freezes the live grid between page reloads.
  const conn = document.getElementById('conn');
  let es;
  const open = () => {
    try { es = new EventSource('/api/live/stream'); } catch (e) { setTimeout(open, 2000); return; }
    es.addEventListener('snapshot', (ev) => {
      if (conn) { conn.className = 'conn ok'; conn.title = 'connected'; }
      try { render(JSON.parse(ev.data)); } catch (e) { console.error('live render failed', e); }
    });
    es.addEventListener('error', () => {
      if (conn) { conn.className = 'conn err'; conn.title = 'reconnecting…'; }
      es.close(); setTimeout(open, 2000);
    });
  };
  open();
}

// Tick elapsed / last-active counters every second from DOM data attributes,
// so they advance smoothly between 2s server snapshots instead of jumping.
let lastSnap = null;
fetch('/api/live').then(r => r.json()).then(s => { lastSnap = s; render(s); }).catch(() => {});
setInterval(() => {
  const now = Date.now();
  // Running-task elapsed counters.
  document.querySelectorAll('.ax-agent__task[data-started-at]').forEach((btn) => {
    const startedAt = btn.getAttribute('data-started-at');
    if (!startedAt) return;
    const t = new Date(startedAt).getTime();
    if (!t) return;
    const el = btn.querySelector('.elapsed');
    if (el) el.textContent = fmtElapsed(now - t);
  });
  // Idle-card "last active" text — smooths from "5s ago" to "6s ago".
  document.querySelectorAll('.ax-agent__foot[data-last-active]').forEach((foot) => {
    const iso = foot.getAttribute('data-last-active');
    if (!iso) return;
    const el = foot.querySelector('.last-active');
    if (el) el.textContent = 'last active ' + fmtAgo(iso);
  });
}, 1000);
connect();

/** Navigate to a task's own page. Watching an agent work is a place — it gets
 *  a URL you can share, reload and keep open beside other things. */
function taskPageUrl(d) {
  // Carry the request preview across. A LIVE task's SSE stream only sends the
  // agent's output — the daemon never replays what was asked — so without this
  // the request card stays hidden for exactly the tasks you're most likely to
  // be watching. Capped so a long GitLab comment can't blow the URL.
  const ask = (d.preview || '').slice(0, 400);
  return '/tasks/' + encodeURIComponent(d.taskId)
    + '?agent=' + encodeURIComponent(d.agentId || '')
    + '&node=' + encodeURIComponent(d.nodeUrl || '')
    + (d.channel ? '&channel=' + encodeURIComponent(d.channel) : '')
    + (d.agentName ? '&name=' + encodeURIComponent(d.agentName) : '')
    + (ask ? '&ask=' + encodeURIComponent(ask) : '')
    + (d.startedAt ? '&at=' + encodeURIComponent(d.startedAt) : '');
}

// Click delegation on the agent grid — opens the modal for any task card,
// or the history panel for the "history →" link. Task action buttons
// (stop / update) are intercepted FIRST so they don't bubble into the
// modal-open path.
document.getElementById('grid').addEventListener('click', (e) => {
  const actionEl = e.target.closest('.ax-task-action[data-action]');
  if (actionEl) {
    e.preventDefault();
    e.stopPropagation();
    const action = actionEl.dataset.action;
    const taskId = actionEl.dataset.taskId;
    const nodeUrl = actionEl.dataset.nodeUrl || '';
    if (!taskId) return;
    if (action === 'cancel') {
      if (!confirm('Stop this running task?')) return;
      taskAction(nodeUrl, taskId, 'cancel', {});
    } else if (action === 'followup') {
      // Both actions land on the task's page, which hosts the compose box
      // and the Stop control alongside the live stream.
      const card = actionEl.closest('.ax-agent__task[data-task-id]');
      location.href = taskPageUrl({
        taskId,
        agentId: card && card.dataset.agentId,
        nodeUrl,
        channel: card && card.dataset.channel,
        agentName: (card && (card.dataset.agentName || card.dataset.agentId)) || '',
      });
    }
    return;
  }
  const taskEl = e.target.closest('.ax-agent__task[data-task-id]');
  if (taskEl) {
    e.preventDefault();
    location.href = taskPageUrl({
      taskId: taskEl.dataset.taskId,
      agentId: taskEl.dataset.agentId,
      nodeUrl: taskEl.dataset.nodeUrl,
      channel: taskEl.dataset.channel,
      agentName: taskEl.dataset.agentName || taskEl.dataset.agentId,
      preview: taskEl.getAttribute('title') || '',
      startedAt: taskEl.dataset.startedAt,
    });
    return;
  }
  const recentEl = e.target.closest('[data-recent]');
  if (recentEl) {
    e.preventDefault();
    location.href = '/agents/' + encodeURIComponent(recentEl.dataset.agentId || '')
      + '/history?node=' + encodeURIComponent(recentEl.dataset.nodeUrl || '')
      + '&name=' + encodeURIComponent(recentEl.dataset.agentName || '');
  }
});

function taskAction(nodeUrl, taskId, kind, body, hooks) {
  // Browser → dashboard origin → originating daemon. Mirrors the proxy
  // pattern used by openTaskModal / openHistoryPanel.
  hooks = hooks || {};
  if (!nodeUrl) {
    const msg = 'no daemon URL on this task';
    if (hooks.onErr) hooks.onErr(msg); else alert('Task ' + kind + ' failed: ' + msg);
    return;
  }
  if (hooks.onStart) hooks.onStart();
  const url = '/api/task/action?node=' + encodeURIComponent(nodeUrl)
    + '&task=' + encodeURIComponent(taskId)
    + '&kind=' + encodeURIComponent(kind);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
    .then(async r => {
      const txt = await r.text();
      let parsed = null; try { parsed = JSON.parse(txt); } catch {}
      if (!r.ok) throw new Error((parsed && parsed.error) || txt || ('HTTP ' + r.status));
      console.log('[task ' + kind + ']', parsed || txt);
      if (hooks.onOk) hooks.onOk(parsed);
    })
    .catch(err => {
      const msg = err && err.message || String(err);
      if (hooks.onErr) hooks.onErr(msg); else alert('Task ' + kind + ' failed: ' + msg);
    });
}

`
