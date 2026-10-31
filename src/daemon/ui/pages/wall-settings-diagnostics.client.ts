// --- Hub Settings: Diagnostics (#1449, from classic /admin/health) ---
//
// Spliced into WALL_SETTINGS_SCRIPT after the Machine script, so it shares
// S.st, stGet(), stPaint(), stOptions() and the Hub's esc(). It writes
// nothing: each tab reads the endpoint classic /admin/health reads.
//
//   Errors     task_history error rows, with the plain-English label
//              (GET /api/admin/observability/errors)
//   Routing    which stage picked which agent for a message
//              (GET /api/admin/observability/routing)
//   Rotations  each session rotation and why
//              (GET /api/admin/observability/rotations)
//   Doctor     the preflight checks of `agentx doctor` (GET /api/admin/doctor)
//
// The classic page's Overview, Activity and Logs tabs are not here yet, so
// /admin/health stays open (classic-routes.ts).

export const WALL_SETTINGS_DIAGNOSTICS_SCRIPT = String.raw`
  // --- Diagnostics ---
  var ST_DG_TABS = [['errors', 'Errors'], ['routing', 'Routing'], ['rotations', 'Rotations'], ['doctor', 'Doctor']];
  function stDg() { return S.st.dg || (S.st.dg = { tab: 'errors', agent: '', limit: 50, data: null, error: '', loading: false }); }
  function stDgTs(s) { return s ? String(s).replace('T', ' ').replace('Z', '').slice(0, 19) : ''; }
  async function stDgLoad() {
    var d = stDg();
    d.loading = true; d.error = ''; d.data = null;
    stPaint();
    try {
      d.data = d.tab === 'doctor'
        ? await stGet('/api/admin/doctor?running=true')
        : await stGet('/api/admin/observability/' + d.tab + '?limit=' + d.limit + (d.agent ? '&agent=' + encodeURIComponent(d.agent) : ''));
    } catch (e) { d.error = String(e.message || e); }
    d.loading = false;
    stPaint();
  }
  function stDgTable(heads, rows, cells, empty) {
    if (!rows.length) return '<p class="ax-wall__empty">' + esc(empty) + '</p>';
    return '<div class="wsdg__wrap"><table class="wsdg__t"><thead><tr>' + heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + cells(r).map(function (c) { return '<td>' + esc(c == null ? '' : c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function stDgBody(d) {
    var rows = (d.data && d.data.rows) || [];
    if (d.tab === 'errors') return stDgTable(['When', 'Agent', 'Channel', 'What happened', 'Message'], rows,
      function (r) { return [stDgTs(r.started_at), r.agent_id, r.channel, r.plain || r.error, r.message_preview]; }, 'No errors found.');
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
  function stDiagnosticsHtml() {
    var d = stDg();
    if (!d.data && !d.loading && !d.error) { stDgLoad(); }
    var agents = ((S.st.data && S.st.data.agents) || []).map(function (a) { return a.id; });
    var tabs = '<nav class="wsdg__tabs" aria-label="Diagnostics">' + ST_DG_TABS.map(function (t) {
      return '<button type="button" class="wsdg__tab' + (t[0] === d.tab ? ' is-on' : '') + '" data-st-act="dg-tab" data-id="' + t[0] + '"' + (t[0] === d.tab ? ' aria-current="true"' : '') + '>' + t[1] + '</button>';
    }).join('') + '</nav>';
    var filter = d.tab === 'doctor' ? '' : '<div class="wsf__row"><label>Agent<select id="st-dg-agent" data-st-dg="agent">' + stOptions([['', 'All agents']].concat(agents), d.agent) + '</select></label>' +
      '<label>Rows<select id="st-dg-limit" data-st-dg="limit">' + stOptions(['50', '100', '200', '500'], String(d.limit)) + '</select></label></div>';
    var body = d.loading ? '<p class="ax-wall__empty">Loading…</p>'
      : d.error ? '<p class="wst__err">Could not read ' + esc(d.tab) + ': ' + esc(d.error) + '.</p>' : stDgBody(d);
    return '<header class="wst__h"><h2>Diagnostics</h2><p>What went wrong, how messages were routed, when sessions were started fresh, and the preflight checks. Read-only.</p></header>' +
      tabs + filter + body +
      '<div class="wsf__foot"><button type="button" class="ax-btn ax-btn--ghost" data-st-act="dg-load">' + (d.tab === 'doctor' ? 'Run the checks again' : 'Refresh') + '</button></div>';
  }
  document.addEventListener('click', function (ev) {
    if (S.page !== 'settings') return;
    var t = ev.target.closest('[data-st-act]');
    if (!t) return;
    var a = t.getAttribute('data-st-act');
    if (a === 'dg-tab') { stDg().tab = t.getAttribute('data-id'); stDgLoad(); }
    else if (a === 'dg-load') stDgLoad();
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target, k = S.page === 'settings' && t && t.getAttribute && t.getAttribute('data-st-dg');
    if (!k) return;
    var d = stDg();
    if (k === 'agent') d.agent = String(t.value || '');
    else d.limit = parseInt(t.value, 10) || 50;
    stDgLoad();
  });
`

export const WALL_SETTINGS_DIAGNOSTICS_CSS = `
.wsdg__tabs { display: flex; gap: 4px; margin: 0 0 12px; border-bottom: 1px solid var(--ax-border); }
.wsdg__tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; font: inherit; color: var(--ax-muted); cursor: pointer; }
.wsdg__tab.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wsdg__wrap { overflow-x: auto; }
.wsdg__t { width: 100%; border-collapse: collapse; font-size: 12px; }
.wsdg__t th, .wsdg__t td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wsdg__t th { color: var(--ax-muted); font-weight: 600; }
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
