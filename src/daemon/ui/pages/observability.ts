import { renderShell, type TopbarPeer } from ".."

// --- /admin/observability page ---
//
// Three tables that were write-only-from-the-CLI before this page existed:
//   - Routing (route_traces): why each inbound message went to which agent.
//     Critical for "why didn't agent X pick up this message?" debugging.
//   - Rotations: stale / tier-2 / max-turns session rotations per agent.
//     Pairs with the usage dashboard's tier-2 hotspot view.
//   - Errors: task_history rows where status='error' with truncated stack.
//
// Read-only. Filters are client-side; backing API is /api/admin/observability/*.

export interface ObservabilityPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderObservabilityPage(opts: ObservabilityPageOpts = {}): string {
  const body = `<div class="ax-obs">
  <header class="ax-obs__head">
    <h1>Observability</h1>
    <p class="ax-obs__sub">Routing decisions · session rotations · agent errors. Read-only — sourced from <code>.agentx/db.sqlite</code>.</p>
    <nav class="ax-obs__tabs" role="tablist">
      <button class="ax-obs__tab is-active" data-tab="routing" role="tab">Routing</button>
      <button class="ax-obs__tab" data-tab="rotations" role="tab">Rotations</button>
      <button class="ax-obs__tab" data-tab="errors" role="tab">Errors</button>
    </nav>
    <div class="ax-obs__filters">
      <label>Limit
        <input id="obs-limit" type="number" min="1" max="500" value="50" />
      </label>
      <label>Agent
        <input id="obs-agent" type="text" placeholder="filter by agent id" />
      </label>
      <button id="obs-refresh" type="button">Refresh</button>
    </div>
  </header>

  <section class="ax-obs__pane is-active" data-pane="routing">
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>at</th><th>channel</th><th>chat_id</th><th>kind</th><th>stage</th><th>agent</th><th>reason</th></tr></thead>
      <tbody id="obs-routing"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-routing-empty" hidden>(no rows)</p>
  </section>

  <section class="ax-obs__pane" data-pane="rotations">
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>at</th><th>agent</th><th>channel</th><th>reason</th><th>last turn input tokens</th></tr></thead>
      <tbody id="obs-rotations"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-rotations-empty" hidden>(no rows)</p>
  </section>

  <section class="ax-obs__pane" data-pane="errors">
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>at</th><th>agent</th><th>channel</th><th>message</th><th>error</th></tr></thead>
      <tbody id="obs-errors"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-errors-empty" hidden>(no rows)</p>
  </section>
</div>`

  return renderShell({
    title: "AgentX · Observability",
    activeTab: "observability",
    subtitle: "Observability",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: OBS_PAGE_CSS,
    scripts: `<script>${OBS_PAGE_SCRIPT}</script>`,
  })
}

const OBS_PAGE_CSS = `
.ax-obs { padding: 16px 24px; }
.ax-obs__head { margin-bottom: 16px; }
.ax-obs__head h1 { margin: 0 0 4px; font-size: 18px; }
.ax-obs__sub { color: var(--ax-muted); font-size: 13px; margin: 0 0 12px; }
.ax-obs__sub code { font-size: 12px; padding: 1px 5px; background: var(--ax-surface-2); border-radius: 4px; }
.ax-obs__tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--ax-border); margin-bottom: 12px; }
.ax-obs__tab {
  background: transparent; border: 0; padding: 8px 14px; cursor: pointer;
  font: inherit; color: var(--ax-muted); border-bottom: 2px solid transparent;
}
.ax-obs__tab:hover { color: var(--ax-fg); }
.ax-obs__tab.is-active { color: var(--ax-fg); border-bottom-color: var(--ax-accent, #3a7bd5); }
.ax-obs__filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; padding: 8px 0; }
.ax-obs__filters label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--ax-muted); }
.ax-obs__filters input {
  font: inherit; padding: 6px 8px; border: 1px solid var(--ax-border);
  border-radius: 6px; background: var(--ax-bg); color: var(--ax-fg); width: 160px;
}
.ax-obs__filters input[type="number"] { width: 80px; }
.ax-obs__filters button {
  padding: 6px 14px; border: 1px solid var(--ax-border); background: var(--ax-bg);
  color: var(--ax-fg); border-radius: 6px; cursor: pointer; font: inherit;
}
.ax-obs__filters button:hover { background: var(--ax-surface-2); }
.ax-obs__pane { display: none; }
.ax-obs__pane.is-active { display: block; }
.ax-obs__table-wrap { overflow-x: auto; max-height: calc(100vh - 250px); overflow-y: auto; border: 1px solid var(--ax-border); border-radius: 6px; }
.ax-obs__table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ax-obs__table thead th {
  position: sticky; top: 0; background: var(--ax-bg); padding: 8px 10px;
  text-align: left; border-bottom: 1px solid var(--ax-border);
  font-weight: 600; font-size: 11px; color: var(--ax-muted); text-transform: uppercase; letter-spacing: 0.04em;
}
.ax-obs__table td { padding: 6px 10px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.ax-obs__table tr:hover td { background: var(--ax-surface-2); }
.ax-obs__table .num { text-align: right; font-variant-numeric: tabular-nums; }
.ax-obs__table .small { color: var(--ax-muted); font-size: 11px; }
.ax-obs__pill {
  display: inline-block; padding: 1px 7px; border-radius: 10px;
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  background: var(--ax-surface-2); color: var(--ax-fg);
}
.ax-obs__pill--match { background: rgba(46, 160, 67, 0.15); color: #2da44e; }
.ax-obs__pill--drop { background: rgba(207, 34, 46, 0.15); color: #cf222e; }
.ax-obs__pill--tier-2 { background: rgba(218, 119, 6, 0.15); color: #bf8700; }
.ax-obs__pill--stale { background: rgba(99, 110, 123, 0.15); color: #57606a; }
.ax-obs__pill--max-turns { background: rgba(99, 110, 123, 0.15); color: #57606a; }
.ax-obs__empty { color: var(--ax-muted); font-style: italic; padding: 18px 0; }
`

const OBS_PAGE_SCRIPT = `
(function(){
  var panes = document.querySelectorAll('.ax-obs__pane');
  var tabs = document.querySelectorAll('.ax-obs__tab');
  var current = 'routing';

  tabs.forEach(function(t){
    t.addEventListener('click', function(){
      tabs.forEach(function(x){ x.classList.toggle('is-active', x === t); });
      panes.forEach(function(p){ p.classList.toggle('is-active', p.dataset.pane === t.dataset.tab); });
      current = t.dataset.tab;
      load(current);
    });
  });

  function fmtTs(s){
    if (!s) return '';
    return String(s).replace('T', ' ').replace('Z', '').slice(0, 19);
  }
  function esc(s){
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c){
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  async function load(tab){
    var limit = document.getElementById('obs-limit').value || 50;
    var agent = document.getElementById('obs-agent').value || '';
    var qs = '?limit=' + encodeURIComponent(limit) + (agent ? '&agent=' + encodeURIComponent(agent) : '');

    try {
      var r = await fetch('/api/admin/observability/' + tab + qs, { credentials: 'same-origin' });
      var data = await r.json();
      render(tab, data);
    } catch (e) {
      console.error('observability fetch failed', e);
    }
  }

  function render(tab, data){
    var body = document.getElementById('obs-' + tab);
    var empty = document.getElementById('obs-' + tab + '-empty');
    var rows = (data && data.rows) || [];
    if (!rows.length) {
      body.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    if (tab === 'routing') {
      body.innerHTML = rows.map(function(r){
        return '<tr>'
          + '<td>' + fmtTs(r.at) + '</td>'
          + '<td>' + esc(r.channel) + '</td>'
          + '<td class="small">' + esc(r.chat_id) + (r.account_id ? ' / ' + esc(r.account_id) : '') + '</td>'
          + '<td><span class="ax-obs__pill ax-obs__pill--' + esc(r.kind) + '">' + esc(r.kind || '?') + '</span></td>'
          + '<td>' + esc(r.deciding_stage) + '</td>'
          + '<td>' + esc(r.agent_id || '-') + '</td>'
          + '<td class="small">' + esc(r.reason || '') + '</td>'
          + '</tr>';
      }).join('');
    } else if (tab === 'rotations') {
      body.innerHTML = rows.map(function(r){
        return '<tr>'
          + '<td>' + fmtTs(r.rotated_at) + '</td>'
          + '<td>' + esc(r.agent_id) + '</td>'
          + '<td>' + esc(r.channel) + '</td>'
          + '<td><span class="ax-obs__pill ax-obs__pill--' + esc(r.reason) + '">' + esc(r.reason) + '</span></td>'
          + '<td class="num">' + (r.last_turn_input_tokens != null ? r.last_turn_input_tokens : '-') + '</td>'
          + '</tr>';
      }).join('');
    } else if (tab === 'errors') {
      body.innerHTML = rows.map(function(r){
        var preview = (r.message_preview || '').slice(0, 80);
        var error = (r.error || '').slice(0, 240);
        return '<tr>'
          + '<td>' + fmtTs(r.started_at) + '</td>'
          + '<td>' + esc(r.agent_id) + '</td>'
          + '<td>' + esc(r.channel) + '</td>'
          + '<td class="small">' + esc(preview) + '</td>'
          + '<td class="small" style="color:#cf222e">' + esc(error) + '</td>'
          + '</tr>';
      }).join('');
    }
  }

  document.getElementById('obs-refresh').addEventListener('click', function(){ load(current); });
  document.getElementById('obs-limit').addEventListener('change', function(){ load(current); });
  document.getElementById('obs-agent').addEventListener('change', function(){ load(current); });

  load(current);
})();
`
