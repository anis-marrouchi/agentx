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
<aside id="history-panel" class="history-panel hidden" aria-hidden="true">
  <header>
    <h2 id="history-panel-title">${esc(UI_LABELS.historyPanelTitle)}</h2>
    <span class="history-panel-source" id="history-panel-source"></span>
    <button class="history-panel-close" id="history-panel-close" aria-label="Close">×</button>
  </header>
  <div id="history-panel-body" class="history-panel-body"></div>
</aside>
<div id="task-modal" class="task-modal hidden" aria-hidden="true">
  <div class="task-modal-backdrop"></div>
  <div class="task-modal-card" role="dialog" aria-modal="true">
    <header>
      <span class="task-modal-channel" id="task-modal-channel"></span>
      <h2 id="task-modal-title">${esc(UI_LABELS.taskModalTitle)}</h2>
      <span class="task-modal-status" id="task-modal-status">${esc(UI_LABELS.taskModalConnecting)}</span>
      <button class="task-modal-close" id="task-modal-close" aria-label="Close">×</button>
    </header>
    <div id="task-modal-output" class="task-modal-output"></div>
  </div>
</div>`

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
.ax-agent__stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ax-ministat {
  padding: 8px 10px; background: var(--ax-bg);
  border: 1px solid var(--ax-border); border-radius: 4px;
}
.ax-ministat__label {
  display: flex; align-items: center; gap: 4px; font-size: 10px;
  color: var(--ax-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.ax-ministat__value {
  font-size: 18px; font-weight: 600; margin-top: 2px;
  letter-spacing: -0.02em; font-family: var(--ax-mono);
  font-variant-numeric: tabular-nums;
}
.ax-ministat--live .ax-ministat__value { color: var(--ax-accent); }
.ax-ministat--warn .ax-ministat__value { color: var(--ax-warn); }
.ax-ministat--err .ax-ministat__value { color: var(--ax-err); }
.ax-agent__spark {
  border-top: 1px dashed var(--ax-border); padding-top: 8px;
  color: var(--ax-accent);
}
.ax-agent__spark-caption {
  display: flex; justify-content: space-between; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ax-muted); margin-top: 2px;
}
.ax-agent__spark svg { display: block; width: 100%; height: 28px; }
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
.history-panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
  background: var(--node); border-left: 1px solid var(--border); z-index: 900;
  display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0,0,0,0.4);
  transition: transform 0.2s ease;
}
.history-panel.hidden { transform: translateX(100%); pointer-events: none; }
.history-panel > header {
  display: flex; align-items: center; gap: 10px; padding: 12px 14px;
  background: var(--ax-bg-elev); border-bottom: 1px solid var(--border);
}
.history-panel > header h2 { margin: 0; font-size: 13px; font-weight: 600; flex: 1; color: var(--text); }
.history-panel-source { font-size: 10px; color: var(--muted); font-family: ui-monospace, monospace; }
.history-panel-close {
  background: transparent; border: none; color: var(--muted); font-size: 20px;
  cursor: pointer; padding: 0 6px; line-height: 1;
}
.history-panel-close:hover { color: var(--text); }
.history-panel-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.history-item {
  background: var(--card); border: 1px solid var(--border); border-radius: 6px;
  padding: 9px 11px; cursor: pointer; display: flex; flex-direction: column; gap: 4px;
}
.history-item:hover { border-color: var(--accent); }
.history-item .top { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--muted); }
.history-item .top .channel {
  background: color-mix(in oklch, var(--ax-accent) 16%, transparent); color: var(--accent);
  font-size: 9px; text-transform: uppercase; padding: 1px 6px; border-radius: 3px;
  letter-spacing: 0.5px;
}
.history-item .top .ok { color: var(--green); }
.history-item .top .err { color: var(--red); }
.history-item .top .when { margin-left: auto; font-family: ui-monospace, monospace; }
.history-item .preview { color: var(--text); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-item .duration { font-size: 10px; color: var(--muted); font-family: ui-monospace, monospace; }
.history-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 20px 8px; font-style: italic; }

/* --- Task modal (full transcript view) --- */
.task-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; }
.task-modal.hidden { display: none; }
.task-modal-backdrop { position: absolute; inset: 0; background: color-mix(in oklch, var(--ax-bg) 60%, black); }
.task-modal-card {
  position: relative; width: min(900px, 92vw); height: min(640px, 86vh);
  background: var(--ax-surface); border: 1px solid var(--ax-border-2); border-radius: 8px;
  display: flex; flex-direction: column; box-shadow: 0 18px 48px rgba(0,0,0,0.5); overflow: hidden;
}
.task-modal-card > header {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--ax-border); background: var(--ax-bg-elev);
}
.task-modal-card > header h2 {
  margin: 0; font-size: 14px; font-weight: 600; flex: 1;
  color: var(--ax-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  letter-spacing: -0.005em;
}
.task-modal-channel {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
  background: color-mix(in oklch, var(--ax-accent) 14%, transparent); color: var(--ax-accent);
  padding: 2px 7px; border-radius: 3px; font-family: var(--ax-mono);
}
.task-modal-status { font-size: 11px; color: var(--ax-muted); font-family: var(--ax-mono); }
.task-modal-status.live { color: var(--ax-accent); }
.task-modal-status.done { color: var(--ax-accent); opacity: 0.75; }
.task-modal-status.err { color: var(--ax-err); }
.task-modal-close {
  background: transparent; border: none; color: var(--ax-muted); font-size: 22px;
  cursor: pointer; padding: 0 6px; line-height: 1;
}
.task-modal-close:hover { color: var(--ax-text); }

/* --- Event timeline (inside task modal) --- */
.task-modal-output {
  margin: 0; flex: 1; overflow: auto; padding: 16px 20px;
  background: var(--ax-bg); display: flex; flex-direction: column; gap: 14px;
}
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
  let tasks = 0, durationMs = 0, errors = 0, inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
  const byChannel = {};
  for (const node of snapshot.nodes) {
    if (!node.usage || !node.usage.agents) continue;
    for (const agentId of Object.keys(node.usage.agents)) {
      const u = node.usage.agents[agentId];
      tasks += u.tasks || 0;
      durationMs += u.totalDuration || 0;
      errors += u.errors || 0;
      inputTokens += u.inputTokens || 0;
      outputTokens += u.outputTokens || 0;
      cacheRead += u.cacheReadTokens || 0;
      cacheCreate += u.cacheCreateTokens || 0;
      if (u.byChannel) for (const ch of Object.keys(u.byChannel)) {
        byChannel[ch] = (byChannel[ch] || 0) + (u.byChannel[ch].tasks || 0);
      }
    }
  }
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreate;
  const topChannels = Object.keys(byChannel).sort((a, b) => byChannel[b] - byChannel[a]).slice(0, 3)
    .map(ch => ch + ' (' + byChannel[ch] + ')').join(' · ');

  strip.innerHTML =
    stat({ label: 'agents online', value: summary.reachable + '/' + summary.nodes + ' machines',
           sub: summary.agents + ' agents', variant: 'live', pulse: summary.reachable > 0 }) +
    stat({ label: 'running now', value: summary.busy,
           sub: summary.busy === 0 ? 'nothing active' : 'across ' + Object.keys(byChannel).length + ' channels',
           variant: summary.busy > 0 ? 'live' : '' }) +
    stat({ label: 'tasks today', value: tasks, sub: topChannels || 'no activity yet' }) +
    stat({ label: 'tokens today', value: fmtTokens(totalTokens),
           sub: fmtDuration(durationMs) + ' of agent time' }) +
    stat({ label: L.errorsCount || 'failed', value: errors + summary.errors,
           sub: (errors + summary.errors) === 0 ? 'all clean' : 'check history',
           variant: (errors + summary.errors) > 0 ? 'err' : '' });
}

function stat({ label, value, sub, variant, pulse }) {
  const cls = 'ax-stat' + (variant ? ' ax-stat--' + variant : '');
  const dot = pulse ? '<span class="ax-dot ax-dot--live ax-dot--pulse"></span>' : '';
  return '<div class="' + cls + '">' +
    '<div class="ax-stat__label">' + dot + escapeHtml(String(label)) + '</div>' +
    '<div class="ax-stat__value">' + escapeHtml(String(value)) + '</div>' +
    (sub ? '<div class="ax-stat__sub">' + escapeHtml(String(sub)) + '</div>' : '') +
  '</div>';
}

function fmtDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h ' + (rm < 10 ? '0' : '') + rm + 'm';
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(2).replace(/\\.00$/, '') + 'M';
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

  // Sparkline — last 24 hourly task counts
  const sparkBlock = (Array.isArray(a.hourlyTasks) && a.hourlyTasks.length)
    ? '<div class="ax-agent__spark">' + renderSpark(a.hourlyTasks) +
        '<div class="ax-agent__spark-caption"><span>tasks · last 24h</span><span class="ax-mono">' +
          a.hourlyTasks.reduce(function(s,v){return s+v}, 0) + ' total</span></div>' +
      '</div>'
    : '';

  // Mini stats row
  const miniStats = '<div class="ax-agent__stats">' +
    '<div class="ax-ministat' + (busy ? ' ax-ministat--live' : '') + '">' +
      '<div class="ax-ministat__label">handling</div>' +
      '<div class="ax-ministat__value">' + (a.active || 0) + '</div>' +
    '</div>' +
    '<div class="ax-ministat">' +
      '<div class="ax-ministat__label">today</div>' +
      '<div class="ax-ministat__value">' + (a.total || 0) + '</div>' +
    '</div>' +
    '<div class="ax-ministat' + (errored ? ' ax-ministat--err' : '') + '">' +
      '<div class="ax-ministat__label">failed</div>' +
      '<div class="ax-ministat__value">' + (a.errors || 0) + '</div>' +
    '</div>' +
  '</div>';

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

  card.innerHTML =
    '<div class="ax-agent__head">' +
      '<div class="ax-agent__id">' +
        '<span class="ax-mention">' + escapeHtml(mention) + '</span>' +
        '<span class="ax-agent__name">' + escapeHtml(a.name || a.id) + '</span>' +
      '</div>' +
      '<div class="ax-agent__tier">' + tierBadge + liveBadge + '</div>' +
    '</div>' +
    (a.model ? '<div class="ax-agent__model">' + escapeHtml(shortenModel(a.model)) + '</div>' : '') +
    miniStats +
    sparkBlock +
    runningBlock +
    summaryBlock +
    '<div class="ax-agent__foot"' + lastActiveAttr + '><span class="last-active">' + escapeHtml(lastActiveText) + '</span>' + recentLink + '</div>';
  return card;
}

/** Inline SVG sparkline — polyline + dot on the last point. 100% width, 28px high. */
function renderSpark(data) {
  const w = 280, h = 28;
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

// --- Task output modal ---
// Per-modal parser state so consecutive chunks coalesce cleanly.
const taskModal = {
  el: document.getElementById('task-modal'),
  output: document.getElementById('task-modal-output'),
  title: document.getElementById('task-modal-title'),
  status: document.getElementById('task-modal-status'),
  channel: document.getElementById('task-modal-channel'),
  closeBtn: document.getElementById('task-modal-close'),
  backdrop: null,
  es: null,
  currentTaskId: null,
  /** Trailing line fragment from the last chunk (completes on next newline). */
  lineBuf: '',
  /** Active text event DOM node — consecutive plain-text lines coalesce into it. */
  openTextEv: null,
};
taskModal.backdrop = taskModal.el && taskModal.el.querySelector('.task-modal-backdrop');

function setStatus(label, kind) {
  if (!taskModal.status) return;
  taskModal.status.textContent = label;
  taskModal.status.className = 'task-modal-status' + (kind ? ' ' + kind : '');
}

function resetOutput() {
  if (!taskModal.output) return;
  taskModal.output.innerHTML = '';
  taskModal.lineBuf = '';
  taskModal.openTextEv = null;
}

/**
 * Feed a raw transcript chunk to the event renderer. Handles partial lines
 * (buffered until the next newline) and coalesces bare text lines into a
 * single "assistant text" event until a structured marker arrives.
 *
 * Prefixes emitted by the backend formatter (src/agents/registry.ts):
 *   '· '        system (init, done)
 *   '→ '        tool_use
 *   '← '        tool_result   (or '← [error] ' for is_error)
 *   '💭 '       thinking / thought block
 *   anything    assistant text
 */
function appendOutput(text) {
  if (!text || !taskModal.output) return;
  const atBottom = taskModal.output.scrollTop + taskModal.output.clientHeight >= taskModal.output.scrollHeight - 30;
  taskModal.lineBuf += text;
  const lines = taskModal.lineBuf.split('\\n');
  taskModal.lineBuf = lines.pop();
  for (const line of lines) processStreamLine(line);
  if (atBottom) taskModal.output.scrollTop = taskModal.output.scrollHeight;
}

/** Flush any trailing partial line left in lineBuf. Called at the end of an
 *  archived-task render so transcripts that don't end with a newline still
 *  surface their last line. */
function flushOutput() {
  if (!taskModal.output) return;
  if (taskModal.lineBuf && taskModal.lineBuf.length) {
    processStreamLine(taskModal.lineBuf);
    taskModal.lineBuf = '';
  }
}

function processStreamLine(line) {
  if (line.startsWith('· ')) { closeOpenText(); renderSystemEvent(line.slice(2)); return; }
  if (line.startsWith('→ ')) { closeOpenText(); renderToolUseEvent(line.slice(2)); return; }
  if (line.startsWith('← ')) { closeOpenText(); renderToolResultEvent(line.slice(2)); return; }
  if (line.startsWith('💭 ')) { closeOpenText(); renderThoughtEvent(line.slice(2)); return; }
  if (line.startsWith('[error] ')) { closeOpenText(); renderErrorEvent(line.slice(8)); return; }
  if (line.startsWith('[task finished]')) { closeOpenText(); renderSystemEvent('task finished', true); return; }
  if (line === '') {
    // Blank line = paragraph break in assistant text. Keep the block open but
    // insert a blank line so long replies stay readable.
    if (taskModal.openTextEv) {
      const body = taskModal.openTextEv.querySelector('.ax-ev__text');
      if (body) body.appendChild(document.createTextNode('\\n\\n'));
    }
    return;
  }
  appendToOpenText(line);
}

function closeOpenText() { taskModal.openTextEv = null; }

function appendToOpenText(line) {
  if (!taskModal.openTextEv) {
    const ev = document.createElement('div');
    ev.className = 'ax-ev ax-ev--text';
    ev.innerHTML = '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--text">response</span></div><div class="ax-ev__text"></div>';
    taskModal.output.appendChild(ev);
    taskModal.openTextEv = ev;
  }
  const body = taskModal.openTextEv.querySelector('.ax-ev__text');
  if (body.childNodes.length > 0) body.appendChild(document.createTextNode('\\n'));
  body.appendChild(document.createTextNode(line));
}

function renderSystemEvent(text, done) {
  const ev = document.createElement('div');
  ev.className = 'ax-ev ax-ev--system' + (done ? ' is-done' : '');
  ev.innerHTML = '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--soft">system</span>' +
    '<span>' + escapeHtml(text) + '</span></div>';
  taskModal.output.appendChild(ev);
}

function renderToolUseEvent(text) {
  // text looks like 'ToolName({...input...})' — best-effort split on the first paren.
  const openIdx = text.indexOf('(');
  const closeIdx = text.lastIndexOf(')');
  const name = openIdx > 0 ? text.slice(0, openIdx) : text;
  const args = (openIdx > 0 && closeIdx > openIdx) ? text.slice(openIdx + 1, closeIdx) : '';
  const ev = document.createElement('div');
  ev.className = 'ax-ev ax-ev--tool';
  const head =
    '<div class="ax-ev__head">' +
      '<span class="ax-ev__label ax-ev__label--tool">tool call</span>' +
      '<span class="ax-ev__tool">' + escapeHtml(name) + '</span>' +
    '</div>';
  const body = args ? '<pre class="ax-ev__code">' + escapeHtml(args) + '</pre>' : '';
  ev.innerHTML = head + body;
  taskModal.output.appendChild(ev);
}

function renderToolResultEvent(text) {
  const isErr = text.startsWith('[error] ');
  const body = isErr ? text.slice('[error] '.length) : text;
  const ev = document.createElement('div');
  ev.className = 'ax-ev ax-ev--tool-result' + (isErr ? ' is-err' : '');
  ev.innerHTML =
    '<div class="ax-ev__head">' +
      '<span class="ax-ev__label ax-ev__label--result">' + (isErr ? 'tool error' : 'tool result') + '</span>' +
    '</div>' +
    '<pre class="ax-ev__code ' + (isErr ? 'ax-ev__code--err' : 'ax-ev__code--muted') + '">' + escapeHtml(body) + '</pre>';
  taskModal.output.appendChild(ev);
}

function renderThoughtEvent(text) {
  const ev = document.createElement('div');
  ev.className = 'ax-ev ax-ev--thought';
  ev.innerHTML =
    '<div class="ax-ev__head">' +
      '<span class="ax-ev__label ax-ev__label--soft">internal</span>' +
    '</div>' +
    '<div class="ax-ev__thought">' + escapeHtml(text) + '</div>';
  taskModal.output.appendChild(ev);
}

function renderErrorEvent(text) {
  const ev = document.createElement('div');
  ev.className = 'ax-ev ax-ev--error';
  ev.innerHTML =
    '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--error">error</span></div>' +
    '<pre class="ax-ev__code ax-ev__code--err">' + escapeHtml(text) + '</pre>';
  taskModal.output.appendChild(ev);
}

function closeTaskModal() {
  if (!taskModal.el) return;
  taskModal.el.classList.add('hidden');
  taskModal.el.setAttribute('aria-hidden', 'true');
  if (taskModal.es) { try { taskModal.es.close(); } catch {} taskModal.es = null; }
  taskModal.currentTaskId = null;
}

function openTaskModal(opts) {
  if (!taskModal.el || !opts.taskId || !opts.nodeUrl) return;
  if (taskModal.currentTaskId === opts.taskId) { taskModal.el.classList.remove('hidden'); return; }
  const L = window.UI_LABELS || {};
  closeTaskModal();
  taskModal.currentTaskId = opts.taskId;
  taskModal.el.classList.remove('hidden');
  taskModal.el.setAttribute('aria-hidden', 'false');
  taskModal.title.textContent = opts.agentName + ' · ' + (opts.preview || 'task ' + opts.taskId);
  taskModal.title.title = opts.preview || '';
  taskModal.channel.textContent = opts.channel || '—';
  resetOutput();
  setStatus(L.taskModalConnecting || 'connecting…', '');
  const url = '/api/task/stream?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId)
    + '&task=' + encodeURIComponent(opts.taskId);
  let es;
  try { es = new EventSource(url); } catch (e) { setStatus('connect failed', 'err'); return; }
  taskModal.es = es;
  es.addEventListener('start', (ev) => {
    setStatus(L.taskModalLive || 'live', 'live');
    try { const data = JSON.parse(ev.data); if (data.initial) appendOutput(data.initial); if (data.done) setStatus(L.taskModalFinished || 'finished', 'done'); } catch {}
  });
  es.addEventListener('chunk', (ev) => {
    try { const data = JSON.parse(ev.data); appendOutput(data.text || ''); } catch {}
  });
  es.addEventListener('end', () => {
    setStatus(L.taskModalFinished || 'finished', 'done');
    try { es.close(); } catch {}
    taskModal.es = null;
    flushOutput();
  });
  es.addEventListener('error', () => {
    if (es.readyState === 2) {
      setStatus('disconnected', 'err');
      taskModal.es = null;
    }
  });
}

if (taskModal.closeBtn) taskModal.closeBtn.addEventListener('click', closeTaskModal);
if (taskModal.backdrop) taskModal.backdrop.addEventListener('click', closeTaskModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && taskModal.el && !taskModal.el.classList.contains('hidden')) closeTaskModal(); });

// --- History panel ---
const historyPanel = {
  el: document.getElementById('history-panel'),
  body: document.getElementById('history-panel-body'),
  title: document.getElementById('history-panel-title'),
  source: document.getElementById('history-panel-source'),
  closeBtn: document.getElementById('history-panel-close'),
  current: null,
};

function closeHistoryPanel() {
  if (!historyPanel.el) return;
  historyPanel.el.classList.add('hidden');
  historyPanel.el.setAttribute('aria-hidden', 'true');
  historyPanel.current = null;
}

async function openHistoryPanel(opts) {
  if (!historyPanel.el) return;
  const L = window.UI_LABELS || {};
  historyPanel.current = { agentId: opts.agentId, nodeUrl: opts.nodeUrl };
  historyPanel.title.textContent = (opts.agentName || opts.agentId) + ' · ' + (L.historyPanelTitle || 'Recent activities');
  historyPanel.source.textContent = opts.nodeUrl;
  historyPanel.body.innerHTML = '<div class="history-empty">' + escapeHtml(L.historyLoading || 'loading…') + '</div>';
  historyPanel.el.classList.remove('hidden');
  historyPanel.el.setAttribute('aria-hidden', 'false');
  const url = '/api/task/history?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId) + '&limit=50';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = await r.json();
    renderHistoryList(items, opts);
  } catch (e) {
    historyPanel.body.innerHTML = '<div class="history-empty" style="color:var(--red)">' + escapeHtml(e.message) + '</div>';
  }
}

function renderHistoryList(items, opts) {
  const L = window.UI_LABELS || {};
  if (!Array.isArray(items) || items.length === 0) {
    historyPanel.body.innerHTML = '<div class="history-empty">' + escapeHtml(L.historyEmpty || 'No recorded tasks yet.') + '</div>';
    return;
  }
  historyPanel.body.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.dataset.taskId = it.id;
    const flag = it.ok ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
    const dur = it.durationMs ? fmtElapsed(it.durationMs) : '—';
    const when = it.endedAt ? fmtAgoShort(it.endedAt) : '';
    const channel = '<span class="channel">' + escapeHtml(it.channel || '—') + '</span>';
    const sender = it.sender ? ' · ' + escapeHtml(it.sender) : '';
    div.innerHTML =
      '<div class="top">' + flag + channel + sender + '<span class="when">' + escapeHtml(when) + '</span></div>' +
      '<div class="preview">' + escapeHtml((it.message || '').slice(0, 200)) + '</div>' +
      '<div class="duration">' + escapeHtml(dur) + (it.error ? ' · ' + escapeHtml(it.error.slice(0, 80)) : '') + '</div>';
    div.addEventListener('click', () => openTaskRecord({
      taskId: it.id, agentId: opts.agentId, nodeUrl: opts.nodeUrl,
      channel: it.channel, agentName: opts.agentName,
      preview: it.message || '',
    }));
    historyPanel.body.appendChild(div);
  }
}

function fmtAgoShort(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// Open the task modal in "history" mode — fetch the stored record once,
// dump the transcript + final response, no SSE.
async function openTaskRecord(opts) {
  if (!taskModal.el) return;
  const L = window.UI_LABELS || {};
  closeTaskModal();
  taskModal.currentTaskId = opts.taskId;
  taskModal.el.classList.remove('hidden');
  taskModal.el.setAttribute('aria-hidden', 'false');
  taskModal.title.textContent = (opts.agentName || opts.agentId) + ' · ' + (opts.preview || 'task ' + opts.taskId);
  taskModal.title.title = opts.preview || '';
  taskModal.channel.textContent = opts.channel || '—';
  resetOutput();
  setStatus(L.historyLoading || 'loading…', '');
  const url = '/api/task/history?node=' + encodeURIComponent(opts.nodeUrl)
    + '&agent=' + encodeURIComponent(opts.agentId) + '&task=' + encodeURIComponent(opts.taskId);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rec = await r.json();
    setStatus(rec.ok ? (L.taskModalArchived || 'archived') : (L.taskModalFinished || 'failed'), rec.ok ? 'done' : 'err');
    const tx = rec.transcript || '';
    if (tx) appendOutput(tx);
    // Only append the "Final reply" block if the transcript didn't already
    // carry it. Guard against a missing transcript (indexOf would throw).
    if (rec.responseText && (!tx || tx.indexOf(rec.responseText) === -1)) {
      appendOutput('\\n\\n--- ' + (L.taskModalFinalResponse || 'Final reply') + ' ---\\n' + rec.responseText);
    }
    if (rec.error) appendOutput('\\n\\n[error] ' + rec.error);
    flushOutput();
    // If the record returned nothing renderable, show an explicit empty
    // state so the modal doesn't look broken.
    if (!taskModal.output.children.length) {
      taskModal.output.innerHTML =
        '<div class="ax-ev ax-ev--system">' +
          '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--soft">empty</span>' +
          '<span>This task has no recorded transcript. It may have finished before history capture kicked in, or the archive file was pruned.</span></div>' +
        '</div>';
    }
  } catch (e) {
    setStatus(L.taskModalLoadFailed || "couldn't load", 'err');
    appendOutput('Error: ' + e.message);
    flushOutput();
  }
}

if (historyPanel.closeBtn) historyPanel.closeBtn.addEventListener('click', closeHistoryPanel);

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
      // Update = append a new message to the same chat session. The agent
      // finishes its current turn, then processes this as the next turn
      // (same model as sending a message to an ongoing Claude session).
      // No framing, no truncation — just the operator's message as-is.
      // To kill the current run separately, use Stop.
      const msg = prompt('Message to send to the agent (will be processed after the current turn finishes):');
      if (!msg || !msg.trim()) return;
      taskAction(nodeUrl, taskId, 'followup', { message: msg.trim(), sender: 'dashboard' });
    }
    return;
  }
  const taskEl = e.target.closest('.ax-agent__task[data-task-id]');
  if (taskEl) {
    e.preventDefault();
    openTaskModal({
      taskId: taskEl.dataset.taskId,
      agentId: taskEl.dataset.agentId,
      nodeUrl: taskEl.dataset.nodeUrl,
      channel: taskEl.dataset.channel,
      agentName: taskEl.dataset.agentName || taskEl.dataset.agentId,
      preview: taskEl.getAttribute('title') || taskEl.textContent || '',
    });
    return;
  }
  const recentEl = e.target.closest('[data-recent]');
  if (recentEl) {
    e.preventDefault();
    openHistoryPanel({
      agentId: recentEl.dataset.agentId,
      agentName: recentEl.dataset.agentName,
      nodeUrl: recentEl.dataset.nodeUrl,
    });
  }
});

function taskAction(nodeUrl, taskId, kind, body) {
  // Browser → dashboard origin → originating daemon. Mirrors the proxy
  // pattern used by openTaskModal / openHistoryPanel — node identifies
  // which daemon owns the task; the dashboard validates against its
  // allowlist and forwards with the configured operator token.
  if (!nodeUrl) {
    alert('Task ' + kind + ' failed: no daemon URL on this task');
    return;
  }
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
      if (!r.ok) throw new Error(txt || ('HTTP ' + r.status));
      console.log('[task ' + kind + ']', txt);
    })
    .catch(err => alert('Task ' + kind + ' failed: ' + (err && err.message || err)));
}

`
