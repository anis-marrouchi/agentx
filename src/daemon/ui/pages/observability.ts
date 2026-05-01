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
    <h1>Health</h1>
    <p class="ax-obs__sub">Platform-health view: what each agent ran, what failed, and how the router decided. <span class="ax-obs__sub-link">Spend lives on the <a href="/admin/cost">Cost</a> page.</span></p>
    <nav class="ax-obs__tabs" role="tablist">
      <button class="ax-obs__tab is-active" data-tab="overview" role="tab">Overview</button>
      <button class="ax-obs__tab" data-tab="activity" role="tab">Activity</button>
      <button class="ax-obs__tab" data-tab="errors" role="tab">Errors</button>
      <button class="ax-obs__tab" data-tab="routing" role="tab">Routing</button>
      <button class="ax-obs__tab" data-tab="rotations" role="tab">Rotations</button>
    </nav>
    <div class="ax-obs__filters" id="obs-filters">
      <label>Agent
        <input id="obs-agent" type="text" placeholder="filter by agent id" />
      </label>
      <label class="js-tech-only">Limit
        <input id="obs-limit" type="number" min="1" max="500" value="50" />
      </label>
      <button id="obs-refresh" type="button">Refresh</button>
    </div>
  </header>

  <section class="ax-obs__pane is-active" data-pane="overview">
    <div class="ax-obs__kpis" id="obs-overview-kpis"></div>
    <div class="ax-obs__split">
      <div class="ax-obs__card">
        <h3>Top agents today</h3>
        <table class="ax-obs__table">
          <thead><tr><th>Agent</th><th class="num">Tasks</th><th class="num">Errors</th><th class="num">Avg time</th><th>Last active</th></tr></thead>
          <tbody id="obs-overview-agents"></tbody>
        </table>
        <p class="ax-obs__empty" id="obs-overview-agents-empty" hidden>No tasks yet today.</p>
      </div>
      <div class="ax-obs__card">
        <h3>Channels today</h3>
        <table class="ax-obs__table">
          <thead><tr><th>Channel</th><th class="num">Tasks</th><th class="num">Errors</th></tr></thead>
          <tbody id="obs-overview-channels"></tbody>
        </table>
        <p class="ax-obs__empty" id="obs-overview-channels-empty" hidden>No traffic yet today.</p>
      </div>
    </div>
    <div class="ax-obs__card">
      <h3>Idle agents <span class="ax-obs__hint">(no activity in the last 24h)</span></h3>
      <p id="obs-overview-idle" class="ax-obs__idle"></p>
    </div>
    <div class="ax-obs__card">
      <h3>Recent failures (last 24h) <span class="ax-obs__hint">— top 5</span></h3>
      <ul id="obs-overview-errors" class="ax-obs__error-list"></ul>
      <p class="ax-obs__empty" id="obs-overview-errors-empty" hidden>No failures in the last 24 hours. ✓</p>
    </div>
  </section>

  <section class="ax-obs__pane" data-pane="activity">
    <div class="ax-obs__card">
      <h3>Last 24 hours <span class="ax-obs__hint">— hourly</span></h3>
      <div id="obs-activity-hourly" class="ax-obs__chart"></div>
      <p class="ax-obs__empty" id="obs-activity-hourly-empty" hidden>No activity in the last 24 hours.</p>
    </div>
    <div class="ax-obs__card">
      <h3>Last 7 days <span class="ax-obs__hint">— daily</span></h3>
      <div id="obs-activity-daily" class="ax-obs__chart"></div>
    </div>
    <div class="ax-obs__card">
      <h3>Per-agent activity (7-day window)</h3>
      <table class="ax-obs__table">
        <thead><tr><th>Agent</th><th class="num">Tasks 24h</th><th class="num">Tasks 7d</th><th class="num">Errors 7d</th><th class="num">Avg time</th><th>Last active</th></tr></thead>
        <tbody id="obs-activity-agents"></tbody>
      </table>
      <p class="ax-obs__empty" id="obs-activity-agents-empty" hidden>(no rows)</p>
    </div>
  </section>

  <section class="ax-obs__pane" data-pane="errors">
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>When</th><th>Agent</th><th>Channel</th><th>What happened</th><th>Message</th></tr></thead>
      <tbody id="obs-errors"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-errors-empty" hidden>No errors found.</p>
  </section>

  <section class="ax-obs__pane" data-pane="routing">
    <p class="ax-obs__hint">Technical: every routing decision the daemon made — which stage decided which agent gets a message. Useful for debugging "why didn't agent X pick up this?".</p>
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>at</th><th>channel</th><th>chat_id</th><th>kind</th><th>stage</th><th>agent</th><th>reason</th></tr></thead>
      <tbody id="obs-routing"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-routing-empty" hidden>(no rows)</p>
  </section>

  <section class="ax-obs__pane" data-pane="rotations">
    <p class="ax-obs__hint">Technical: each time an agent's Claude session was rotated — <code>stale</code> (idle), <code>tier-2</code> (input crossed billing threshold), or <code>max-turns</code> (per-session cap).</p>
    <div class="ax-obs__table-wrap"><table class="ax-obs__table">
      <thead><tr><th>at</th><th>agent</th><th>channel</th><th>reason</th><th>last turn input tokens</th></tr></thead>
      <tbody id="obs-rotations"></tbody>
    </table></div>
    <p class="ax-obs__empty" id="obs-rotations-empty" hidden>(no rows)</p>
  </section>
</div>`

  return renderShell({
    title: "AgentX · Health",
    activeTab: "health",
    subtitle: "Health",
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
.ax-obs__tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--ax-border); margin-bottom: 12px; align-items: center; }
.ax-obs__tab {
  background: transparent; border: 0; padding: 8px 14px; cursor: pointer;
  font: inherit; color: var(--ax-muted); border-bottom: 2px solid transparent;
}
.ax-obs__tab:hover { color: var(--ax-text); }
.ax-obs__tab.is-active { color: var(--ax-text); border-bottom-color: var(--ax-accent, #3a7bd5); }
.ax-obs__filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; padding: 8px 0; }
.ax-obs__filters label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--ax-muted); }
.ax-obs__filters input {
  font: inherit; padding: 6px 8px; border: 1px solid var(--ax-border);
  border-radius: 6px; background: var(--ax-bg); color: var(--ax-text); width: 160px;
}
.ax-obs__filters input[type="number"] { width: 80px; }
.ax-obs__filters button {
  padding: 6px 14px; border: 1px solid var(--ax-border); background: var(--ax-bg);
  color: var(--ax-text); border-radius: 6px; cursor: pointer; font: inherit;
}
.ax-obs__filters button:hover { background: var(--ax-surface-2); }
.ax-obs__pane { display: none; }
.ax-obs__pane.is-active { display: block; }
.ax-obs__hint { color: var(--ax-muted); font-size: 11px; font-weight: normal; }
.ax-obs__table-wrap { overflow-x: auto; max-height: calc(100vh - 280px); overflow-y: auto; border: 1px solid var(--ax-border); border-radius: 6px; }
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

/* KPI cards */
.ax-obs__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.ax-obs__kpi { padding: 14px 16px; border: 1px solid var(--ax-border); border-radius: 8px; background: var(--ax-bg); }
.ax-obs__kpi-label { color: var(--ax-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.ax-obs__kpi-value { font-size: 22px; font-weight: 600; line-height: 1.1; }
.ax-obs__kpi-sub { color: var(--ax-muted); font-size: 11px; margin-top: 4px; }
.ax-obs__kpi--alert .ax-obs__kpi-value { color: #cf222e; }
.ax-obs__kpi--good .ax-obs__kpi-value { color: #2da44e; }
.ax-obs__delta { font-size: 11px; }
.ax-obs__delta--up { color: #2da44e; }
.ax-obs__delta--down { color: #cf222e; }

.ax-obs__card { border: 1px solid var(--ax-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; background: var(--ax-bg); }
.ax-obs__card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.ax-obs__split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
@media (max-width: 900px) { .ax-obs__split { grid-template-columns: 1fr; } }
.ax-obs__idle { margin: 0; font-size: 12px; color: var(--ax-muted); }
.ax-obs__idle .ax-obs__pill { margin: 2px 4px 2px 0; }
.ax-obs__error-list { list-style: none; margin: 0; padding: 0; }
.ax-obs__error-list li {
  padding: 8px 10px; border-radius: 6px; background: var(--ax-surface-2);
  margin-bottom: 6px; font-size: 12px; display: grid; gap: 4px;
}
.ax-obs__error-plain { font-weight: 600; color: #cf222e; }
.ax-obs__error-meta { color: var(--ax-muted); font-size: 11px; }
.ax-obs__error-message { color: var(--ax-muted); font-size: 11px; font-family: monospace; word-break: break-word; }

/* Bar charts */
.ax-obs__chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding: 4px 0; }
.ax-obs__bar { flex: 1; min-width: 4px; background: var(--ax-accent, #3a7bd5); border-radius: 2px 2px 0 0; opacity: 0.8; position: relative; cursor: default; transition: opacity 0.1s; }
.ax-obs__bar:hover { opacity: 1; }
.ax-obs__bar--with-error { background: linear-gradient(to top, #cf222e var(--err-pct), var(--ax-accent, #3a7bd5) var(--err-pct)); }
.ax-obs__bar[data-tooltip]:hover::after {
  content: attr(data-tooltip); position: absolute; bottom: 100%; left: 50%;
  transform: translateX(-50%); white-space: nowrap; padding: 4px 8px;
  background: var(--ax-text); color: var(--ax-bg); border-radius: 4px;
  font-size: 11px; pointer-events: none; z-index: 10;
}
.ax-obs__chart--cost .ax-obs__bar { background: #6b7280; }

.ax-obs__pill {
  display: inline-block; padding: 1px 7px; border-radius: 10px;
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  background: var(--ax-surface-2); color: var(--ax-text);
}
.ax-obs__pill--match { background: rgba(46, 160, 67, 0.15); color: #2da44e; }
.ax-obs__pill--drop { background: rgba(207, 34, 46, 0.15); color: #cf222e; }
.ax-obs__pill--tier-2 { background: rgba(218, 119, 6, 0.15); color: #bf8700; }
.ax-obs__pill--stale { background: rgba(99, 110, 123, 0.15); color: #57606a; }
.ax-obs__pill--max-turns { background: rgba(99, 110, 123, 0.15); color: #57606a; }
.ax-obs__pill--idle { background: rgba(218, 119, 6, 0.15); color: #bf8700; }
.ax-obs__empty { color: var(--ax-muted); font-style: italic; padding: 18px 0; margin: 0; }
`

const OBS_PAGE_SCRIPT = `
(function(){
  var panes = document.querySelectorAll('.ax-obs__pane');
  var tabs = document.querySelectorAll('.ax-obs__tab');
  var current = 'overview';

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
  function fmtMoney(n){
    if (n == null) return '$0.00';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1)    return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }
  function fmtMs(n){
    if (!n) return '–';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 60000) return (n / 1000).toFixed(1) + 's';
    return Math.round(n / 60000) + 'm';
  }
  function fmtNum(n){
    if (n == null) return '–';
    return Number(n).toLocaleString();
  }
  function fmtRel(iso){
    if (!iso) return '–';
    var d = new Date(iso).getTime();
    if (isNaN(d)) return '–';
    var diff = (Date.now() - d) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }
  function delta(n, label){
    if (n === 0 || n == null) return '<span class="ax-obs__delta">no change</span>';
    var arrow = n > 0 ? '▲' : '▼';
    var cls = n > 0 ? 'ax-obs__delta--up' : 'ax-obs__delta--down';
    return '<span class="ax-obs__delta ' + cls + '">' + arrow + ' ' + Math.abs(n).toLocaleString() + ' ' + (label || '') + '</span>';
  }
  function deltaMoney(n){
    if (Math.abs(n) < 0.001) return '<span class="ax-obs__delta">no change</span>';
    var arrow = n > 0 ? '▲' : '▼';
    var cls = n > 0 ? 'ax-obs__delta--down' : 'ax-obs__delta--up'; // more cost = bad
    return '<span class="ax-obs__delta ' + cls + '">' + arrow + ' ' + fmtMoney(Math.abs(n)) + ' vs yesterday</span>';
  }

  async function load(tab){
    var agent = document.getElementById('obs-agent').value || '';
    var limit = document.getElementById('obs-limit').value || 50;

    var url, qs = (agent ? '?agent=' + encodeURIComponent(agent) : '');
    if (tab === 'overview' || tab === 'activity') {
      url = '/api/admin/observability/' + tab + qs;
    } else {
      qs = '?limit=' + encodeURIComponent(limit) + (agent ? '&agent=' + encodeURIComponent(agent) : '');
      url = '/api/admin/observability/' + tab + qs;
    }

    try {
      var r = await fetch(url, { credentials: 'same-origin' });
      var data = await r.json();
      render(tab, data);
    } catch (e) {
      console.error('observability fetch failed', e);
    }
  }

  function render(tab, data){
    if (tab === 'overview') return renderOverview(data);
    if (tab === 'activity') return renderActivity(data);
    if (tab === 'errors') return renderErrors(data);
    if (tab === 'routing') return renderRouting(data);
    if (tab === 'rotations') return renderRotations(data);
  }

  function renderOverview(data){
    if (!data) return;
    var k = data.kpis || {};
    var errAlert = k.errorsToday > 0 ? ' ax-obs__kpi--alert' : ' ax-obs__kpi--good';
    document.getElementById('obs-overview-kpis').innerHTML = [
      kpi('Tasks today', fmtNum(k.tasksToday), delta(k.tasksDelta, 'vs yesterday')),
      kpi('Errors today', fmtNum(k.errorsToday) + ' <span class="ax-obs__kpi-sub">(' + (k.errorRate * 100).toFixed(1) + '% error rate)</span>', '', errAlert),
      kpi('Avg response', fmtMs(k.avgDurationMs), 'p50 ' + fmtMs(k.p50DurationMs) + ' · p95 ' + fmtMs(k.p95DurationMs)),
      kpi('Spend today', fmtMoney(k.spendToday), deltaMoney(k.spendDelta)),
    ].join('');

    var pa = data.perAgent || [];
    if (pa.length) {
      document.getElementById('obs-overview-agents-empty').hidden = true;
      document.getElementById('obs-overview-agents').innerHTML = pa.map(function(r){
        return '<tr>'
          + '<td>' + esc(r.agent_id) + '</td>'
          + '<td class="num">' + fmtNum(r.tasks) + '</td>'
          + '<td class="num" ' + (r.errors > 0 ? 'style="color:#cf222e;font-weight:600"' : '') + '>' + fmtNum(r.errors) + '</td>'
          + '<td class="num">' + fmtMs(r.avg_duration_ms) + '</td>'
          + '<td class="small">' + fmtRel(r.last_active) + '</td>'
          + '</tr>';
      }).join('');
    } else {
      document.getElementById('obs-overview-agents-empty').hidden = false;
      document.getElementById('obs-overview-agents').innerHTML = '';
    }

    var pc = data.perChannel || [];
    if (pc.length) {
      document.getElementById('obs-overview-channels-empty').hidden = true;
      document.getElementById('obs-overview-channels').innerHTML = pc.map(function(r){
        return '<tr>'
          + '<td>' + esc(r.channel) + '</td>'
          + '<td class="num">' + fmtNum(r.tasks) + '</td>'
          + '<td class="num" ' + (r.errors > 0 ? 'style="color:#cf222e;font-weight:600"' : '') + '>' + fmtNum(r.errors) + '</td>'
          + '</tr>';
      }).join('');
    } else {
      document.getElementById('obs-overview-channels-empty').hidden = false;
      document.getElementById('obs-overview-channels').innerHTML = '';
    }

    var idle = data.idleAgents || [];
    document.getElementById('obs-overview-idle').innerHTML = idle.length
      ? idle.map(function(a){ return '<span class="ax-obs__pill ax-obs__pill--idle">' + esc(a) + '</span>'; }).join('')
      : '<span class="ax-obs__pill ax-obs__pill--match">All recently-active agents posted a task in the last 24h ✓</span>';

    var er = data.recentErrors || [];
    var ulEmpty = document.getElementById('obs-overview-errors-empty');
    var ulList = document.getElementById('obs-overview-errors');
    if (er.length === 0) {
      ulEmpty.hidden = false;
      ulList.innerHTML = '';
    } else {
      ulEmpty.hidden = true;
      ulList.innerHTML = er.map(function(r){
        return '<li>'
          + '<div class="ax-obs__error-plain">' + esc(r.plain) + '</div>'
          + '<div class="ax-obs__error-meta">' + fmtRel(r.started_at) + ' · ' + esc(r.agent_id) + ' · ' + esc(r.channel) + '</div>'
          + (r.message_preview ? '<div class="ax-obs__error-message">' + esc(r.message_preview.slice(0, 200)) + '</div>' : '')
          + '</li>';
      }).join('');
    }
  }

  function renderActivity(data){
    if (!data) return;
    var hourly = data.hourly || [];
    if (hourly.length === 0) {
      document.getElementById('obs-activity-hourly-empty').hidden = false;
      document.getElementById('obs-activity-hourly').innerHTML = '';
    } else {
      document.getElementById('obs-activity-hourly-empty').hidden = true;
      document.getElementById('obs-activity-hourly').innerHTML = renderBarChart(hourly, 'hour', 'tasks', 'errors');
    }
    document.getElementById('obs-activity-daily').innerHTML = renderBarChart(data.daily || [], 'day', 'tasks', 'errors');

    var rows = data.perAgent || [];
    if (rows.length === 0) {
      document.getElementById('obs-activity-agents-empty').hidden = false;
      document.getElementById('obs-activity-agents').innerHTML = '';
    } else {
      document.getElementById('obs-activity-agents-empty').hidden = true;
      document.getElementById('obs-activity-agents').innerHTML = rows.map(function(r){
        return '<tr>'
          + '<td>' + esc(r.agent_id) + '</td>'
          + '<td class="num">' + fmtNum(r.tasks_24h) + '</td>'
          + '<td class="num">' + fmtNum(r.tasks_7d) + '</td>'
          + '<td class="num" ' + (r.errors_7d > 0 ? 'style="color:#cf222e;font-weight:600"' : '') + '>' + fmtNum(r.errors_7d) + '</td>'
          + '<td class="num">' + fmtMs(r.avg_duration_ms) + '</td>'
          + '<td class="small">' + fmtRel(r.last_active) + '</td>'
          + '</tr>';
      }).join('');
    }
  }

  function renderErrors(data){
    var rows = data && data.rows || [];
    var body = document.getElementById('obs-errors');
    var empty = document.getElementById('obs-errors-empty');
    if (!rows.length) { body.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    body.innerHTML = rows.map(function(r){
      return '<tr>'
        + '<td>' + fmtTs(r.started_at) + '</td>'
        + '<td>' + esc(r.agent_id) + '</td>'
        + '<td>' + esc(r.channel) + '</td>'
        + '<td><span style="color:#cf222e;font-weight:600">' + esc(r.plain) + '</span></td>'
        + '<td class="small">' + esc((r.message_preview || '').slice(0, 60)) + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderRouting(data){
    var rows = data && data.rows || [];
    var body = document.getElementById('obs-routing');
    var empty = document.getElementById('obs-routing-empty');
    if (!rows.length) { body.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
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
  }

  function renderRotations(data){
    var rows = data && data.rows || [];
    var body = document.getElementById('obs-rotations');
    var empty = document.getElementById('obs-rotations-empty');
    if (!rows.length) { body.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    body.innerHTML = rows.map(function(r){
      return '<tr>'
        + '<td>' + fmtTs(r.rotated_at) + '</td>'
        + '<td>' + esc(r.agent_id) + '</td>'
        + '<td>' + esc(r.channel) + '</td>'
        + '<td><span class="ax-obs__pill ax-obs__pill--' + esc(r.reason) + '">' + esc(r.reason) + '</span></td>'
        + '<td class="num">' + (r.last_turn_input_tokens != null ? r.last_turn_input_tokens.toLocaleString() : '-') + '</td>'
        + '</tr>';
    }).join('');
  }

  function kpi(label, value, sub, extraCls){
    return '<div class="ax-obs__kpi' + (extraCls || '') + '">'
      + '<div class="ax-obs__kpi-label">' + label + '</div>'
      + '<div class="ax-obs__kpi-value">' + value + '</div>'
      + '<div class="ax-obs__kpi-sub">' + (sub || '') + '</div>'
      + '</div>';
  }

  function renderBarChart(rows, xKey, valueKey, errorKey, money){
    if (!rows.length) return '<p class="ax-obs__empty">(no data)</p>';
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][valueKey] > max) max = rows[i][valueKey];
    }
    if (max === 0) return '<p class="ax-obs__empty">(no activity)</p>';
    return rows.map(function(r){
      var v = r[valueKey] || 0;
      var pct = (v / max) * 100;
      var label = money ? fmtMoney(v) : fmtNum(v);
      var tip = esc(r[xKey]) + ': ' + label + (errorKey && r[errorKey] ? ' (' + r[errorKey] + ' errors)' : '');
      var errPct = errorKey && v > 0 ? Math.round((r[errorKey] / v) * 100) + '%' : '0%';
      var cls = errorKey && r[errorKey] > 0 ? 'ax-obs__bar ax-obs__bar--with-error' : 'ax-obs__bar';
      return '<div class="' + cls + '" style="height:' + pct + '%;--err-pct:' + errPct + '" data-tooltip="' + tip + '"></div>';
    }).join('');
  }

  document.getElementById('obs-refresh').addEventListener('click', function(){ load(current); });
  document.getElementById('obs-agent').addEventListener('change', function(){ load(current); });
  var lim = document.getElementById('obs-limit');
  if (lim) lim.addEventListener('change', function(){ load(current); });

  load(current);
})();
`
