// --- Hub Settings: Diagnostics (#1449, from classic /admin/health) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Machine script, so it shares
// S.st, stGet(), stPaint(), stOptions() and the Hub's esc(), ago(), money()
// and headers(). It writes nothing: each tab reads what classic /admin/health
// reads.
//
//   Overview   today's tasks, errors, response times and spend, per agent
//              and channel (GET /api/admin/observability/overview)
//   Activity   tasks per hour and per day, per agent over 7 days
//              (GET /api/admin/observability/activity)
//   Errors     task_history error rows, with the plain-English label
//              (GET /api/admin/observability/errors)
//   Routing    which stage picked which agent for a message
//              (GET /api/admin/observability/routing)
//   Rotations  each session rotation and why
//              (GET /api/admin/observability/rotations)
//   Logs       live tail of the daemon's output (SSE /api/admin/logs/stream,
//              with a stream ticket when the page carries a token)
//   Doctor     the preflight checks of `agentx doctor` (GET /api/admin/doctor)

export const WALL_SETTINGS_DIAGNOSTICS_SCRIPT = String.raw`
  // --- Diagnostics ---
  var ST_DG_TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['errors', 'Errors'], ['routing', 'Routing'], ['rotations', 'Rotations'], ['logs', 'Logs'], ['doctor', 'Doctor']];
  var ST_DG_MAX_LINES = 2000;
  function stDg() { return S.st.dg || (S.st.dg = { tab: 'overview', agent: '', limit: 50, data: null, error: '', loading: false, logs: [], filter: '', follow: true, paused: false, es: null, status: '' }); }
  function stDgTs(s) { return s ? String(s).replace('T', ' ').replace('Z', '').slice(0, 19) : ''; }
  function stDgNum(n) { return n == null ? '–' : Number(n).toLocaleString(); }
  function stDgMs(n) { return !n ? '–' : n < 1000 ? Math.round(n) + ' ms' : n < 60000 ? (n / 1000).toFixed(1) + ' s' : Math.round(n / 60000) + ' min'; }
  function stDgRel(iso) { var t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? '–' : ago(t); }
  function stDgDelta(n, fmt) { return !n ? 'no change' : (n > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(n)) + ' vs yesterday'; }
  async function stDgLoad() {
    var d = stDg();
    if (d.tab !== 'logs') stDgClose(d);
    d.loading = true; d.error = ''; d.data = null;
    stPaint();
    if (d.tab === 'logs') { d.loading = false; d.data = {}; stPaint(); stDgOpen(d); return; }
    var agent = d.agent ? 'agent=' + encodeURIComponent(d.agent) : '';
    try {
      d.data = d.tab === 'doctor' ? await stGet('/api/admin/doctor?running=true')
        : d.tab === 'overview' || d.tab === 'activity' ? await stGet('/api/admin/observability/' + d.tab + (agent ? '?' + agent : ''))
        : await stGet('/api/admin/observability/' + d.tab + '?limit=' + d.limit + (agent ? '&' + agent : ''));
    } catch (e) { d.error = String(e.message || e); }
    d.loading = false;
    stPaint();
  }
  function stDgTable(heads, rows, cells, empty) {
    if (!rows.length) return '<p class="ax-wall__empty">' + esc(empty) + '</p>';
    return '<div class="wsdg__wrap"><table class="wsdg__t"><thead><tr>' + heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + cells(r).map(function (c) { return '<td>' + esc(c == null ? '' : c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function stDgKpi(label, value, sub, alert) {
    return '<div class="wsdg__kpi' + (alert ? ' is-alert' : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><small>' + esc(sub || '') + '</small></div>';
  }
  /** Bars of tasks, the errors' share in red at the foot of each. */
  function stDgBars(rows, x, label) {
    var max = rows.reduce(function (m, r) { return Math.max(m, r.tasks || 0); }, 0);
    if (!max) return '<p class="ax-wall__empty">No activity in ' + esc(label) + '.</p>';
    return '<div class="wsdg__chart" role="img" aria-label="Tasks ' + esc(label) + '">' + rows.map(function (r) {
      var v = r.tasks || 0, e = r.errors || 0;
      return '<div class="wsdg__bar" style="height:' + (v / max * 100) + '%;--err:' + (v ? Math.round(e / v * 100) : 0) + '%" title="' +
        esc(r[x] + ': ' + stDgNum(v) + ' tasks' + (e ? ', ' + e + ' errors' : '')) + '"></div>';
    }).join('') + '</div>';
  }
  function stDgOverview(data) {
    var k = data.kpis || {}, idle = data.idleAgents || [], er = data.recentErrors || [];
    return '<div class="wsdg__kpis">' +
      stDgKpi('Tasks today', stDgNum(k.tasksToday), stDgDelta(k.tasksDelta, stDgNum)) +
      stDgKpi('Errors today', stDgNum(k.errorsToday), ((k.errorRate || 0) * 100).toFixed(1) + '% of tasks', k.errorsToday > 0) +
      stDgKpi('Average response', stDgMs(k.avgDurationMs), 'p50 ' + stDgMs(k.p50DurationMs) + ' · p95 ' + stDgMs(k.p95DurationMs)) +
      stDgKpi('Spend today', money(k.spendToday || 0), stDgDelta(k.spendDelta, money)) + '</div>' +
      '<section class="wsc"><h3>Per agent, today</h3>' + stDgTable(['Agent', 'Tasks', 'Errors', 'Average time', 'Last active'], data.perAgent || [],
        function (r) { return [r.agent_id, stDgNum(r.tasks), stDgNum(r.errors), stDgMs(r.avg_duration_ms), stDgRel(r.last_active)]; }, 'No tasks yet today.') + '</section>' +
      '<section class="wsc"><h3>Per channel, today</h3>' + stDgTable(['Channel', 'Tasks', 'Errors'], data.perChannel || [],
        function (r) { return [r.channel, stDgNum(r.tasks), stDgNum(r.errors)]; }, 'No traffic yet today.') + '</section>' +
      '<section class="wsc"><h3>Idle agents</h3><p class="wsf__hint">' + (idle.length
        ? 'No task in the last 24 hours: ' + idle.map(esc).join(', ') + '.' : 'Every recently active agent ran a task in the last 24 hours.') + '</p></section>' +
      '<section class="wsc"><h3>Recent failures</h3>' + (er.length ? '<ul class="wsdg__errs">' + er.map(function (r) {
        return '<li><b>' + esc(r.plain || r.error) + '</b><small>' + esc(stDgRel(r.started_at) + ' · ' + r.agent_id + ' · ' + r.channel) + '</small>' +
          (r.message_preview ? '<p class="wsdg__detail">' + esc(String(r.message_preview).slice(0, 200)) + '</p>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="ax-wall__empty">No failures in the last 24 hours.</p>') + '</section>';
  }
  function stDgActivity(data) {
    return '<section class="wsc"><h3>Last 24 hours, per hour</h3>' + stDgBars(data.hourly || [], 'hour', 'the last 24 hours') + '</section>' +
      '<section class="wsc"><h3>Last 7 days, per day</h3>' + stDgBars(data.daily || [], 'day', 'the last 7 days') + '</section>' +
      '<section class="wsc"><h3>Per agent, 7 days</h3>' + stDgTable(['Agent', 'Tasks 24 h', 'Tasks 7 days', 'Errors 7 days', 'Average time', 'Last active'], data.perAgent || [],
        function (r) { return [r.agent_id, stDgNum(r.tasks_24h), stDgNum(r.tasks_7d), stDgNum(r.errors_7d), stDgMs(r.avg_duration_ms), stDgRel(r.last_active)]; }, 'No tasks in the last 7 days.') + '</section>';
  }
  function stDgBody(d) {
    var rows = (d.data && d.data.rows) || [];
    if (d.tab === 'overview') return stDgOverview(d.data || {});
    if (d.tab === 'activity') return stDgActivity(d.data || {});
    if (d.tab === 'logs') return stDgLogsHtml(d);
    if (d.tab === 'errors') return stDgTable(['When', 'Agent', 'Channel', 'What happened', 'Message'], rows,
      function (r) { return [stDgTs(r.started_at), r.agent_id, r.channel, r.plain || r.error, String(r.message_preview || '').slice(0, 60)]; }, 'No errors found.');
    if (d.tab === 'routing') return '<p class="wsf__hint">Which stage decided which agent gets a message. Useful for "why did agent X not pick this up?".</p>' +
      stDgTable(['When', 'Channel', 'Chat', 'Kind', 'Stage', 'Agent', 'Reason'], rows,
        function (r) { return [stDgTs(r.at), r.channel, r.chat_id, r.kind, r.deciding_stage, r.agent_id, r.reason]; }, 'No routing decisions yet.');
    if (d.tab === 'rotations') return '<p class="wsf__hint">Each time an agent\'s session was started fresh: stale (idle), tier-2 (input crossed the billing threshold) or max-turns.</p>' +
      stDgTable(['When', 'Agent', 'Channel', 'Reason', 'Last turn input tokens'], rows,
        function (r) { return [stDgTs(r.rotated_at), r.agent_id, r.channel, r.reason, r.last_turn_input_tokens == null ? '' : Number(r.last_turn_input_tokens).toLocaleString()]; }, 'No rotations yet.');
    var s = (d.data && d.data.summary) || {}, groups = {};
    ((d.data && d.data.checks) || []).forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
    return '<p class="wsj__sub">' + (s.ok || 0) + ' ok · ' + (s.warnings || 0) + ' warnings · ' + (s.errors || 0) + ' failing. The same checks as <code>agentx doctor</code>.</p>' +
      Object.keys(groups).map(function (g) {
        return '<section class="wsc"><h3>' + esc(g) + '</h3><ul class="wsdg__checks">' + groups[g].map(function (c) {
          return '<li><span class="wsdg__sev is-' + esc(c.severity) + '">' + esc(c.severity) + '</span><div><b>' + esc(c.title) + '</b>' +
            (c.detail ? '<p class="wsdg__detail">' + esc(c.detail) + '</p>' : '') + (c.fix ? '<p class="wsdg__fix">' + esc(c.fix) + '</p>' : '') + '</div></li>';
        }).join('') + '</ul></section>';
      }).join('');
  }

  // --- Logs: the live tail. Lines are kept here and added to the box in
  // place, so a new line never repaints the section (or a field being typed).
  function stDgLineHtml(line) {
    var l = line.toLowerCase();
    var k = l.indexOf('error') >= 0 || l.indexOf('fail') >= 0 ? 'err' : l.indexOf('warn') >= 0 ? 'warn' : l.indexOf('debug') >= 0 || l.indexOf('[graph]') >= 0 ? 'dim' : 'info';
    return '<span class="is-' + k + '">' + esc(line) + '\n</span>';
  }
  function stDgLinesHtml(d) {
    var f = d.filter.toLowerCase();
    return d.logs.filter(function (l) { return !f || l.toLowerCase().indexOf(f) >= 0; }).map(stDgLineHtml).join('');
  }
  function stDgLogsHtml(d) {
    return '<div class="wsf__row"><label>Filter<input id="st-dg-filter" type="search" value="' + esc(d.filter) + '" placeholder="Show lines containing…"></label>' +
      '<label class="wsf__check"><input type="checkbox" data-st-dg="follow"' + (d.follow ? ' checked' : '') + '> Follow new lines</label>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="dg-pause">' + (d.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-st-act="dg-clear">Clear</button>' +
      '<span class="wsf__hint" id="st-dg-status" role="status">' + esc(d.paused ? 'paused' : d.status || 'connecting…') + '</span></div>' +
      '<pre class="wsdg__logs" id="st-dg-logs">' + stDgLinesHtml(d) + '</pre>';
  }
  function stDgStatus(d, text) { d.status = text; var el = $('st-dg-status'); if (el && S.st.dg === d) el.textContent = text; }
  function stDgWanted(d) { return S.st.dg === d && d.tab === 'logs' && !d.paused; }
  function stDgLine(d, line) {
    if (!line) return;
    if (S.st.dg !== d || d.tab !== 'logs') { stDgClose(d); return; }
    d.logs.push(line);
    if (d.logs.length > ST_DG_MAX_LINES) d.logs.splice(0, d.logs.length - ST_DG_MAX_LINES);
    var box = $('st-dg-logs'), f = d.filter.toLowerCase();
    if (!box || (f && line.toLowerCase().indexOf(f) < 0)) return;
    box.insertAdjacentHTML('beforeend', stDgLineHtml(line));
    if (box.children && box.children.length > ST_DG_MAX_LINES) box.removeChild(box.firstChild);
    if (d.follow) box.scrollTop = box.scrollHeight;
  }
  // EventSource sends no header: trade the page token for a one-minute ticket
  // the stream URL carries. A signed-in browser uses its session cookie.
  async function stDgTicket() {
    if (!window.AX_LOCAL_TOKEN) return '';
    var r = await fetch('/api/admin/stream-ticket', { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error('stream-ticket ' + r.status);
    var b = await r.json();
    return b.ticket ? '?st=' + encodeURIComponent(b.ticket) : '';
  }
  function stDgOpen(d) {
    if (d.es || !stDgWanted(d)) return;
    d.es = 'opening';
    stDgStatus(d, 'connecting…');
    stDgTicket().then(function (st) {
      if (d.es !== 'opening') return;
      var es = new EventSource('/api/admin/logs/stream' + st, { withCredentials: true });
      d.es = es;
      es.addEventListener('line', function (ev) { stDgLine(d, ev.data); });
      es.addEventListener('open', function () { stDgStatus(d, 'live'); });
      es.addEventListener('error', function () {
        stDgStatus(d, 'disconnected (retrying)');
        // A network drop reconnects by itself; an HTTP error (an expired
        // ticket on reconnect) closes the stream, so open it with a new one.
        if (d.es === es && es.readyState === 2) { d.es = null; stDgRetry(d, 3000); }
      });
    }).catch(function () {
      if (d.es === 'opening') d.es = null;
      stDgStatus(d, 'disconnected (retrying)');
      stDgRetry(d, 5000);
    });
  }
  function stDgRetry(d, ms) { setTimeout(function () { stDgOpen(d); }, ms); }
  /** Called by settingsShow() when another section opens, and on a tab change. */
  function stDgClose(d) {
    if (!d) return;
    if (d.es && d.es !== 'opening') { try { d.es.close(); } catch (e) { /* already closed */ } }
    d.es = null;
  }

  function stDiagnosticsHtml() {
    var d = stDg();
    if (!d.data && !d.loading && !d.error) { stDgLoad(); }
    var agents = ((S.st.data && S.st.data.agents) || []).map(function (a) { return a.id; });
    var tabs = '<nav class="wsdg__tabs" aria-label="Diagnostics">' + ST_DG_TABS.map(function (t) {
      return '<button type="button" class="wsdg__tab' + (t[0] === d.tab ? ' is-on' : '') + '" data-st-act="dg-tab" data-id="' + t[0] + '"' + (t[0] === d.tab ? ' aria-current="true"' : '') + '>' + t[1] + '</button>';
    }).join('') + '</nav>';
    var rowsPick = d.tab === 'errors' || d.tab === 'routing' || d.tab === 'rotations';
    var filter = d.tab === 'doctor' || d.tab === 'logs' ? '' : '<div class="wsf__row"><label>Agent<select id="st-dg-agent" data-st-dg="agent">' + stOptions([['', 'All agents']].concat(agents), d.agent) + '</select></label>' +
      (rowsPick ? '<label>Rows<select id="st-dg-limit" data-st-dg="limit">' + stOptions(['50', '100', '200', '500'], String(d.limit)) + '</select></label>' : '') + '</div>';
    var body = d.loading ? '<p class="ax-wall__empty">Loading…</p>'
      : d.error ? '<p class="wst__err">Could not read ' + esc(d.tab) + ': ' + esc(d.error) + '.</p>' : stDgBody(d);
    return '<header class="wst__h"><h2>Diagnostics</h2><p>What the agents ran today, what went wrong, how messages were routed, when sessions were started fresh, the daemon\'s output and the preflight checks. Read-only. Spend is on the Cost page.</p></header>' +
      tabs + filter + body +
      (d.tab === 'logs' ? '' : '<div class="wsf__foot"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="dg-load">' + (d.tab === 'doctor' ? 'Run the checks again' : 'Refresh') + '</button></div>');
  }
  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act'), d = stDg();
    if (a === 'dg-tab') { d.tab = t.getAttribute('data-id'); stDgLoad(); }
    else if (a === 'dg-load') stDgLoad();
    else if (a === 'dg-pause') { d.paused = !d.paused; if (d.paused) stDgClose(d); stPaint(); stDgOpen(d); }
    else if (a === 'dg-clear') { d.logs = []; var box = $('st-dg-logs'); if (box) box.innerHTML = ''; }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target, k = S.page === 'settings' && t && t.getAttribute && t.getAttribute('data-st-dg');
    if (!k) return;
    var d = stDg();
    if (k === 'follow') { d.follow = !!t.checked; return; }
    if (k === 'agent') d.agent = String(t.value || '');
    else d.limit = parseInt(t.value, 10) || 50;
    stDgLoad();
  });
  // The filter redraws the lines alone, so the field keeps its focus.
  document.addEventListener('input', function (ev) {
    if (S.page !== 'settings' || !ev.target || ev.target.id !== 'st-dg-filter' || !S.st.dg) return;
    S.st.dg.filter = String(ev.target.value || '');
    var box = $('st-dg-logs');
    if (box) box.innerHTML = stDgLinesHtml(S.st.dg);
  });
`

export const WALL_SETTINGS_DIAGNOSTICS_CSS = `
.wsdg__tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 12px; border-bottom: 1px solid var(--ax-border); }
.wsdg__tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; font: inherit; color: var(--ax-muted); cursor: pointer; }
.wsdg__tab.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wsdg__wrap { overflow-x: auto; }
.wsdg__t { width: 100%; border-collapse: collapse; font-size: 12px; }
.wsdg__t th, .wsdg__t td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wsdg__t th { color: var(--ax-muted); font-weight: 600; }
.wsdg__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 0 0 12px; }
.wsdg__kpi { display: flex; flex-direction: column; gap: 2px; padding: 10px; border: 1px solid var(--ax-border); border-radius: 6px; }
.wsdg__kpi span, .wsdg__kpi small { font-size: 11px; color: var(--ax-muted); }
.wsdg__kpi b { font-size: 20px; }
.wsdg__kpi.is-alert b { color: var(--ax-err, #cf222e); }
.wsdg__chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding: 4px 0; }
.wsdg__bar { flex: 1; min-width: 4px; border-radius: 2px 2px 0 0; background: linear-gradient(to top, var(--ax-err, #cf222e) var(--err), var(--ax-accent, #3a7bd5) var(--err)); }
.wsdg__errs { list-style: none; margin: 0; padding: 0; }
.wsdg__errs li { padding: 6px 0; border-top: 1px solid var(--ax-border); }
.wsdg__errs li:first-child { border-top: 0; }
.wsdg__errs small { display: block; font-size: 11px; color: var(--ax-muted); }
.wsdg__logs { max-height: 60vh; overflow: auto; margin: 0; padding: 8px; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: var(--ax-surface-2, #f6f8fa); border: 1px solid var(--ax-border); border-radius: 6px; }
.wsdg__logs .is-err { color: var(--ax-err, #cf222e); }
.wsdg__logs .is-warn { color: var(--ax-warn, #bf8700); }
.wsdg__logs .is-dim { color: var(--ax-muted); }
.wsdg__checks { list-style: none; margin: 0; padding: 0; }
.wsdg__checks li { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 6px 0; border-top: 1px solid var(--ax-border); }
.wsdg__checks li:first-child { border-top: 0; }
.wsdg__sev { font-size: 10px; font-weight: 600; text-transform: uppercase; text-align: center; padding: 2px 6px; border-radius: 3px; align-self: start; }
.wsdg__sev.is-ok { color: var(--ax-ok, #2da44e); }
.wsdg__sev.is-warn { color: var(--ax-warn, #bf8700); }
.wsdg__sev.is-fail { color: var(--ax-err, #cf222e); }
.wsdg__detail { margin: 2px 0 0; font-size: 11px; color: var(--ax-muted); word-break: break-word; }
.wsdg__fix { margin: 2px 0 0; font-size: 11px; }
`
