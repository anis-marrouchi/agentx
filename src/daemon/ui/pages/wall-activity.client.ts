// --- Wall Activity page, browser side (#1429, design #1451 frame 3) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), stamp(), shortTime(), avatar(), nameOf(), uniq(), money(), dur(),
// wallTaskHref(), getJson(), profileHtml() and OTHER.
//
// The agents' runs, newest first, in the Wall's look (#page=activity): one
// row per run with the agent, machine and time, what it worked on, its
// outcome, what started it, how long it took, its cost and its project.
// Selecting a row opens it in place (what was asked, where it ran, its
// review findings) with a link to the run's Task page. Outcome tabs and
// the agent, project and source filters and the period live in the hash
// as a-result, a-agent, a-project, a-source and a-period, so a view is a
// link. With an agent picked, the agent's profile heads the page with its
// Activity tab on: that is the profile's Activity tab, in place of the
// classic history page. The side column sums up the period.
//
// Reads the same endpoints the classic /activity Timeline reads:
// /api/monitor for the machines, then /api/monitor/activity per machine.
// No new counting: a run's cost is the one its trace stored, and a run
// with none shows "–", not $0. Nothing here writes.

import { HUB_NAME } from "../hub-name"

export const WALL_ACTIVITY_SCRIPT = String.raw`
  // --- Activity (#1429): every run, newest first ---
  var ACT_PERIODS = [['24h', '24 h', 24], ['7d', '7 d', 168], ['30d', '30 d', 720]];
  var ACT_RESULTS = [['done', 'Done'], ['failed', 'Failed'], ['running', 'Running'], ['stopped', 'Stopped']];
  /** What started a run, from its channel: filter value, label, "from …" text. */
  var ACT_SOURCES = [['jobs', 'Jobs', 'a job'], ['workflows', 'Workflows', 'a workflow'], ['wall', '${HUB_NAME} posts', 'a post on the ${HUB_NAME}'], ['messages', 'Messages', 'a message']];
  /** The hash keys of the Activity filters, and their S.act field. */
  var ACT_KEYS = [['a-agent', 'agent'], ['a-project', 'project'], ['a-result', 'result'], ['a-source', 'source'], ['a-period', 'period']];
  /** The most runs one machine sends for a window (session-monitor.ts). */
  var ACT_CAP = 400;
  S.act = { agent: '', project: '', result: '', source: '', period: '24h' };
  /** Runs read per period: { loading, runs, marks, notes, error }. */
  S.acts = {};
  /** The run opened in place, by id. */
  S.actOpen = '';
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
  var ACT_BADGE = { done: 'is-mute', failed: 'ax-badge--err', stopped: 'is-mute', running: 'ax-badge--live' };
  function actSource(r) {
    var ch = String(r.channel || '');
    if (ch === 'cron') return 'jobs';
    if (/^workflow/.test(ch) || /^workflow:/.test(String(r.agentId || ''))) return 'workflows';
    if (ch === 'wall') return 'wall';
    return 'messages';
  }
  /** "from a job", "from a message on telegram, by Dana". */
  function actFrom(r) {
    var s = actSource(r), src = ACT_SOURCES.find(function (k) { return k[0] === s; });
    var on = s === 'messages' && r.channel ? ' on ' + r.channel : '';
    return 'from ' + src[2] + on + (r.person ? ', by ' + r.person : '');
  }
  /** The Wall's post for each run it knows of, by task id. */
  function actPosts() {
    var by = {};
    ((S.data && S.data.posts) || []).forEach(function (p) {
      if (p.lastRun && p.lastRun.taskId) by[p.lastRun.taskId] = p;
      if (p.result && p.result.taskId) by[p.result.taskId] = p;
    });
    return by;
  }
  /** Each run with what the page shows of it: title, project, result, source. */
  function actRows() {
    var got = S.acts[S.act.period];
    if (!got || !got.runs) return null;
    var posts = actPosts();
    return got.runs.map(function (r) {
      var p = posts[r.id];
      var ask = String(r.preview || '').split('\n')[0].trim();
      return { run: r, post: p || null, title: p ? p.headline : ask, project: (p && p.project) || r.project || '', result: actResult(r.status), source: actSource(r) };
    });
  }
  /** Does a row pass the filters? skip names one filter to leave out (for tab counts). */
  function actMatch(x, f, skip) {
    if (f.agent && x.run.agentId !== f.agent) return false;
    if (f.project && (f.project === OTHER ? x.project : x.project !== f.project)) return false;
    if (f.source && x.source !== f.source) return false;
    if (skip !== 'result' && f.result && x.result !== f.result) return false;
    return true;
  }
  /** How long a run took; still running, how long so far. */
  function actDur(r) {
    if (r.durationMs != null) return dur(r.durationMs);
    return actResult(r.status) === 'running' && r.startedAt ? dur(Date.now() - r.startedAt) + ' so far' : '–';
  }
  function actCost(r) { return typeof r.costUsd === 'number' ? money(r.costUsd) : '–'; }
  function actLabel(result) { return (ACT_RESULTS.find(function (k) { return k[0] === result; }) || [0, result])[1]; }
  function actHref(x) {
    var r = x.run;
    return wallTaskHref({ id: r.id, channel: r.channel, message: r.preview, startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : '' }, r.agentId, r.nodeUrl, x.result !== 'running');
  }
  /** The run opened in place: what was asked, where, its review findings, links. */
  function actOpenHtml(x) {
    var r = x.run, got = S.acts[S.act.period] || {};
    var marks = ((got.marks || {})[r.id] || []);
    var res = x.result === 'failed' ? '<dd class="wac__err">Failed' + (r.durationMs != null ? ' after ' + esc(dur(r.durationMs)) : '') + '. The Task page has what it said.</dd>'
      : x.result === 'running' ? '<dd>Still running, ' + esc(actDur(r)) + '.</dd>'
      : '<dd>' + esc(actLabel(x.result)) + (r.durationMs != null ? ' in ' + esc(dur(r.durationMs)) : '') + '.</dd>';
    var where = [r.node, x.source === 'jobs' ? 'scheduled job' : r.channel, r.chatId && x.source !== 'jobs' ? r.chatId : ''].filter(Boolean).map(esc).join(' · ');
    return '<div class="wac__open">' +
      '<dl class="wac__kv"><dt>Result</dt>' + res +
        '<dt>Asked</dt><dd class="wac__ask">' + (r.preview ? esc(r.preview) : '<i>No request recorded</i>') + '</dd>' +
        '<dt>Where</dt><dd>' + (where || '–') + '</dd>' +
        '<dt>Review</dt><dd>' + (marks.length ? '<ul class="wac__marks">' + marks.map(function (m) { return '<li><b>' + esc(m.kind) + '</b> ' + esc(m.text) + '</li>'; }).join('') + '</ul>' : '<span class="wac__muted">No review findings for this run</span>') + '</dd></dl>' +
      '<div class="wac__links"><a class="ax-btn ax-btn--ghost" href="' + esc(actHref(x)) + '">Open the run</a>' +
        (x.source === 'jobs' ? '<a class="ax-btn ax-btn--ghost" href="#status=open&amp;view=jobs">Jobs</a>' : '') +
        (S.act.agent ? '' : '<button type="button" class="ax-btn ax-btn--ghost" data-act-agent="' + esc(r.agentId) + '">' + esc(nameOf(r.agentId)) + '\'s runs</button>') +
      '</div></div>';
  }
  function actRowHtml(x, multi) {
    var r = x.run, open = S.actOpen === r.id, mine = !!S.act.agent;
    var badge = '<span class="ax-badge wac__badge ' + ACT_BADGE[x.result] + '">' + esc(actLabel(x.result)) + '</span>';
    var when = r.startedAt ? shortTime(r.startedAt) : '';
    var meta = [
      '<span title="What started it">' + esc(actFrom(r)) + '</span>',
      '<span title="How long it took">' + esc(actDur(r)) + '</span>',
      '<span title="' + (typeof r.costUsd === 'number' ? 'What it cost' : 'No cost recorded for this run') + '">' + esc(actCost(r)) + '</span>',
      x.project ? '<span title="Project"><b>' + esc(x.project) + '</b></span>' : '',
    ];
    var title = '<a class="wac__t" href="' + esc(actHref(x)) + '" title="Open this run">' + (x.title ? esc(x.title) : '<i>No request recorded</i>') + '</a>';
    // On an agent's own tab the agent is known: the title leads the row.
    var by = mine
      ? '<div class="wp__by wac__by"><b class="wac__tb">' + title + '</b>' + badge + '</div>'
      : '<div class="wp__by wac__by"><button type="button" class="name" data-act-agent="' + esc(r.agentId) + '" title="Only ' + esc(nameOf(r.agentId)) + '\'s runs">' + esc(nameOf(r.agentId)) + '</button>' +
        '<span class="h">' + (multi && r.node ? esc(r.node) + ' · ' : '') + '</span>' + when + badge + '</div>' +
        '<p class="wp__title">' + title + '</p>';
    return '<article class="wp wac' + (x.result === 'failed' ? ' is-failed' : '') + (open ? ' is-open' : '') + (mine ? ' is-mine' : '') + '" data-act-row="' + esc(r.id) + '" data-run-agent="' + esc(r.agentId) + '" aria-expanded="' + open + '">' +
      (mine ? '' : avatar(r.agentId, 'act')) + '<div class="wp__b">' + by +
      '<div class="wp__meta">' + (mine && when ? '<span>' + when + '</span>' : '') + meta.filter(Boolean).join('') + '</div>' +
      (open ? actOpenHtml(x) : '') +
    '</div></article>';
  }
  function actSelect(id, label, values, on, name) {
    return '<select id="' + id + '" class="wac__sel" aria-label="' + label + '"><option value="">' + (label === 'Agent' ? 'All agents' : label === 'Project' ? 'All projects' : 'Any source') + '</option>' + values.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === on ? ' selected' : '') + '>' + esc(name ? name(v) : v) + '</option>';
    }).join('') + '</select>';
  }
  function actSegHtml() {
    var f = S.act;
    return '<span class="wac__seg" role="radiogroup" aria-label="Period">' + ACT_PERIODS.map(function (p) {
      return '<button type="button" role="radio" data-act-period="' + p[0] + '" aria-checked="' + (f.period === p[0]) + '"' + (f.period === p[0] ? ' class="is-on"' : '') + '>' + p[1] + '</button>';
    }).join('') + '</span>';
  }
  /** Outcome tabs: All, Done, Failed (with a count), Running, Stopped. */
  function actTabsHtml(rows) {
    var f = S.act, base = (rows || []).filter(function (x) { return actMatch(x, f, 'result'); });
    var tabs = [['', 'All']].concat(ACT_RESULTS);
    return '<div class="ax-wall__views wac__tabs" role="tablist" aria-label="Outcome">' + tabs.map(function (k) {
      var on = f.result === k[0], n = k[0] === 'failed' ? base.filter(function (x) { return x.result === 'failed'; }).length : 0;
      return '<button type="button" role="tab" data-act-result="' + k[0] + '" aria-selected="' + on + '"' + (on ? ' class="is-on"' : '') + '>' + k[1] + (n ? ' <b class="wac__n">' + n + '</b>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function actBarHtml(rows) {
    var f = S.act, all = rows || [];
    var agents = uniq(all.map(function (x) { return x.run.agentId; }).concat(f.agent ? [f.agent] : []));
    var projects = uniq(all.map(function (x) { return x.project; }).filter(Boolean).concat(f.project && f.project !== OTHER ? [f.project] : []));
    if (f.project === OTHER || all.some(function (x) { return !x.project; })) projects.push(OTHER);
    if (f.agent) {
      // The agent's tab: All or Failed, and the period.
      var failed = all.filter(function (x) { return actMatch(x, f, 'result') && x.result === 'failed'; }).length;
      return '<div class="wac__bar" role="group" aria-label="Filters"><button type="button" class="wac__chip' + (f.result ? '' : ' is-on') + '" data-act-result="">All</button>' +
        '<button type="button" class="wac__chip' + (f.result === 'failed' ? ' is-on' : '') + '" data-act-result="failed">Failed' + (failed ? ' <b>' + failed + '</b>' : '') + '</button>' + actSegHtml() + '</div>';
    }
    return '<div class="wac__bar" role="group" aria-label="Filters">' +
      actSelect('act-agent', 'Agent', agents, f.agent, nameOf) +
      actSelect('act-project', 'Project', projects, f.project, function (v) { return v === OTHER ? 'Other (no project)' : v; }) +
      actSelect('act-source', 'Started by', ACT_SOURCES.map(function (k) { return k[0]; }), f.source, function (v) { return ACT_SOURCES.find(function (k) { return k[0] === v; })[1]; }) +
      actSegHtml() +
    '</div>';
  }
  function actFiltered() { var f = S.act; return !!(f.project || f.result || f.source); }
  function actSkeleton() {
    var one = '<div class="wac__skel" aria-hidden="true"><span class="av wac__skav"></span><span class="wac__skl"><i style="width: 45%"></i><i style="width: 80%"></i></span></div>';
    return '<div class="wac__list" aria-busy="true"><p class="ax-wall__empty wac__sr">Loading the runs…</p>' + one + one + one + '</div>';
  }
  function activityPageHtml() {
    loadActivity(false);
    var f = S.act, got = S.acts[f.period] || {}, rows = actRows(), per = actPeriod(f.period)[1];
    var head = f.agent ? '<div class="ax-wall__profile">' + profileHtml(f.agent, 'activity') + '</div>' : '';
    var notes = (got.notes || []).map(function (n) { return '<p class="wac__banner is-warn" role="status">' + esc(n) + '</p>'; }).join('');
    var top = head + (f.agent ? '' : actTabsHtml(rows)) + actBarHtml(rows);
    if (got.error && !rows) return top + '<p class="wac__banner is-err" role="alert">Could not read the runs: ' + esc(got.error) + '</p>' +
      '<div class="ax-wall__empty wac__empty"><button type="button" class="ax-btn ax-btn--ghost" data-act-retry>Try again</button></div>';
    if (!rows) return top + actSkeleton();
    var shown = rows.filter(function (x) { return actMatch(x, f); });
    var multi = uniq(rows.map(function (x) { return x.run.node; })).length > 1;
    var failed = shown.filter(function (x) { return x.result === 'failed'; }).length;
    var time = shown.reduce(function (a, x) { return a + (x.run.durationMs || 0); }, 0);
    var priced = shown.filter(function (x) { return typeof x.run.costUsd === 'number'; });
    var cost = priced.reduce(function (a, x) { return a + x.run.costUsd; }, 0);
    var count = f.agent
      ? '<p class="ax-wall__count wac__note">' + shown.length + (shown.length === 1 ? ' run' : ' runs') + (failed ? ' · ' + failed + ' failed' : '') + ' · ' + esc(dur(time)) + ' of agent time' + (priced.length ? ' · ' + esc(money(cost)) : '') + '</p>'
      : '<p class="ax-wall__count wac__note">' + shown.length + (shown.length === 1 ? ' run' : ' runs') + (failed ? ', ' + failed + ' failed' : '') +
        ' in the last ' + esc(per) + (shown.length !== rows.length ? ' (of ' + rows.length + ')' : '') + ', newest first</p>';
    var clear = '<button type="button" class="ax-btn ax-btn--ghost" data-act-clear>Clear filters</button>';
    var empty = !rows.length
      ? '<h3>Nothing ran in this window</h3><p>Nothing ran in the last ' + esc(per) + '.' + (f.period !== '30d' ? ' Try ' + (f.period === '24h' ? '7 days' : '30 days') + (actFiltered() ? ', or clear the filters.' : '.') : '') + '</p>' + (actFiltered() ? clear : '')
      : '<h3>No runs match these filters.</h3><p>' + rows.length + (rows.length === 1 ? ' run' : ' runs') + ' in the last ' + esc(per) + ' do not match.</p>' + clear;
    return top + notes + count +
      (shown.length ? '<div class="wac__list">' + shown.map(function (x) { return actRowHtml(x, multi); }).join('') + '</div>' : '<div class="ax-wall__empty wac__empty">' + empty + '</div>');
  }
  /** The side column: the period in numbers, then runs per agent. */
  function activitySideHtml() {
    var f = S.act, rows = actRows(), per = actPeriod(f.period)[1];
    var map = '<section class="ax-wall__box"><p class="ax-wall__count">The Map and the lane view stay on the classic Activity page for now. <a href="/activity">Open the classic page</a></p></section>';
    if (!rows) return '<section class="ax-wall__box"><h2>Last ' + esc(per) + '</h2><p class="ax-wall__empty">Loading…</p></section>' + map;
    var shown = rows.filter(function (x) { return actMatch(x, f); });
    var failed = shown.filter(function (x) { return x.result === 'failed'; }).length;
    var time = shown.reduce(function (a, x) { return a + (x.run.durationMs || 0); }, 0);
    var priced = shown.filter(function (x) { return typeof x.run.costUsd === 'number'; });
    var cost = priced.reduce(function (a, x) { return a + x.run.costUsd; }, 0), unpriced = shown.length - priced.length;
    var by = {};
    shown.forEach(function (x) { var a = by[x.run.agentId] || (by[x.run.agentId] = { n: 0, failed: 0 }); a.n++; if (x.result === 'failed') a.failed++; });
    var agents = Object.keys(by).sort(function (a, b) { return by[b].n - by[a].n; }).slice(0, 6);
    return '<section class="ax-wall__box"><h2>Last ' + esc(per) + '</h2><div class="wac__kpis">' +
        '<div><b>' + shown.length + '</b><span>runs</span></div>' +
        '<div><b' + (failed ? ' class="is-err"' : '') + '>' + failed + '</b><span>failed</span></div>' +
        '<div><b>' + esc(dur(time)) + '</b><span>agent time</span></div>' +
        '<div><b>' + (priced.length ? esc(money(cost)) : '–') + '</b><span>cost' + (unpriced ? ', ' + unpriced + ' unpriced' : '') + '</span></div>' +
      '</div></section>' +
      (agents.length && !f.agent ? '<section class="ax-wall__box"><h2>By agent</h2><div class="wac__byagent">' + agents.map(function (id) {
        return '<button type="button" data-act-agent="' + esc(id) + '"><span>' + esc(nameOf(id)) + '</span><span class="wac__muted">' + by[id].n + (by[id].n === 1 ? ' run' : ' runs') +
          (by[id].failed ? ' · <span class="is-err">' + by[id].failed + ' failed</span>' : '') + '</span></button>';
      }).join('') + '</div></section>' : '') + map;
  }
  /** Read the period's runs from every machine; again when force is set. */
  async function loadActivity(force) {
    var k = S.act.period, had = S.acts[k];
    if (had && (had.loading || !force)) return;
    S.acts[k] = { loading: true, runs: had && had.runs, marks: had && had.marks, notes: had && had.notes };
    var hours = actPeriod(k)[2], from = Date.now() - hours * 3600e3, next;
    try {
      var nodes = ((await getJson('/api/monitor')).nodes || []);
      var runs = [], marks = {}, notes = [], down = nodes.filter(function (n) { return !n.ok; }).map(function (n) { return n.name; });
      await Promise.all(nodes.filter(function (n) { return n.ok; }).map(async function (n) {
        try {
          var d = await getJson('/api/monitor/activity?node=' + encodeURIComponent(n.url) + '&hours=' + hours);
          var name = d.node || n.name;
          (d.runs || []).forEach(function (r) { runs.push(Object.assign({}, r, { node: name, nodeUrl: n.url })); });
          (d.marks || []).forEach(function (m) { (marks[m.runId] || (marks[m.runId] = [])).push(m); });
          if ((d.runs || []).length >= ACT_CAP) notes.push(name + ' sent only its newest ' + ACT_CAP + ' runs of this period.');
          // A machine older than #1429 keeps its window to seven days.
          if (d.since && d.since - from > 3600e3) notes.push(name + ' sent only its runs since ' + stamp(d.since) + '.');
        } catch (e) { down.push(n.name); }
      }));
      if (down.length) notes.unshift(down.join(', ') + (down.length === 1 ? ' does' : ' do') + ' not answer: its runs are missing.');
      runs.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
      next = { runs: runs, marks: marks, notes: notes };
    } catch (e) {
      next = { error: String(e && e.message || e), runs: had && had.runs, marks: had && had.marks, notes: had && had.notes };
    }
    S.acts[k] = next;
    if (S.page === 'activity') render();
  }
  function actSet(key, value) {
    S.act[key] = value;
    S.actOpen = '';
    writeHash();
    render();
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target, id = t && t.id;
    if (id === 'act-agent' || id === 'act-project' || id === 'act-source') actSet(id.slice(4), t.value);
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act-period],[data-act-agent],[data-act-result],[data-act-all],[data-act-clear],[data-act-retry],[data-act-row]');
    if (!t) return;
    if (t.hasAttribute('data-act-period')) actSet('period', t.getAttribute('data-act-period'));
    else if (t.hasAttribute('data-act-agent')) actSet('agent', t.getAttribute('data-act-agent'));
    else if (t.hasAttribute('data-act-result')) actSet('result', t.getAttribute('data-act-result'));
    else if (t.hasAttribute('data-act-all')) actSet('agent', '');
    else if (t.hasAttribute('data-act-clear')) { S.act.project = ''; S.act.result = ''; S.act.source = ''; actSet('period', S.act.period); }
    else if (t.hasAttribute('data-act-retry')) { loadActivity(true); render(); }
    else {
      // A tap on the row opens it in place; the title link opens its run.
      if (ev.target.closest('a,button,select,.wac__open')) return;
      if (window.getSelection && String(window.getSelection())) return;
      var id = t.getAttribute('data-act-row');
      S.actOpen = S.actOpen === id ? '' : id;
      render();
    }
  });
`

export const WALL_ACTIVITY_CSS = `
/* Activity (#1429, design #1451 frame 3) */
.wac__tabs { border-bottom: 1px solid var(--ax-border); }
.wac__n { margin-left: 4px; font-size: var(--ax-fs-xs); font-weight: 700; padding: 0 6px; line-height: 20px; border-radius: var(--ax-radius-pill); background: var(--ax-amber-t); color: var(--ax-amber-ink); font-variant-numeric: tabular-nums; }
.wac__bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wac__sel { font: inherit; font-size: var(--ax-fs-xs); background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 4px 10px; max-width: 170px; min-height: 30px; }
.wac__chip { font: inherit; font-size: var(--ax-fs-xs); background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 4px 12px; min-height: 30px; cursor: pointer; }
.wac__chip.is-on { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wac__seg { margin-left: auto; display: inline-flex; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); overflow: hidden; }
.wac__seg button { font: inherit; font-weight: 600; background: none; border: 0; color: var(--ax-muted); padding: 4px 12px; min-height: 30px; cursor: pointer; }
.wac__seg button.is-on { background: var(--ax-text); color: var(--ax-bg); }
.wac__banner { margin: 0; padding: 10px 16px; font-size: var(--ax-fs-sm); border-bottom: 1px solid var(--ax-border); }
.wac__banner.is-warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.wac__banner.is-err { background: var(--ax-red-t); color: var(--ax-red-ink); }
.wac__note { padding: 8px 16px; border-bottom: 1px solid var(--ax-border); }
.wac__empty { padding: 40px 24px; text-align: center; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.wac__empty h3 { margin: 0; font-size: 22px; font-weight: 800; color: var(--ax-text); }
.wac__empty p { margin: 0; max-width: 380px; }
.wac__list { border-top: 0; }
.wac { cursor: pointer; }
.wac.is-open { background: var(--ax-surface); }
.wac .av { cursor: default; }
.wac__by { align-items: center; }
.wac__badge { margin-left: auto; }
.wac__badge.is-mute { background: var(--ax-surface-2); color: var(--ax-muted); }
.wac .wp__title, .wac__tb { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wac__tb { font-weight: 700; min-width: 0; color: var(--ax-text); }
.wac__t { color: inherit; text-decoration: none; }
.wac__t:hover { text-decoration: underline; }
.wac__t:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; border-radius: 2px; }
.wac .wp__meta span { white-space: nowrap; }
.wac__open { margin-top: 8px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; cursor: default; }
.wac__kv { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--ax-fs-sm); }
.wac__kv dt { color: var(--ax-muted); }
.wac__kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.wac__ask { white-space: pre-line; max-height: 9.5em; overflow: auto; }
.wac__err, .wac__kpis .is-err, .wac__byagent .is-err { color: var(--ax-red-ink); }
.wac__marks { margin: 0; padding-left: 18px; }
.wac__muted { color: var(--ax-muted); }
.wac__links { display: flex; flex-wrap: wrap; gap: 8px; }
.wac__links .ax-btn { font-size: var(--ax-fs-xs); padding: 4px 12px; }
.wac__skel { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--ax-border); }
.wac__skav { background: var(--ax-surface-2); }
.wac__skl { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
.wac__skl i { display: block; height: 12px; border-radius: 6px; background: var(--ax-surface-2); }
.wac__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.wac__side { display: none; }
.ax-wall__aside.is-act > :not(.wac__side) { display: none; }
.ax-wall__aside.is-act > .wac__side { display: block; }
.wac__kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.wac__kpis div { display: flex; flex-direction: column; gap: 2px; }
.wac__kpis b { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--ax-text); }
.wac__kpis span { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wac__byagent { display: flex; flex-direction: column; gap: 2px; }
.wac__byagent button { display: flex; gap: 8px; justify-content: space-between; font: inherit; font-size: var(--ax-fs-sm); background: none; border: 0; color: var(--ax-text); padding: 6px 0; cursor: pointer; text-align: left; }
.wac__byagent button:hover > span:first-child { text-decoration: underline; }
.wpf__tabs { display: flex; border-top: 1px solid var(--ax-border); margin-top: 12px; }
.wpf__tabs a, .wpf__tabs button { flex: 1; text-align: center; font: inherit; font-weight: 600; background: none; border: 0; border-bottom: 3px solid transparent; color: var(--ax-muted); padding: 12px 8px 9px; cursor: pointer; text-decoration: none; }
.wpf__tabs .is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.wpf__tabs a:hover, .wpf__tabs button:hover { background: var(--ax-surface); }
/* Feed or Timeline beside the title; Timeline is the classic lane view. */
.ax-wall__switch a { font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-muted); padding: 4px 12px; text-decoration: none; }
.ax-wall__switch a:hover { color: var(--ax-text); }
/* Under 1180 px the side column stacks over the page: the period sums stay
   in the count line instead. */
@media (max-width: 1180px) {
  .ax-wall__aside.is-act > .wac__side { display: none; }
}
@media (max-width: 640px) {
  .wac__bar { padding: 8px 12px; }
  .wac__sel { flex: 1 1 40%; max-width: none; }
  .wac__seg { margin-left: 0; }
  .wac__chip ~ .wac__seg { margin-left: auto; }
  .wac__kv { grid-template-columns: 70px minmax(0, 1fr); }
}
`
