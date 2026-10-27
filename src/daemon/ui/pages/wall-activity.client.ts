// --- Wall Activity page, browser side (#1429) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), stamp(), shortTime(), avatar(), nameOf(), uniq(), money(), dur(),
// wallTaskHref(), getJson(), profileHtml() and OTHER.
//
// The agents' runs, newest first, in the Wall's look (#page=activity): one
// row per run with the agent, what it worked on, its result, how long it
// took, its cost and when. Selecting a row opens the run's Task page.
// Filters (agent, project, result, period) live in the hash as a-agent,
// a-project, a-result and a-period, so a view is a link. With an agent
// picked, the agent's profile heads the page with its Activity tab on:
// that is the profile's Activity tab, in place of the classic history page.
//
// Reads the same endpoints the classic /activity Timeline reads:
// /api/monitor for the machines, then /api/monitor/activity per machine.
// No new counting: a run's cost is the one its trace stored, and a run
// with none shows "–", not $0. Nothing here writes.

export const WALL_ACTIVITY_SCRIPT = String.raw`
  // --- Activity (#1429): every run, newest first ---
  var ACT_PERIODS = [['24h', '24 h', 24], ['7d', '7 d', 168], ['30d', '30 d', 720]];
  var ACT_RESULTS = [['done', 'Done'], ['failed', 'Failed'], ['running', 'Running'], ['stopped', 'Stopped']];
  /** The hash keys of the Activity filters, and their S.act field. */
  var ACT_KEYS = [['a-agent', 'agent'], ['a-project', 'project'], ['a-result', 'result'], ['a-period', 'period']];
  /** The most runs one machine sends for a window (session-monitor.ts). */
  var ACT_CAP = 400;
  S.act = { agent: '', project: '', result: '', period: '24h' };
  /** Runs read per period: { loading, runs, notes, error }. */
  S.acts = {};
  function actPeriod(k) { return ACT_PERIODS.find(function (p) { return p[0] === k; }) || ACT_PERIODS[0]; }
  function actRead(q) {
    ACT_KEYS.forEach(function (k) { S.act[k[1]] = q.get(k[0]) || ''; });
    S.act.period = actPeriod(S.act.period)[0];
  }
  function actWrite(q) {
    ACT_KEYS.forEach(function (k) { if (S.act[k[1]] && !(k[1] === 'period' && S.act.period === '24h')) q.set(k[0], S.act[k[1]]); });
  }
  /** A trace's status as a result: ok, error or timeout, stopped, in flight. */
  function actResult(status) {
    if (status === 'ok' || status === 'success') return 'done';
    if (status === 'error' || status === 'timeout' || status === 'failed') return 'failed';
    if (status === 'stopped' || status === 'canceled') return 'stopped';
    return 'running';
  }
  var ACT_CHIP = { done: 'chip--done', failed: 'chip--err', stopped: 'chip--ghost', running: '' };
  /** The Wall's post for each run it knows of, by task id. */
  function actPosts() {
    var by = {};
    ((S.data && S.data.posts) || []).forEach(function (p) {
      if (p.lastRun && p.lastRun.taskId) by[p.lastRun.taskId] = p;
      if (p.result && p.result.taskId) by[p.result.taskId] = p;
    });
    return by;
  }
  /** Each run with what the page shows of it: title, project, result. */
  function actRows() {
    var got = S.acts[S.act.period];
    if (!got || !got.runs) return null;
    var posts = actPosts();
    return got.runs.map(function (r) {
      var p = posts[r.id];
      var ask = String(r.preview || '').split('\n')[0].trim();
      return { run: r, post: p || null, title: p ? p.headline : ask, project: (p && p.project) || r.project || '', result: actResult(r.status) };
    });
  }
  function actMatch(x, f) {
    if (f.agent && x.run.agentId !== f.agent) return false;
    if (f.project && (f.project === OTHER ? x.project : x.project !== f.project)) return false;
    if (f.result && x.result !== f.result) return false;
    return true;
  }
  /** How long a run took; still running, how long so far. */
  function actDur(r) {
    if (r.durationMs != null) return dur(r.durationMs);
    return actResult(r.status) === 'running' && r.startedAt ? dur(Date.now() - r.startedAt) + ' so far' : '–';
  }
  function actCost(r) { return typeof r.costUsd === 'number' ? money(r.costUsd) : '–'; }
  function actRowHtml(x, multi) {
    var r = x.run, label = (ACT_RESULTS.find(function (k) { return k[0] === x.result; }) || [0, x.result])[1];
    var href = wallTaskHref({ id: r.id, channel: r.channel, message: r.preview, startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : '' }, r.agentId, r.nodeUrl, x.result !== 'running');
    var meta = [
      x.project ? '<span title="Project"><b>' + esc(x.project) + '</b></span>' : '',
      r.channel ? '<span title="Where it came from">' + esc(r.channel) + '</span>' : '',
      '<span title="How long it took">' + esc(actDur(r)) + '</span>',
      '<span title="' + (typeof r.costUsd === 'number' ? 'What it cost' : 'No cost recorded for this run') + '">' + esc(actCost(r)) + '</span>',
    ];
    return '<article class="wp wac' + (x.result === 'failed' ? ' is-failed' : '') + '" data-act-row>' + avatar(r.agentId, 'act') + '<div class="wp__b">' +
      '<div class="wp__by"><button type="button" class="name" data-act-agent="' + esc(r.agentId) + '" title="Only ' + esc(nameOf(r.agentId)) + '\'s runs">' + esc(nameOf(r.agentId)) + '</button>' +
        '<span class="h">@' + esc(r.agentId) + '</span><span aria-hidden="true">·</span>' + (r.startedAt ? shortTime(r.startedAt) : '') +
        (multi && r.node ? '<span aria-hidden="true">·</span><span>' + esc(r.node) + '</span>' : '') +
        '<span class="chip state' + (ACT_CHIP[x.result] ? ' ' + ACT_CHIP[x.result] : '') + '">' + esc(label) + '</span></div>' +
      '<p class="wp__title"><a class="wac__t" href="' + esc(href) + '" title="Open this run">' + (x.title ? esc(x.title) : '<i>No request recorded</i>') + '</a></p>' +
      '<div class="wp__meta">' + meta.filter(Boolean).join('') + '</div>' +
    '</div></article>';
  }
  function actSelect(id, label, values, on, name) {
    return '<label>' + label + ' <select id="' + id + '"><option value="">All</option>' + values.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === on ? ' selected' : '') + '>' + esc(name ? name(v) : v) + '</option>';
    }).join('') + '</select></label>';
  }
  function actBarHtml(rows) {
    var f = S.act, all = rows || [];
    var agents = uniq(all.map(function (x) { return x.run.agentId; }).concat([f.agent]));
    var projects = uniq(all.map(function (x) { return x.project; }).concat(f.project && f.project !== OTHER ? [f.project] : []));
    if (f.project === OTHER || all.some(function (x) { return !x.project; })) projects.push(OTHER);
    return '<div class="wac__bar">' +
      '<span class="wac__seg" role="radiogroup" aria-label="Period">' + ACT_PERIODS.map(function (p) {
        return '<button type="button" role="radio" data-act-period="' + p[0] + '" aria-checked="' + (f.period === p[0]) + '"' + (f.period === p[0] ? ' class="is-on"' : '') + '>' + p[1] + '</button>';
      }).join('') + '</span>' +
      (f.agent ? '' : actSelect('act-agent', 'Agent', agents, f.agent, nameOf)) +
      actSelect('act-project', 'Project', projects, f.project, function (v) { return v === OTHER ? 'Other (no project)' : v; }) +
      actSelect('act-result', 'Result', ACT_RESULTS.map(function (k) { return k[0]; }), f.result, function (v) { return ACT_RESULTS.find(function (k) { return k[0] === v; })[1]; }) +
      '<a class="wac__tl" href="/activity" title="The classic lane view, and the Map">Timeline</a>' +
    '</div>';
  }
  function activityPageHtml() {
    loadActivity(false);
    var f = S.act, got = S.acts[f.period] || {}, rows = actRows();
    var head = f.agent ? '<div class="ax-wall__profile">' + profileHtml(f.agent, 'activity') + '</div>' : '';
    var notes = (got.notes || []).map(function (n) { return '<p class="ax-wall__count wac__note">' + esc(n) + '</p>'; }).join('');
    if (got.error && !rows) return head + actBarHtml(null) + '<p class="ax-wall__empty wac__empty">Could not read the runs: ' + esc(got.error) + '</p>';
    if (!rows) return head + actBarHtml(null) + '<p class="ax-wall__empty wac__empty">Loading…</p>';
    var shown = rows.filter(function (x) { return actMatch(x, f); });
    var multi = uniq(rows.map(function (x) { return x.run.node; })).length > 1;
    var failed = shown.filter(function (x) { return x.result === 'failed'; }).length;
    var count = '<p class="ax-wall__count wac__note">' + shown.length + (shown.length === 1 ? ' run' : ' runs') + (failed ? ', ' + failed + ' failed' : '') +
      ' in the last ' + esc(actPeriod(f.period)[1]) + (shown.length !== rows.length ? ' (of ' + rows.length + ')' : '') + '</p>';
    var empty = !rows.length ? 'Nothing ran in the last ' + esc(actPeriod(f.period)[1]) + '.' : 'No runs match these filters.';
    return head + actBarHtml(rows) + notes + count +
      (shown.length ? '<div class="wac__list">' + shown.map(function (x) { return actRowHtml(x, multi); }).join('') + '</div>' : '<p class="ax-wall__empty wac__empty">' + empty + '</p>');
  }
  /** Read the period's runs from every machine; again when force is set. */
  async function loadActivity(force) {
    var k = S.act.period, had = S.acts[k];
    if (had && (had.loading || !force)) return;
    S.acts[k] = { loading: true, runs: had && had.runs, notes: had && had.notes };
    var hours = actPeriod(k)[2], from = Date.now() - hours * 3600e3, next;
    try {
      var nodes = ((await getJson('/api/monitor')).nodes || []);
      var runs = [], notes = [], down = nodes.filter(function (n) { return !n.ok; }).map(function (n) { return n.name; });
      await Promise.all(nodes.filter(function (n) { return n.ok; }).map(async function (n) {
        try {
          var d = await getJson('/api/monitor/activity?node=' + encodeURIComponent(n.url) + '&hours=' + hours);
          var name = d.node || n.name;
          (d.runs || []).forEach(function (r) { runs.push(Object.assign({}, r, { node: name, nodeUrl: n.url })); });
          if ((d.runs || []).length >= ACT_CAP) notes.push(name + ' sent only its newest ' + ACT_CAP + ' runs of this period.');
          // A machine older than #1429 keeps its window to seven days.
          if (d.since && d.since - from > 3600e3) notes.push(name + ' sent only its runs since ' + stamp(d.since) + '.');
        } catch (e) { down.push(n.name); }
      }));
      if (down.length) notes.unshift(down.join(', ') + (down.length === 1 ? ' does' : ' do') + ' not answer: its runs are missing.');
      runs.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
      next = { runs: runs, notes: notes };
    } catch (e) {
      next = { error: String(e && e.message || e), runs: had && had.runs, notes: had && had.notes };
    }
    S.acts[k] = next;
    if (S.page === 'activity') render();
  }
  function actSet(key, value) {
    S.act[key] = value;
    writeHash();
    render();
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target, id = t && t.id;
    if (id === 'act-agent' || id === 'act-project' || id === 'act-result') actSet(id.slice(4), t.value);
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act-period],[data-act-agent],[data-act-all],[data-act-row]');
    if (!t) return;
    if (t.hasAttribute('data-act-period')) actSet('period', t.getAttribute('data-act-period'));
    else if (t.hasAttribute('data-act-agent')) actSet('agent', t.getAttribute('data-act-agent'));
    else if (t.hasAttribute('data-act-all')) actSet('agent', '');
    else {
      // A tap on the row opens its run, as the title link does.
      if (ev.target.closest('a,button,select')) return;
      if (window.getSelection && String(window.getSelection())) return;
      var a = t.querySelector('.wac__t');
      if (a) location.hash = a.getAttribute('href');
    }
  });
`

export const WALL_ACTIVITY_CSS = `
/* Activity (#1429) */
.wac__bar { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wac__bar label { display: inline-flex; gap: 4px; align-items: center; }
.wac__bar select { font: inherit; background: var(--ax-surface); color: var(--ax-text); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 4px 10px; max-width: 160px; }
.wac__seg { display: inline-flex; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); overflow: hidden; }
.wac__seg button { font: inherit; font-weight: 600; background: none; border: 0; color: var(--ax-muted); padding: 4px 12px; cursor: pointer; }
.wac__seg button.is-on { background: var(--ax-text); color: var(--ax-bg); }
.wac__tl { margin-left: auto; color: var(--ax-accent); font-weight: 600; text-decoration: none; }
.wac__tl:hover { text-decoration: underline; }
.wac__note { padding: 8px 16px 0; }
.wac__empty { padding: 32px 16px; text-align: center; }
.wac__list { margin-top: 6px; border-top: 1px solid var(--ax-border); }
.wac { cursor: pointer; }
.wac .av { cursor: default; }
.wac .wp__title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wac__t { color: inherit; text-decoration: none; }
.wac__t:hover { text-decoration: underline; }
.wac__t:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; border-radius: 2px; }
.wac .wp__meta span { white-space: nowrap; }
.wpf__tabs { display: flex; border-top: 1px solid var(--ax-border); margin-top: 12px; }
.wpf__tabs a, .wpf__tabs button { flex: 1; text-align: center; font: inherit; font-weight: 600; background: none; border: 0; border-bottom: 3px solid transparent; color: var(--ax-muted); padding: 12px 8px 9px; cursor: pointer; text-decoration: none; }
.wpf__tabs .is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wpf__tabs a:hover, .wpf__tabs button:hover { background: var(--ax-surface); }
@media (max-width: 640px) {
  .wac__bar label { flex: 1 1 45%; display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
  .wac__bar select { max-width: none; width: 100%; }
  .wac__tl { margin-left: 0; }
}
`
