// --- Wall Workflows page, browser side (#1445, design #1451 frame 7) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), stamp(), when(), ago(), nameOf(), uniq(), getJson(), headers(),
// writeHash(), render() and DAY.
//
// One row per workflow (#page=workflows): its name, what starts it in
// words, its agents and project, the last seven runs as squares, its
// state, and an on/off switch. Tabs All, Running, Failed and Off, a filter
// box and a project filter; all of them, and the open workflow, live in
// the hash (w-tab, w-q, w-project, w-open), so a view is a link. A
// workflow that is off and has not run for 30 days "looks stale", as Jobs
// does. Opened, a workflow shows its last run step by step (who did each
// step, how long it took, where it stopped) with Run again, Open in the
// editor (the Wall's editor page, #1524, wall-editor.client.ts) and All runs (the
// classic page, which keeps the run drawer, Follow-ups and the "Every task
// in a workflow" setting).
//
// Reads: GET /api/workflows (this node's definitions) and
// /api/workflows/runs?summary=1 (every machine's runs, slim), then one run
// in full when a workflow is opened; the side column reads
// /api/workflows/follow-ups and /api/workflows/required.
//
// Writes, the owner's (#1454): the switch saves the workflow with its
// state flipped (GET then PUT /api/workflows/<id>, as the editor saves);
// Run… opens a dialog with the trigger's inputs as a form (JSON folded),
// one line on what will happen, then Start the run, which posts
// /workflows/<id>/run as the classic Run button does. Run again sends the
// last run's input again. On a phone the switches and Run buttons are not
// drawn; the page says only the owner can start, turn on or turn off a
// workflow.
//
// renderWorkflows(page) is the one call the Wall's render() makes;
// refreshWorkflows() is called from the Wall's own load().

import { HUB_NAME } from "../hub-name"

export const WALL_WORKFLOWS_SCRIPT = String.raw`
  var WFP = { defs: null, runs: null, capped: false, error: '', note: '', bad: false, detail: {}, fu: null, req: null, busy: {}, dlg: null, loading: false };
  S.wfv = { tab: '', q: '', project: '', open: '' };
  /** Off this long with no run: "looks stale", as Jobs (#1355). */
  var WF_STALE_DAYS = 30;
  /** The runs read for the page: enough for the squares and the stale rule. */
  var WF_RUNS = 500;
  var WF_TABS = [['', 'All'], ['running', 'Running'], ['failed', 'Failed'], ['off', 'Off']];
  var WF_KEYS = [['w-tab', 'tab'], ['w-q', 'q'], ['w-project', 'project'], ['w-open', 'open']];
  var WF_HOOK = { 'on:gitlab-issue': 'When a GitLab issue changes', 'on:gitlab-mr': 'When a GitLab merge request changes', 'on:gitlab-note': 'When someone comments on GitLab', 'on:gitlab-pipeline': 'When a GitLab pipeline ends' };
  var WF_DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  function wfRead(q) { WF_KEYS.forEach(function (k) { S.wfv[k[1]] = q.get(k[0]) || ''; }); }
  function wfWrite(q) { WF_KEYS.forEach(function (k) { if (S.wfv[k[1]]) q.set(k[0], S.wfv[k[1]]); }); }

  // --- What starts it, in words ---
  function wfTrigger(wf) { return (wf.nodes || []).filter(function (n) { return n && /^trigger\./.test(n.type); })[0] || null; }
  function wfIsManual(wf) { var t = wfTrigger(wf); return !!t && t.type === 'trigger.manual'; }
  function wfP2(n) { return (n < 10 ? '0' : '') + n; }
  /** A cron spec in words when it is a common one, else the spec itself. */
  function wfCron(spec) {
    var f = String(spec || '').trim().split(/\s+/);
    if (f.length !== 5) return 'On a schedule';
    var every = /^\*\/(\d+)$/.exec(f[0]);
    if (every && f.slice(1).join(' ') === '* * * *') return 'Every ' + every[1] + ' min';
    if (/^\d+$/.test(f[0]) && f[1] === '*' && f.slice(2).join(' ') === '* * *') return 'Every hour';
    if (!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[2] !== '*' || f[3] !== '*') return 'On a schedule (' + f.join(' ') + ')';
    var at = ' at ' + wfP2(+f[1]) + ':' + wfP2(+f[0]);
    if (f[4] === '*') return 'Every day' + at;
    if (f[4] === '1-5') return 'Weekdays' + at;
    if (/^[0-7]$/.test(f[4])) return WF_DAYS[+f[4] % 7] + at;
    return 'On a schedule (' + f.join(' ') + ')';
  }
  function wfStarts(wf) {
    var t = wfTrigger(wf), c = (t && t.config) || {};
    if (!t) return 'Nothing starts it';
    if (t.type === 'trigger.manual') return 'Started by hand';
    if (t.type === 'trigger.cron') return wfCron(c.spec);
    if (t.type === 'trigger.hook') return WF_HOOK[c.event] || 'When ' + String(c.event || 'something').replace(/^on:/, '').replace(/-/g, ' ') + ' happens';
    if (t.type === 'trigger.form') return 'From a form';
    if (t.type === 'trigger.poll') return 'When something new turns up';
    return 'When a message arrives' + (c.source ? ' by ' + c.source : '');
  }
  function wfAgents(wf) {
    return uniq((wf.nodes || []).filter(function (n) { return n && n.type === 'agent' && n.config && n.config.agentId; }).map(function (n) { return String(n.config.agentId); }));
  }
  /** A step's name from its id: read_ticket reads "Read ticket". */
  function wfStepName(node, id) {
    var s = String((node && node.config && (node.config.title || node.config.label)) || id || 'step').replace(/[_-]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function wfDur(ms) {
    var s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
    return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  function wfClock(ms) { var d = new Date(ms); return wfP2(d.getHours()) + ':' + wfP2(d.getMinutes()); }

  // --- Runs and state ---
  function wfRunsOf(id) { return (WFP.runs || []).filter(function (r) { return r.workflowId === id; }); }
  /** off, held, running, waiting, failed, done, stopped or never. */
  function wfState(wf, runs) {
    if (wf.state === 'disabled') return 'off';
    if (wf.state === 'quarantined') return 'held';
    if (runs.some(function (r) { return r.status === 'running'; })) return 'running';
    if (runs.some(function (r) { return r.status === 'paused'; })) return 'waiting';
    var last = runs[0];
    if (!last) return 'never';
    return last.status === 'failed' ? 'failed' : last.status === 'canceled' ? 'stopped' : 'done';
  }
  var WF_CHIP = {
    off: ['Off', 'chip--ghost'], held: ['Held', 'chip--warn'], running: ['Running', 'chip--done'], waiting: ['Waiting', 'chip--warn'],
    failed: ['Last run failed', 'chip--err'], done: ['Done', 'chip--ghost'], stopped: ['Stopped', 'chip--ghost'], never: ['Never run', 'chip--ghost'],
  };
  function wfTab(st) { return st === 'running' || st === 'waiting' ? 'running' : st === 'failed' ? 'failed' : st === 'off' || st === 'held' ? 'off' : ''; }
  /** Off and quiet for 30 days. Unknown when the runs read was cut short. */
  function wfStale(wf, runs) {
    if (wf.state !== 'disabled') return null;
    var last = runs[0] ? Date.parse(runs[0].updatedAt) : 0;
    if (last && Date.now() - last < WF_STALE_DAYS * DAY) return null;
    if (!last && WFP.capped) return null;
    return last ? 'no run for ' + Math.floor((Date.now() - last) / DAY) + ' days' : 'never run';
  }
  function wfSquares(runs) {
    var cells = runs.slice(0, 7).reverse().map(function (r) {
      var cls = r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'running' ? 'run' : r.status === 'paused' ? 'wait' : 'idle';
      return '<span class="is-' + cls + '" title="' + esc(stamp(Date.parse(r.updatedAt)) + ': ' + r.status) + '"></span>';
    });
    if (!cells.length) return '';
    return '<span class="wjb__sq wwf__sq" role="img" aria-label="Last ' + cells.length + (cells.length === 1 ? ' run' : ' runs') + ': ' + esc(runs.slice(0, 7).reverse().map(function (r) { return r.status; }).join(', ')) + '">' + cells.join('') + '</span>';
  }
  /** Where a run stopped, one line: "09:02 · Quill was paused at "Write the reply draft"". */
  function wfStopLine(wf, run) {
    var h = (run.history || []).filter(function (e) { return e.status === 'failed' || e.status === 'timeout'; }).pop();
    if (!h) return '';
    var node = (wf.nodes || []).filter(function (n) { return n.id === h.nodeId; })[0];
    var why = h.note ? String(h.note).replace(/\s+/g, ' ').slice(0, 140) : h.status === 'timeout' ? 'it ran out of time' : 'it failed';
    return wfClock(Date.parse(run.updatedAt)) + ' · stopped at "' + wfStepName(node, h.nodeId) + '": ' + why;
  }

  // --- Reads ---
  async function loadWorkflows() {
    if (WFP.loading) return;
    WFP.loading = true;
    try {
      var got = await Promise.all([getJson('/api/workflows'), getJson('/api/workflows/runs?summary=1&limit=' + WF_RUNS)]);
      WFP.defs = got[0].workflows || [];
      WFP.runs = (got[1].runs || []).slice().sort(function (a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt); });
      WFP.capped = WFP.runs.length >= WF_RUNS;
      WFP.error = '';
    } catch (e) { WFP.error = e.message; }
    WFP.loading = false;
    if (S.wfv.open) wfLoadRun(S.wfv.open);
    render();
  }
  /** The side column: best effort, each says so when it cannot be read. */
  function loadWorkflowSide() {
    WFP.side = true;
    getJson('/api/workflows/follow-ups').then(function (d) { WFP.fu = d; render(); }).catch(function (e) { WFP.fu = { error: e.message }; render(); });
    getJson('/api/workflows/required').then(function (d) { WFP.req = d; render(); }).catch(function (e) { WFP.req = { error: e.message }; render(); });
  }
  /** From the Wall's load(): the whole page when it is open, else only the nav count. */
  function refreshWorkflows() {
    if (S.page === 'workflows') { loadWorkflows(); loadWorkflowSide(); return; }
    getJson('/api/workflows').then(function (d) { WFP.defs = d.workflows || []; render(); }).catch(function () { /* the page says so when opened */ });
  }
  /** The last run of a workflow, in full, for its steps. */
  function wfLoadRun(id) {
    var last = wfRunsOf(id)[0];
    if (!last) return;
    var had = WFP.detail[id];
    if (had && had.run && had.run.id === last.id && had.run.updatedAt === last.updatedAt) return;
    getJson('/api/workflows/runs/' + encodeURIComponent(last.id)).then(function (d) {
      WFP.detail[id] = { run: d.run || d };
      render();
    }).catch(function (e) { WFP.detail[id] = { error: e.message }; render(); });
  }

  // --- Drawing ---
  function wfStepsHtml(wf, run) {
    var nodes = {}, seen = {};
    (wf.nodes || []).forEach(function (n) { nodes[n.id] = n; });
    // The trigger and the end are not steps anyone took.
    var rows = (run.history || []).filter(function (h) { var t = (nodes[h.nodeId] || {}).type || ''; return !/^trigger\./.test(t) && t !== 'end' && h.status !== 'resumed'; }).map(function (h) {
      seen[h.nodeId] = true;
      var n = nodes[h.nodeId], who = n && n.type === 'agent' && n.config && n.config.agentId ? nameOf(String(n.config.agentId)) : '';
      var bad = h.status === 'failed' || h.status === 'timeout';
      var icon = bad ? 'err' : h.status === 'paused' ? 'wait' : h.status === 'skipped' ? 'skip' : 'ok';
      var tail = bad ? 'stopped: ' + (h.note ? String(h.note).replace(/\s+/g, ' ').slice(0, 200) : h.status === 'timeout' ? 'it ran out of time' : 'it failed')
        : h.status === 'paused' ? 'waiting' + (h.note ? ': ' + String(h.note).slice(0, 120) : '')
        : h.status === 'skipped' ? 'skipped' : typeof h.durationMs === 'number' ? wfDur(h.durationMs) : '';
      return '<li class="is-' + icon + '"><span class="wwf__ic" aria-hidden="true"></span><span><b>' + esc(wfStepName(n, h.nodeId)) + '</b>' +
        '<small>' + [who, tail].filter(Boolean).map(esc).join(' · ') + '</small><span class="wwf__sr"> (' + esc(bad ? 'failed' : h.status === 'ok' ? 'done' : h.status) + ')</span></span></li>';
    });
    // Steps it did not reach, or is on now.
    (wf.nodes || []).forEach(function (n) {
      if (seen[n.id] || /^trigger\./.test(n.type) || n.type === 'end') return;
      var now = run.status === 'running' && (run.pending || []).indexOf(n.id) >= 0;
      rows.push('<li class="is-' + (now ? 'run' : 'todo') + '"><span class="wwf__ic" aria-hidden="true"></span><span><b>' + esc(wfStepName(n, n.id)) + '</b>' +
        '<small>' + (now ? 'running now' : 'not reached') + '</small></span></li>');
    });
    return rows.length ? '<ol class="wwf__steps">' + rows.join('') + '</ol>' : '<p class="ax-wall__empty">No steps recorded.</p>';
  }
  function wfOpenHtml(wf, runs) {
    var all = '<a class="ax-btn ax-btn--ghost" href="/workflows#' + encodeURIComponent(wf.id) + '">' + (WFP.capped || !runs.length ? 'All runs' : runs.length === 1 ? 'Its 1 run' : 'All ' + runs.length + ' runs') + '</a>';
    var editor = '<a class="ax-btn ax-btn--ghost wwf__ed" href="#page=editor&amp;e-wf=' + encodeURIComponent(wf.id) + '">Open in the editor</a>';
    var again = wf.state === 'active' && runs.length ? '<button type="button" class="ax-btn ax-btn--ghost wwf__own" data-wf-again="' + esc(wf.id) + '"' + (WFP.busy[wf.id] ? ' disabled' : '') + '>Run again</button>' : '';
    var links = '<div class="wwf__links">' + again + editor + all + '</div>';
    if (wf.description) links = '<p class="wwf__desc">' + esc(String(wf.description).slice(0, 400)) + '</p>' + links;
    if (!runs.length) return '<div class="wwf__open"><p class="ax-wall__empty">It has not run yet.</p>' + links + '</div>';
    var d = WFP.detail[wf.id], last = runs[0];
    var head = '<p class="wwf__run"><b>Run at ' + esc(wfClock(Date.parse(last.createdAt))) + '</b> ' + wfChip(wfRunState(last)) +
      ' <small>' + (last.status === 'running' ? 'running for ' + esc(wfDur(Date.now() - Date.parse(last.createdAt)))
        : 'took ' + esc(wfDur(Date.parse(last.updatedAt) - Date.parse(last.createdAt)))) +
      ' · started ' + esc(last.entityRef && last.entityRef.backend === 'manual' ? 'by hand' : wfStarts(wf).replace(/^When/, 'when').replace(/^Started /, '')) +
      (last.homeNode ? ' · on ' + esc(last.homeNode) : '') + '</small></p>';
    var body = !d ? '<p class="ax-wall__empty">Loading the steps…</p>' : d.error ? '<p class="ax-wall__empty">Could not read this run: ' + esc(d.error) + '.</p>' : wfStepsHtml(wf, d.run);
    return '<div class="wwf__open">' + head + body + links + '</div>';
  }
  function wfRunState(r) { return r.status === 'running' ? 'running' : r.status === 'paused' ? 'waiting' : r.status === 'failed' ? 'failed' : r.status === 'canceled' ? 'stopped' : 'done'; }
  function wfChip(st) { var c = WF_CHIP[st]; return '<span class="chip ' + c[1] + '">' + esc(st === 'failed' ? 'Failed' : c[0]) + '</span>'; }
  function wfRowHtml(wf) {
    var runs = wfRunsOf(wf.id), st = wfState(wf, runs), stale = wfStale(wf, runs), open = S.wfv.open === wf.id, c = WF_CHIP[st];
    var agents = wfAgents(wf), on = wf.state === 'active', busy = !!WFP.busy[wf.id];
    var sw = wf.state === 'quarantined' ? '' : '<button type="button" class="wwf__sw wwf__own" role="switch" aria-checked="' + on + '" data-wf-toggle="' + esc(wf.id) + '"' + (busy ? ' disabled' : '') +
      ' aria-label="' + esc((wf.title || wf.id) + ': ' + (on ? 'on' : 'off')) + '"><span>' + (on ? 'On' : 'Off') + '</span><i aria-hidden="true"></i></button>';
    var running = runs.filter(function (r) { return r.status === 'running'; })[0];
    var step = running ? (running.history || []).length : 0;
    var line = st === 'failed' ? wfStopLine(wf, runs[0]) : '';
    var meta = [
      '<span title="What starts it">' + esc(wfStarts(wf)) + '</span>',
      agents.length ? '<span title="Its agents">' + agents.map(function (a) { return esc(nameOf(a)); }).join(', ') + '</span>' : '',
      wf.project ? '<span title="Project">' + esc(wf.project) + '</span>' : '',
      running && step ? '<span>step ' + step + ' of ' + Math.max(step, (wf.nodes || []).filter(function (n) { return !/^trigger\./.test(n.type) && n.type !== 'end'; }).length) + '</span>' : '',
      stale ? '<span class="is-stale">' + esc(stale) + ' · looks stale</span>' : '',
      wfSquares(runs),
    ].filter(Boolean).join('');
    var run = on && !open ? '<button type="button" class="ax-btn wwf__runbtn wwf__own" data-wf-run="' + esc(wf.id) + '"' + (busy ? ' disabled' : '') + '>Run…</button>' : '';
    return '<article class="wwf' + (open ? ' is-open' : '') + (on ? '' : ' is-off') + '" id="wf-' + esc(wf.id) + '">' +
      '<div class="wwf__top"><button type="button" class="wwf__name" data-wf-open="' + esc(wf.id) + '" aria-expanded="' + open + '" aria-controls="wf-body-' + esc(wf.id) + '">' + esc(wf.title || wf.id) + '</button>' +
        '<span class="chip ' + c[1] + (st === 'off' ? ' wwf__offchip' : '') + '"' + (st === 'held' ? ' title="Held: it would clash with another route for the same events. Fix the clash, or turn it on again in the editor."' : '') + '>' + esc(c[0]) + '</span>' + sw + '</div>' +
      '<div class="wp__meta wwf__meta">' + meta + '</div>' +
      (line ? '<p class="wwf__fail">' + esc(line) + '</p>' : '') + run +
      '<div id="wf-body-' + esc(wf.id) + '"' + (open ? '' : ' hidden') + '>' + (open ? wfOpenHtml(wf, runs) : '') + '</div>' +
    '</article>';
  }
  function wfMatch(wf, skipTab) {
    var f = S.wfv;
    if (f.project && (f.project === OTHER ? wf.project : wf.project !== f.project)) return false;
    if (f.q) {
      var hay = [wf.id, wf.title, wf.description, wf.project, wfStarts(wf)].concat(wfAgents(wf).map(nameOf)).join(' ').toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    if (!skipTab && f.tab && wfTab(wfState(wf, wfRunsOf(wf.id))) !== f.tab) return false;
    return true;
  }
  function wfWeek() {
    var since = Date.now() - 7 * DAY, runs = (WFP.runs || []).filter(function (r) { return Date.parse(r.createdAt) >= since; });
    return { n: runs.length, failed: runs.filter(function (r) { return r.status === 'failed'; }).length };
  }
  function workflowsPageHtml() {
    var note = WFP.note ? '<p class="wwf__note' + (WFP.bad ? ' is-bad' : '') + '" role="status">' + esc(WFP.note) + '</p>' : '';
    if (WFP.error && !WFP.runs) return note + '<p class="ax-wall__empty wwf__empty">Could not read the workflows: ' + esc(WFP.error) + '. The rest of the ${HUB_NAME} still works. <button type="button" class="ax-btn ax-btn--ghost" data-wf-retry>Try again</button></p>';
    if (!WFP.defs || !WFP.runs) return '<p class="ax-wall__empty wwf__empty">Loading…</p>';
    var defs = WFP.defs, f = S.wfv, base = defs.filter(function (wf) { return wfMatch(wf, true); });
    var count = function (tab) { return base.filter(function (wf) { return wfTab(wfState(wf, wfRunsOf(wf.id))) === tab; }).length; };
    var tabs = '<div class="ax-wall__views wwf__tabs" role="tablist" aria-label="Show">' + WF_TABS.map(function (t) {
      var n = t[0] && t[0] !== 'off' ? count(t[0]) : 0, sel = f.tab === t[0];
      return '<button type="button" role="tab" data-wf-tab="' + t[0] + '" aria-selected="' + sel + '"' + (sel ? ' class="is-on"' : '') + '>' + t[1] + (n ? ' <b class="wac__n' + (t[0] === 'running' ? ' is-run' : '') + '">' + n + '</b>' : '') + '</button>';
    }).join('') + '</div>';
    var projects = uniq(defs.map(function (wf) { return wf.project; }));
    if (defs.some(function (wf) { return !wf.project; }) && projects.length) projects.push(OTHER);
    var bar = '<div class="wac__bar wwf__bar" role="group" aria-label="Filters">' +
      '<input id="wf-q" class="wwf__q" type="search" placeholder="Filter workflows" aria-label="Filter workflows" value="' + esc(f.q) + '">' +
      (projects.length ? '<select id="wf-project" class="wac__sel" aria-label="Project"><option value="">All projects</option>' + projects.map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === f.project ? ' selected' : '') + '>' + esc(p === OTHER ? 'No project' : p) + '</option>';
      }).join('') + '</select>' : '') + '</div>';
    var owner = '<p class="wwf__owner">Only the owner can start, turn on or turn off a workflow.</p>';
    if (!defs.length) return note + owner + '<div class="ax-wall__empty wwf__empty"><h3>No workflows yet</h3><p>A workflow is a set of steps your agents take, in order, each time something starts it.</p>' +
      '<a class="ax-btn wwf__ed" href="#page=editor&amp;e-new=1">New workflow</a></div>';
    var shown = base.filter(function (wf) { return wfMatch(wf); });
    // Failing and running first, then by name: the one to look at leads.
    var rank = { failed: 0, held: 1, running: 2, waiting: 2, done: 3, stopped: 3, never: 4, off: 5 };
    shown.sort(function (a, b) {
      return rank[wfState(a, wfRunsOf(a.id))] - rank[wfState(b, wfRunsOf(b.id))] || String(a.title || a.id).localeCompare(String(b.title || b.id));
    });
    var list = shown.length ? shown.map(wfRowHtml).join('') : '<div class="ax-wall__empty wwf__empty"><p>No workflow matches.</p><button type="button" class="ax-btn ax-btn--ghost" data-wf-clear>Clear the filters</button></div>';
    return tabs + bar + '<p class="ax-wall__count wac__note">' + esc(wfDefsSummary()) + '</p>' + owner + note + list + '<p class="wwf__phone">The editor opens on a computer; it is not made for a phone.</p>';
  }
  function workflowsSideHtml() {
    var fu = WFP.fu, req = WFP.req, n = 0;
    if (fu && fu.groups) { var ids = {}; fu.groups.forEach(function (g) { (g.rows || []).forEach(function (r) { ids[r.runId] = 1; }); }); n = Object.keys(ids).length; }
    var follow = '<section class="ax-wall__box"><h2>Follow-ups</h2>' + (!fu ? '<p class="ax-wall__empty">Loading…</p>'
      : fu.error ? '<p class="ax-wall__empty">Could not read them: ' + esc(fu.error) + '.</p>'
      : n ? '<p><b>' + n + '</b> ' + (n === 1 ? 'run' : 'runs') + ' started for your requests</p><a href="/workflows">Show them</a>' : '<p class="ax-wall__empty">Nothing is being followed right now.</p>') +
      (fu && fu.unreachable && fu.unreachable.length ? '<p class="ax-wall__count">' + fu.unreachable.length + (fu.unreachable.length === 1 ? ' machine does' : ' machines do') + ' not answer.</p>' : '') + '</section>';
    var st = req && req.settings;
    var every = '<section class="ax-wall__box"><h2>Every task in a workflow</h2>' + (!req ? '<p class="ax-wall__empty">Loading…</p>'
      : req.error ? '<p class="ax-wall__empty">Could not read the setting: ' + esc(req.error) + '.</p>'
      : '<p class="ax-wall__count">' + (st && st.enabled ? 'On. Each new task runs through a workflow.' : 'Off. When on, each new task runs through a workflow.') + ' <a href="/workflows">Change</a></p>') + '</section>';
    var week = wfWeek();
    var nums = WFP.defs ? '<section class="ax-wall__box"><h2>This week</h2><div class="wac__kpis"><div><b>' + week.n + '</b><span>runs</span></div><div><b' + (week.failed ? ' class="is-err"' : '') + '>' + week.failed + '</b><span>failed</span></div></div></section>' : '';
    return follow + every + nums;
  }
  function wfDefsSummary() {
    var defs = WFP.defs || [], on = defs.filter(function (wf) { return wf.state === 'active'; }).length, week = wfWeek();
    return defs.length + (defs.length === 1 ? ' workflow, ' : ' workflows, ') + on + ' on · ' + week.n + (week.n === 1 ? ' run' : ' runs') + ' this week' + (week.failed ? ', ' + week.failed + ' failed' : '');
  }
  /** Called from the Wall's render(). Keeps the keyboard on the same control across a repaint. */
  function renderWorkflows(page) {
    var n = $('nav-n-workflows'), defs = WFP.defs;
    n.textContent = defs ? String(defs.length) : '';
    n.classList.toggle('is-zero', !(defs && defs.length));
    n.setAttribute('title', defs ? defs.length + ' workflows' : '');
    var el = $('wall-workflows'), side = $('wall-wf-side');
    el.hidden = page !== 'workflows';
    $('wall-wf-new').hidden = page !== 'workflows';
    $('wall-aside').classList.toggle('is-wf', page === 'workflows');
    if (page !== 'workflows') return;
    if (!WFP.runs && !WFP.loading && !WFP.error) loadWorkflows();
    if (!WFP.side) loadWorkflowSide();
    var a = document.activeElement, key = '';
    if (a && el.contains && el.contains(a)) {
      if (a.id === 'wf-q') key = '#wf-q';
      else ['data-wf-open', 'data-wf-toggle', 'data-wf-run', 'data-wf-again', 'data-wf-tab'].forEach(function (k) { if (!key && a.getAttribute(k) != null) key = '[' + k + '="' + CSS.escape(a.getAttribute(k)) + '"]'; });
    }
    el.innerHTML = workflowsPageHtml();
    side.innerHTML = workflowsSideHtml();
    if (key) {
      var again = el.querySelector(key);
      if (again && again.focus) { again.focus(); if (key === '#wf-q' && again.setSelectionRange) again.setSelectionRange(again.value.length, again.value.length); }
    }
  }

  // --- Writes (the owner's) ---
  function wfFind(id) { return (WFP.defs || []).filter(function (wf) { return wf.id === id; })[0] || null; }
  function wfSay(msg, bad) { WFP.note = msg; WFP.bad = !!bad; render(); }
  async function wfSend(method, url, body) {
    var h = headers(); h['Content-Type'] = 'application/json';
    var r = await fetch(url, { method: method, headers: h, body: JSON.stringify(body || {}) });
    var d = await r.json().catch(function () { return {}; });
    if (r.status === 401 || r.status === 403) throw new Error('Only the owner can start, turn on or turn off a workflow');
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }
  async function wfToggle(id) {
    var wf = wfFind(id);
    if (!wf || WFP.busy[id]) return;
    var on = wf.state !== 'active', name = wf.title || id;
    WFP.busy[id] = true; render();
    try {
      // The definition as it is on disk now, so nothing the list left out is lost.
      var cur = (await getJson('/api/workflows/' + encodeURIComponent(id))).workflow || wf;
      var saved = await wfSend('PUT', '/api/workflows/' + encodeURIComponent(id), Object.assign({}, cur, { state: on ? 'active' : 'disabled' }));
      if (saved.workflow) WFP.defs = WFP.defs.map(function (x) { return x.id === id ? saved.workflow : x; });
      WFP.busy[id] = false;
      wfSay(on ? '"' + name + '" is on. What starts it starts a run again.' : '"' + name + '" is off. It takes no new runs; runs under way go on.');
    } catch (e) { WFP.busy[id] = false; wfSay('Could not turn "' + name + '" ' + (on ? 'on' : 'off') + ': ' + e.message + '.', true); }
  }
  async function wfStart(id, payload, name) {
    var wf = wfFind(id);
    if (!wf) return;
    WFP.busy[id] = true; render();
    try {
      // A workflow something else starts runs with that start stood in for (force), as the classic Run.
      var d = await wfSend('POST', '/workflows/' + encodeURIComponent(id) + '/run', { payload: payload || {}, force: !wfIsManual(wf) });
      WFP.busy[id] = false;
      S.wfv.open = id; writeHash();
      wfSay('Started "' + name + '"' + (d.runId ? ', run ' + String(d.runId).slice(0, 8) : '') + '.');
      loadWorkflows();
    } catch (e) { WFP.busy[id] = false; wfSay('Could not start "' + name + '": ' + e.message + '.', true); }
  }
  /** Run again: the last run's input, read from its trigger step. */
  async function wfAgain(id) {
    var wf = wfFind(id), last = wfRunsOf(id)[0];
    if (!wf || !last) return;
    var payload = {};
    try {
      var run = (await getJson('/api/workflows/runs/' + encodeURIComponent(last.id))).run || {};
      var t = wfTrigger(wf), out = ((run.context || {})[t && t.id]) || (run.context || {}).trigger;
      if (out && typeof out === 'object') payload = out.event && out.event.payload ? out.event.payload : out;
    } catch (e) { /* the run is gone: start with no input */ }
    wfStart(id, payload, wf.title || id);
  }

  // --- Run… dialog: the trigger's inputs as a form, JSON folded ---
  function wfSchema(wf) { var t = wfTrigger(wf), c = (t && t.config) || {}; return c.inputSchema && c.inputSchema.properties ? c.inputSchema : null; }
  function wfFieldHtml(k, p, req, v) {
    var id = 'wfr-' + k, lab = '<label for="' + esc(id) + '">' + esc(p.title || wfStepName(null, k)) + (req ? ' <span aria-hidden="true">*</span>' : '') + '</label>';
    var hint = p.description ? '<small>' + esc(p.description) + '</small>' : '';
    var val = v == null ? (p.default == null ? '' : p.default) : v, ctl;
    if (Array.isArray(p.enum)) ctl = '<select id="' + esc(id) + '" data-wfr-key="' + esc(k) + '">' + (req ? '' : '<option value=""></option>') +
      p.enum.map(function (o) { return '<option' + (String(o) === String(val) ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    else if (p.type === 'boolean') ctl = '<input id="' + esc(id) + '" type="checkbox" data-wfr-key="' + esc(k) + '"' + (val === true || val === 'true' ? ' checked' : '') + '>';
    else ctl = '<input id="' + esc(id) + '" type="' + (p.type === 'number' || p.type === 'integer' ? 'number' : 'text') + '" data-wfr-key="' + esc(k) + '" value="' + esc(typeof val === 'object' ? JSON.stringify(val) : val) + '"' + (req ? ' required' : '') + '>';
    return '<div class="wwf__fld">' + lab + ctl + hint + '</div>';
  }
  function wfDialogHtml() {
    var g = WFP.dlg, wf = g && wfFind(g.id);
    if (!wf) return '';
    var sc = wfSchema(wf), req = (sc && sc.required) || [], props = (sc && sc.properties) || {};
    var fields = Object.keys(props).map(function (k) { return wfFieldHtml(k, props[k], req.indexOf(k) >= 0, g.values[k]); }).join('');
    var agents = wfAgents(wf).map(nameOf);
    var what = (agents.length ? agents.join(', ') + (agents.length === 1 ? ' does' : ' do') + ' the steps' : 'The steps run in order') +
      (wfIsManual(wf) ? '.' : '. It is normally ' + wfStarts(wf).replace(/^Started /, 'started ').replace(/^When/, 'started when').replace(/^(Every|Weekdays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays|On a)/, 'run $1').toLowerCase() + '; this run stands in for that.') +
      (wf.approval ? ' A message to a person waits for your yes in Needs you.' : '');
    return '<div class="wwf__scrim" data-wf-close></div><section class="wwf__dlg" role="dialog" aria-modal="true" aria-labelledby="wf-dlg-h">' +
      '<h2 id="wf-dlg-h">Run "' + esc(wf.title || wf.id) + '"?</h2>' +
      (fields || '<p class="ax-wall__count">It takes no inputs.</p>') +
      '<details class="wwf__json"' + (g.json ? ' open' : '') + '><summary>Inputs as JSON</summary><textarea id="wfr-json" rows="4" spellcheck="false" aria-label="Inputs as JSON">' + esc(g.raw || '{}') + '</textarea></details>' +
      '<p class="wwf__what">' + esc(what) + '</p>' +
      (g.err ? '<p class="wwf__note is-bad" role="alert">' + esc(g.err) + '</p>' : '') +
      '<div class="wwf__acts"><button type="button" class="ax-btn ax-btn--ghost" data-wf-close>Back</button><button type="button" class="ax-btn" data-wf-start>Start the run</button></div></section>';
  }
  function wfDialogPaint(focusFirst) {
    var box = $('wall-wf-dialog');
    box.hidden = !WFP.dlg;
    box.innerHTML = WFP.dlg ? wfDialogHtml() : '';
    if (WFP.dlg && focusFirst && box.querySelector) { var f = box.querySelector('input,select,textarea,[data-wf-start]'); if (f && f.focus) f.focus(); }
  }
  function wfOpenDialog(id) { WFP.dlg = { id: id, values: {}, raw: '{}', json: false, err: '' }; wfDialogPaint(true); }
  function wfCloseDialog() {
    var id = WFP.dlg && WFP.dlg.id;
    WFP.dlg = null; wfDialogPaint();
    var b = id && document.querySelector && document.querySelector('[data-wf-run="' + id + '"]');
    if (b && b.focus) b.focus();
  }
  function wfDialogStart() {
    var g = WFP.dlg, wf = g && wfFind(g.id);
    if (!wf) return;
    var props = ((wfSchema(wf) || {}).properties) || {}, req = ((wfSchema(wf) || {}).required) || [], payload = {};
    Object.keys(props).forEach(function (k) {
      var v = g.values[k], t = props[k].type;
      if (v === undefined) v = props[k].default;
      if (v === '' || v == null) return;
      payload[k] = t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? v === true || v === 'true' : v;
    });
    try {
      var extra = JSON.parse(String(g.raw || '{}').trim() || '{}');
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('it must be an object, in { }');
      payload = Object.assign(payload, extra);
    } catch (e) { g.err = 'The JSON is not valid: ' + e.message + '.'; g.json = true; wfDialogPaint(); return; }
    // Needed inputs: from the form or the JSON.
    var missing = req.filter(function (k) { return payload[k] === undefined || payload[k] === ''; }).map(function (k) { return (props[k] && props[k].title) || k; });
    if (missing.length) { g.err = 'Fill in ' + missing.join(', ') + '.'; wfDialogPaint(); return; }
    WFP.dlg = null; wfDialogPaint();
    wfStart(wf.id, payload, wf.title || wf.id);
  }

  function wfSet(k, v) { S.wfv[k] = v; writeHash(); render(); }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-wf-tab],[data-wf-open],[data-wf-toggle],[data-wf-run],[data-wf-again],[data-wf-close],[data-wf-start],[data-wf-clear],[data-wf-retry]');
    if (!t) return;
    if (t.hasAttribute('data-wf-tab')) wfSet('tab', t.getAttribute('data-wf-tab'));
    else if (t.hasAttribute('data-wf-open')) {
      var id = t.getAttribute('data-wf-open');
      wfSet('open', S.wfv.open === id ? '' : id);
      if (S.wfv.open) wfLoadRun(id);
    }
    else if (t.hasAttribute('data-wf-toggle')) wfToggle(t.getAttribute('data-wf-toggle'));
    else if (t.hasAttribute('data-wf-run')) wfOpenDialog(t.getAttribute('data-wf-run'));
    else if (t.hasAttribute('data-wf-again')) wfAgain(t.getAttribute('data-wf-again'));
    else if (t.hasAttribute('data-wf-close')) wfCloseDialog();
    else if (t.hasAttribute('data-wf-start')) wfDialogStart();
    else if (t.hasAttribute('data-wf-clear')) { S.wfv.q = ''; S.wfv.project = ''; S.wfv.tab = ''; wfSet('open', ''); }
    else if (t.hasAttribute('data-wf-retry')) { WFP.error = ''; loadWorkflows(); }
  });
  function wfField(t) {
    if (!t || !WFP.dlg) return;
    if (t.id === 'wfr-json') { WFP.dlg.raw = t.value; WFP.dlg.json = true; return; }
    var k = t.getAttribute && t.getAttribute('data-wfr-key');
    if (k) WFP.dlg.values[k] = t.type === 'checkbox' ? !!t.checked : t.value;
  }
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t && t.id === 'wf-q') { S.wfv.q = t.value; writeHash(); render(); return; }
    wfField(t);
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.id === 'wf-project') { wfSet('project', t.value); return; }
    wfField(t);
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && WFP.dlg) { ev.preventDefault && ev.preventDefault(); wfCloseDialog(); } });
`

export const WALL_WORKFLOWS_CSS = `
/* Workflows (#1445, design #1451 frame 7) */
.wwf__tabs { border-bottom: 1px solid var(--ax-border); }
.wwf__tabs .wac__n.is-run { background: var(--ax-blue-t, var(--ax-surface-2)); color: var(--ax-accent); }
.wwf__q { flex: 1 1 220px; max-width: 320px; font: inherit; font-size: var(--ax-fs-sm); background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 5px 14px; min-height: 32px; }
.wwf__bar .wac__sel { font-size: var(--ax-fs-sm); }
.wwf { padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.wwf.is-open { background: var(--ax-surface); }
.wwf__top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.wwf__name { font: inherit; font-weight: 700; font-size: 15px; color: var(--ax-text); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.wwf__name:hover { text-decoration: underline; }
.wwf.is-off .wwf__name { color: var(--ax-text-2); }
.wwf button:focus-visible, .wwf a:focus-visible, .wwf__dlg :focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.wwf__meta { margin-top: 4px; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.wwf__meta .is-stale { color: var(--ax-amber-ink, var(--ax-warn)); }
.wwf__sq .is-run { background: var(--ax-accent); } .wwf__sq .is-wait { background: var(--ax-amber); }
.wwf__fail { margin: 4px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-red-ink, var(--ax-err)); overflow-wrap: anywhere; }
.wwf__sw { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text-2); background: none; border: 0; padding: 2px 0; cursor: pointer; }
.wwf__sw i { position: relative; width: 40px; height: 22px; border-radius: 11px; background: var(--ax-border-2); transition: background .15s; }
.wwf__sw i::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
.wwf__sw[aria-checked="true"] i { background: var(--ax-green); }
.wwf__sw[aria-checked="true"] i::after { left: 21px; }
.wwf__sw:disabled { opacity: .5; cursor: default; }
.wwf__runbtn { margin-top: 8px; font-size: var(--ax-fs-xs); padding: 4px 14px; }
.wwf__open { margin-top: 10px; padding: 12px 14px; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); display: flex; flex-direction: column; gap: 10px; }
.wwf__run { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.wwf__run small, .wwf__desc { color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wwf__desc { margin: 0; }
.wwf__steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.wwf__steps li { display: flex; gap: 10px; align-items: flex-start; font-size: var(--ax-fs-sm); }
.wwf__steps li > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.wwf__steps small { color: var(--ax-text-2); margin-left: 6px; }
.wwf__steps small::before { content: "· "; }
.wwf__ic { flex: none; width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 12px; font-weight: 800; color: #fff; background: var(--ax-border-2); }
.is-ok > .wwf__ic { background: var(--ax-green); } .is-ok > .wwf__ic::after { content: "✓"; }
.is-err > .wwf__ic { background: var(--ax-red); } .is-err > .wwf__ic::after { content: "!"; }
.is-wait > .wwf__ic { background: var(--ax-amber); } .is-wait > .wwf__ic::after { content: "…"; }
.is-run > .wwf__ic { background: var(--ax-accent); } .is-run > .wwf__ic::after { content: "•"; }
.is-skip > .wwf__ic::after { content: "–"; }
.is-todo { color: var(--ax-muted); }
.wwf__steps .is-err small { color: var(--ax-red-ink, var(--ax-err)); }
.wwf__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wwf__links { display: flex; flex-wrap: wrap; gap: 8px; }
.wwf__links .ax-btn { font-size: var(--ax-fs-xs); padding: 4px 12px; }
.wwf__note { margin: 8px 16px; font-size: var(--ax-fs-sm); } .wwf__note.is-bad { color: var(--ax-red-ink, var(--ax-err)); }
.wwf__empty { padding: 32px 16px; text-align: center; }
.wwf__empty h3 { margin: 0 0 6px; font-size: 20px; color: var(--ax-text); }
.wwf__empty p { margin: 0 0 12px; }
/* The owner's controls are on a computer; a phone reads (design frame 7). */
.wwf__owner, .wwf__phone { display: none; }
.ax-wall__titlebar .wwf__new { font-size: var(--ax-fs-xs); padding: 3px 12px; margin-left: 8px; white-space: nowrap; }
/* On a computer the switch says Off; the chip says it on a phone. */
.wwf__offchip { display: none; }
/* The side column: Follow-ups, the "every task" setting, the week. */
.wwf__side { display: none; }
.ax-wall__aside.is-wf > :not(.wwf__side) { display: none; }
.ax-wall__aside.is-wf > .wwf__side { display: block; }
/* Run…: a dialog over the page. */
#wall-wf-dialog { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 16px; }
.wwf__scrim { position: absolute; inset: 0; background: color-mix(in srgb, var(--ax-text) 35%, transparent); }
.wwf__dlg { position: relative; width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--ax-bg); color: var(--ax-text); border-radius: var(--ax-radius-lg); padding: 20px; box-shadow: 0 12px 40px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 12px; }
.wwf__dlg h2 { margin: 0; font-size: 20px; }
.wwf__fld { display: flex; flex-direction: column; gap: 4px; font-size: var(--ax-fs-sm); }
.wwf__fld label { color: var(--ax-text-2); }
.wwf__fld input[type=text], .wwf__fld input[type=number], .wwf__fld select, .wwf__json textarea { font: inherit; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 8px 10px; }
.wwf__fld small { color: var(--ax-muted); }
.wwf__json summary { cursor: pointer; color: var(--ax-accent); font-size: var(--ax-fs-sm); }
.wwf__json textarea { width: 100%; box-sizing: border-box; margin-top: 6px; font-family: var(--ax-mono); font-size: 12px; }
.wwf__what { margin: 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wwf__acts { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 1180px) {
  .ax-wall__aside.is-wf > .wwf__side { display: none; }
}
@media (max-width: 640px) {
  .wwf { padding: 12px; }
  .wwf__own, .wwf__ed, .ax-wall__titlebar .wwf__new { display: none !important; }
  .wwf__offchip { display: inline-block; }
  .wwf__owner { display: block; margin: 0; padding: 12px; background: var(--ax-blue-t, var(--ax-surface)); font-size: var(--ax-fs-sm); }
  .wwf__phone { display: block; margin: 0; padding: 12px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
  .wwf__bar .wwf__q { max-width: none; }
}
`
