// --- Wall v2 pages, browser side (#1355) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), when(), until(), ago(), stamp(), avatar(), nameOf(), allAgents(),
// isOpen(), idleDays(), mins(), cardsOf(), blockKey(), projectHref(),
// taskHref(), act() and load(). From the round-1 designs
// (notes/design/wall-v2-round-1.md):
//
//   List      quick views, group by (f-grp in the filters, so in the link:
//             blocked by, project, owner) with a
//             header row per group, seven columns and a Columns button.
//   Projects  one card per project: a bar of its open work, the four
//             counts, closed per week as four bars, its agents, and its
//             worst state in the corner.
//   Jobs      today's totals, then jobs per machine: value line, schedule,
//             next run, the last seven runs as squares and "look stale".
//             Pause and Archive are drawn but not built (delivery phase 2).
//   Creator   give an agent a task: it becomes its post (the composer's
//             POST /api/admin/wall/post, with Done when, project, estimate).
//
// Everything here reads, except the Creator's Post.

export const WALL_PAGES_SCRIPT = String.raw`
  // --- List (#1355): quick views, group by, columns ---
  /** Days with no move that make the cell amber. */
  var OLD_WAIT_DAYS = 3;
  var LIST_COLS = [
    ['state', 'Status'], ['post', 'Post'], ['owner', 'Owner'], ['project', 'Project'],
    ['idle', 'Days, no move'], ['blocked', 'Waits on'], ['time', 'Time / estimate'],
  ];
  var MORE_COLS = [['node', 'Node'], ['runs', 'Runs'], ['group', 'Group']];
  var QUICK = [['open', 'Open'], ['blocked', 'Blocked'], ['stalled', 'Stalled'], ['waiting_owner', 'Waits on me']];
  function concurrentText(p) { return p.concurrent.map(function (o) { return o.runs.join(' + '); }).join(', '); }
  function overEstimate(p) { return !!p.estimateMinutes && mins(p.runMs) > p.estimateMinutes; }
  function listBarHtml(f) {
    return '<div class="wlb">' + QUICK.map(function (q) {
      return '<button type="button" class="wlb__q' + (f.status === q[0] ? ' is-on' : '') + '" data-tab="' + q[0] + '">' + q[1] + '</button>';
    }).join('') +
      '<button type="button" class="wlb__q" data-quick="mine">My view</button>' +
      '<button type="button" class="wlb__q" data-quick="filters">Filters</button>' +
      '<button type="button" class="wlb__q" data-quick="cols" aria-pressed="' + (S.allCols ? 'true' : 'false') + '">Columns' + (S.allCols ? ': all' : '') + '</button>' +
    '</div>';
  }
  function listCell(p, k) {
    if (k === 'state') return '<td>' + stateBadge(p.state) +
      (p.forgeState ? '<br><small' + (p.forgeState.unknown ? ' title="' + esc(p.forgeState.unknown) + '">' + esc(forgeName(p.forgeState)) + ' unknown' : '>' + esc(forgeName(p.forgeState)) + ' ' + esc(p.forgeState.state) + (p.forgeState.closedBy ? ' by ' + esc(p.forgeState.closedBy) : '')) + '</small>' +
        (forgeClosedOpen(p) ? ' <small title="Closed on the forge, still open here">⚠</small>' : '') +
        (forgeOpenClosed(p) ? ' <small title="Open on the forge, closed here">⚠</small>' : '') : '') +
      (qaText(p, true) ? '<br><small' + (p.qa ? ' title="' + esc(qaText(p)) + '"' : '') + '>' + esc(p.awaitingQa ? 'Awaiting QA' : qaText(p, true)) + '</small>' : '') + '</td>';
    if (k === 'post') return '<td><a href="#" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a></td>';
    if (k === 'owner') return '<td>' + esc(p.owner) + '</td>';
    if (k === 'project') return '<td>' + esc(p.project || '—') + '</td>';
    if (k === 'idle') return '<td class="num' + (isOpen(p) && idleDays(p) >= OLD_WAIT_DAYS ? ' is-amber' : '') + '">' + idleDays(p) + '</td>';
    if (k === 'blocked') return '<td' + (p.blocked && Date.now() - p.blocked.since >= OLD_WAIT_DAYS * DAY ? ' class="is-amber"' : '') + '>' +
      (p.blocked ? esc(p.blocked.who) + ' <small>(' + ago(p.blocked.since) + ')</small>' : cardsOf(p).length ? 'owner' : '—') +
      (cardsOf(p).length ? ' <small>card expires ' + until(cardsOf(p)[0].expiresAt) + '</small>' : '') + '</td>';
    if (k === 'time') return '<td' + (overEstimate(p) ? ' class="is-amber"' : '') + '>' + mins(p.runMs) + (p.estimateMinutes ? ' / ' + p.estimateMinutes : '') + ' min' + (p.timeFlag ? ' <small title="' + esc(p.timeFlag) + '">⚠</small>' : '') +
      (p.forgeTime ? '<br><small' + (p.forgeTime.unknown ? ' title="' + esc(p.forgeTime.unknown) + '"' : '') + '>GitLab ' + esc(forgeTimeText(p.forgeTime)) + '</small>' +
        (forgeFlags(p).length ? ' <small title="' + esc(forgeFlags(p).join('; ')) + '">⚠</small>' : '') : '') +
      // Runs is behind Columns: all, so the concurrent warning rides here too.
      (p.concurrent && p.concurrent.length ? ' <small title="Concurrent runs: ' + esc(concurrentText(p)) + '">⚠ concurrent</small>' : '') + '</td>';
    if (k === 'node') return '<td>' + esc(p.node.name) + '</td>';
    if (k === 'runs') return '<td class="num">' + p.runs + (p.failedRuns ? ' <small>(' + p.failedRuns + ' failed)</small>' : '') + '</td>';
    return '<td>' + esc(groupKey(p)) + '</td>';
  }
  function listGroupOf(p, by) {
    if (by === 'blocked') return blockKey(p, 'agent');
    if (by === 'project') return p.project ? { key: p.project, label: p.project } : { key: '~', label: 'Other' };
    return { key: p.owner, label: '@' + p.owner };
  }
  function listHtml(posts) {
    var k = S.sort.key, dir = S.sort.dir;
    var cols = LIST_COLS.concat(S.allCols ? MORE_COLS : []);
    posts = posts.slice().sort(function (a, b) { var x = sortVal(a, k), y = sortVal(b, k); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    var head = '<thead><tr>' + cols.map(function (c) {
      return '<th data-sort="' + c[0] + '" aria-sort="' + (k === c[0] ? (dir > 0 ? 'ascending' : 'descending') : 'none') + '">' + c[1] + (k === c[0] ? (dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    }).join('') + '</tr></thead>';
    function row(p) { return '<tr>' + cols.map(function (c) { return listCell(p, c[0]); }).join('') + '</tr>'; }
    var by = $('f-grp').value;
    if (!by) return '<table class="wl">' + head + '<tbody>' + posts.map(row).join('') + '</tbody></table>';
    var groups = {}, order = [];
    posts.forEach(function (p) {
      var g = listGroupOf(p, by);
      if (!groups[g.key]) { groups[g.key] = { label: g.label, posts: [] }; order.push(g.key); }
      groups[g.key].posts.push(p);
    });
    function oldest(g) { return Math.min.apply(null, g.posts.map(function (p) { return p.blocked ? p.blocked.since : p.lastMoveAt; })); }
    order.sort(function (a, b) { return oldest(groups[a]) - oldest(groups[b]); });
    return '<table class="wl">' + head + order.map(function (key) {
      var g = groups[key];
      return '<tbody><tr class="wl__g"><th colspan="' + cols.length + '">' + esc(g.label) + ' <small>' + g.posts.length + (g.posts.length === 1 ? ' post' : ' posts') +
        ' · oldest wait ' + esc(ago(oldest(g)).replace(' ago', '')) + '</small></th></tr>' + g.posts.map(row).join('') + '</tbody>';
    }).join('') + '</table>';
  }

  // --- Projects (#1355): one card per project ---
  function projectState(r) { return r.stalled ? 'stalled' : r.blocked ? 'blocked' : 'moving'; }
  function projectCardsHtml() {
    var rows = (S.data && S.data.projects) || [];
    if (!rows.length) return '<p class="ax-wall__empty">No open work.</p>';
    var tp = S.tp && S.tp.throughput ? S.tp.throughput.projects : [];
    return '<div class="wpc-grid">' + rows.map(function (r) {
      var later = Math.max(0, r.open - r.inProgress - r.blocked - r.stalled);
      var parts = [['in progress', r.inProgress, 'in_progress', 'go'], ['blocked', r.blocked, 'blocked', 'amber'], ['stalled', r.stalled, 'stalled', 'red'], ['not started', later, 'open', 'idle']];
      var sum = Math.max(1, parts.reduce(function (n, x) { return n + x[1]; }, 0));
      var weeks = (tp.find(function (t) { return t.project === r.project; }) || { weeks: [0, 0, 0, 0] }).weeks;
      var max = Math.max.apply(null, weeks.concat([1]));
      var agents = uniq(((S.data && S.data.posts) || []).filter(function (p) { return p.project === r.project && isOpen(p); }).map(function (p) { return p.owner; }));
      var state = projectState(r);
      return '<article class="wpc"><header><b>' + (r.project === null ? '<i>Other</i>' : esc(r.project)) + '</b><span class="wpc__s is-' + state + '">' + state + '</span></header>' +
        '<div class="wpc__bar" role="img" aria-label="' + esc(parts.map(function (x) { return x[1] + ' ' + x[0]; }).join(', ')) + '">' +
          parts.map(function (x) { return x[1] ? '<span class="is-' + x[3] + '" style="flex:' + x[1] / sum + '"></span>' : ''; }).join('') + '</div>' +
        '<dl class="wpc__n">' + [['open', r.open, 'open'], ['in progress', r.inProgress, 'in_progress'], ['blocked', r.blocked, 'blocked'], ['stalled', r.stalled, 'stalled']].map(function (x) {
          return '<div><dt>' + x[0] + '</dt><dd>' + (x[1] ? '<a href="' + esc(projectHref(r.project, x[2])) + '">' + x[1] + '</a>' : '0') + '</dd></div>';
        }).join('') + '</dl>' +
        '<div class="wpc__wk" title="Closed per week, last four weeks, oldest first">' + weeks.map(function (n) {
          return '<span style="height:' + Math.round(4 + n / max * 24) + 'px" title="' + n + ' closed"></span>';
        }).join('') + '<small>closed per week</small></div>' +
        '<div class="wpc__ag">' + (agents.length ? agents.map(function (a) { return avatar(a, 'sm'); }).join('') : '<small>No agent on it now</small>') + '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  // --- Jobs (#1355): per machine, the last seven runs, look stale ---
  var STALE_OFF_DAYS = 14, STALE_FAILS = 3;
  function jobStale(j, r) {
    var why = [];
    if (r && (r.flags || []).some(function (f) { return f.reason === 'disabled-long'; })) why.push('off ' + STALE_OFF_DAYS + '+ days');
    if (Math.max(j.consecutiveErrors || 0, (r && r.consecutiveFailures) || 0) >= STALE_FAILS) why.push('failed ' + STALE_FAILS + ' times in a row');
    if (!j.value || !j.value.why || !j.value.metric) why.push('no value line');
    return why;
  }
  function squares(r) {
    var runs = ((r && r.recent) || []).slice().reverse();
    var cells = runs.map(function (x) {
      var cls = x.status === 'success' ? 'ok' : x.status === 'failed' || x.status === 'timeout' ? 'err' : 'idle';
      return '<span class="is-' + cls + '" title="' + esc(stamp(Date.parse(x.at)) + ': ' + x.status) + '"></span>';
    });
    while (cells.length < 7) cells.unshift('<span class="is-none" title="No run"></span>');
    return '<span class="wjb__sq" aria-label="Last seven runs: ' + esc(runs.map(function (x) { return x.status; }).join(', ') || 'none') + '">' + cells.join('') + '</span>';
  }
  function jobsPageHtml() {
    var nodes = S.live && S.live.nodes;
    if (!nodes) return '<p class="ax-wall__empty">Loading…</p>';
    var tot = { ran: 0, worked: 0, failed: 0, quiet: 0, stale: 0 }, today = new Date().toDateString();
    var blocks = nodes.map(function (n) {
      var routines = {};
      (n.routines || []).forEach(function (r) { routines[r.id] = r; });
      (n.cronRuns || []).forEach(function (x) {
        if (new Date(x.startedAt).toDateString() !== today) return;
        tot.ran++;
        if (x.quiet) tot.quiet++;
        else if (x.status === 'success') tot.worked++;
        else tot.failed++;
      });
      var jobs = (n.crons || []).map(function (j) {
        var r = routines['cron:' + j.id], stale = jobStale(j, r);
        if (stale.length) tot.stale++;
        var last = (n.cronRuns || []).filter(function (x) { return x.jobId === j.id; })[0];
        var summary = r && r.lastRun ? (r.lastRun.summary || (last && (last.errorSummary || last.responseSummary)) || '') : '';
        return '<details class="wjb' + (stale.length ? ' is-stale' : '') + '"><summary>' +
          '<span class="wjb__n"><b>' + esc(j.id) + '</b> <small>@' + esc(j.agent) + '</small><span>' + axCronValueHtml(j.value, esc) + '</span></span>' +
          '<span class="wjb__w"><code>' + esc(j.schedule) + '</code><small>' + (j.enabled ? (j.nextRun ? 'next ' + until(Date.parse(j.nextRun)) : '') : 'off') + '</small></span>' +
          squares(r) +
          '<span class="wjb__st">' + (stale.length ? '<span class="chip chip--warn" title="' + esc(stale.join('; ')) + '">look stale</span>' : j.enabled ? '<span class="chip chip--done">on</span>' : '<span class="chip chip--ghost">off</span>') + '</span>' +
        '</summary><div class="wjb__d">' +
          (stale.length ? '<p>Looks stale: ' + esc(stale.join('; ')) + '.</p>' : '') +
          (r && r.lastRun ? '<p>Last run ' + when(Date.parse(r.lastRun.at)) + ', ' + esc(r.lastRun.status) + (summary ? ': ' + esc(summary.slice(0, 300)) : '') + '</p>' : '<p>No run on record.</p>') +
          (last && last.taskId ? '<a href="' + esc(taskHref(last.taskId, j.agent, { daemonUrl: n.url }, true)) + '">Full log</a>' : '') +
          ' <button type="button" class="ax-btn ax-btn--ghost" disabled title="Phase 2, not built">Pause</button>' +
          ' <button type="button" class="ax-btn ax-btn--ghost" disabled title="Phase 2, not built">Archive</button> <small>Phase 2, not built</small>' +
        '</div></details>';
      });
      var down = !n.reachable || n.error;
      return '<section class="wjm"><h3>' + esc(n.name) + ' <small>' + jobs.length + (jobs.length === 1 ? ' job' : ' jobs') +
        (n.stale ? ', as of ' + esc(stamp(Date.parse(n.staleSince))) : down ? ', does not answer' : '') + '</small></h3>' +
        (jobs.length ? jobs.join('') : '<p class="ax-wall__empty">' + (down && !n.stale ? 'Its jobs are not known.' : 'No recurring jobs.') + '</p>') + '</section>';
    });
    var totals = [['ran', tot.ran], ['worked', tot.worked], ['failed', tot.failed], ['quiet', tot.quiet], ['look stale', tot.stale]];
    return '<dl class="wjt">' + totals.map(function (t) { return '<div><dt>' + t[0] + '</dt><dd>' + t[1] + '</dd></div>'; }).join('') + '</dl>' +
      '<p class="ax-wall__count">Today, every machine. Look stale: off ' + STALE_OFF_DAYS + ' days or more, failed ' + STALE_FAILS + ' times in a row, or no value line.</p>' + blocks.join('');
  }

  // --- Creator (#1355): give an agent a task, which becomes its post ---
  function creatorHtml() {
    var c = S.creator || (S.creator = { agent: '', text: '', done: '', project: '', estimate: '', note: '' });
    var over = {};
    (((S.data && S.data.capacity) || {}).owners || []).forEach(function (r) { if (r.over) over[r.owner] = true; });
    var list = allAgents().filter(function (a) { return a.nodes.length; });
    var cards = list.length ? list.map(function (a) {
      var s = a.stats || { open: 0 };
      return '<button type="button" class="wcr__a' + (c.agent === a.id ? ' is-on' : '') + (over[a.id] ? ' is-over' : '') + '" data-creator-agent="' + esc(a.id) + '" aria-pressed="' + (c.agent === a.id ? 'true' : 'false') + '">' +
        avatar(a.id, 'sm') + '<span><b>' + esc(a.name) + '</b><small>@' + esc(a.id) + ' · ' + esc(a.nodes.join(', ')) + ' · ' + s.open + ' open' +
        (a.running ? ' · running ' + a.running : '') + '</small>' + (over[a.id] ? '<small class="is-amber">over capacity</small>' : '') + '</span></button>';
    }).join('') : '<p class="ax-wall__empty">' + (S.live ? 'No machine reports an agent.' : 'Loading…') + '</p>';
    var projects = uniq(((S.data && S.data.posts) || []).map(function (p) { return p.project; }));
    var who = c.agent ? nameOf(c.agent) : 'the agent';
    return '<div class="wcr">' +
      '<p class="wcr__warn">This page sends a message: the agent you pick gets the task. Every other Wall page only reads.</p>' +
      '<h3>1. Who does it</h3><div class="wcr__agents">' + cards + '</div>' +
      '<h3>2. The task</h3>' +
      '<label class="wcr__f">Request <textarea id="cr-text" rows="4" maxlength="3500" placeholder="What should be done? Markdown works.">' + esc(c.text) + '</textarea></label>' +
      '<label class="wcr__f">Done when <input id="cr-done" maxlength="300" placeholder="The proof it should close with, for example a merged PR" value="' + esc(c.done) + '"></label>' +
      '<div class="wcr__row"><label class="wcr__f">Project <input id="cr-project" list="cr-projects" maxlength="120" value="' + esc(c.project) + '"><datalist id="cr-projects">' +
        projects.map(function (p) { return '<option value="' + esc(p) + '">'; }).join('') + '</datalist></label>' +
      '<label class="wcr__f">Estimate, minutes <input id="cr-estimate" type="number" min="1" max="10000" value="' + esc(c.estimate) + '"></label></div>' +
      '<h3>3. What happens</h3><ol class="wcr__what"><li>' + esc(who) + ' gets it as a message, as a mention in a chat would, within a minute.</li>' +
        '<li>A post by ' + esc(who) + ' opens on the Wall, in progress.</li><li>Its thread fills in as it works; its answer becomes the post\'s result.</li></ol>' +
      '<div class="wdo__row"><button type="button" class="ax-btn" data-creator-post' + (c.agent && !c.posting ? '' : ' disabled') + '>Post to ' + esc(c.agent ? nameOf(c.agent) : '…') + '</button>' +
        '<span class="wdo__n" id="cr-note" role="status">' + esc(c.note) + '</span></div>' +
    '</div>';
  }
  /** The post's words: the request, then what the form adds, one line each. */
  function creatorText(c) {
    return [c.text.trim(), c.done.trim() ? 'Done when: ' + c.done.trim() : '', c.project.trim() ? 'Project: ' + c.project.trim() : '',
      +c.estimate > 0 ? 'Estimate: ' + Math.round(+c.estimate) + ' min' : ''].filter(Boolean).join('\n');
  }
  function creatorRead() {
    var c = S.creator;
    if (!c) return;
    ['text', 'done', 'project', 'estimate'].forEach(function (k) { var el = $('cr-' + k); if (el) c[k] = el.value || ''; });
  }
  async function creatorPost() {
    var c = S.creator;
    // One post per click: a second click while it is in flight sends nothing.
    if (!c || c.posting) return;
    creatorRead();
    var a = allAgents().find(function (x) { return x.id === c.agent; });
    if (!a) { c.note = 'Pick an agent first.'; render(); return; }
    if (!c.text.trim()) { c.note = 'Write the request first.'; render(); return; }
    var nodes = (S.live && S.live.nodes) || [];
    var home = nodes.findIndex(function (n) { return (n.agents || []).some(function (x) { return x.id === a.id; }); });
    c.note = 'Posting…'; c.posting = true; render();
    var r = await act('POST', '/api/admin/wall/post', { agent: a.id, text: creatorText(c) }, home > 0 ? nodes[home].url : null);
    c.posting = false;
    if (!r.ok) { c.note = 'Not posted: ' + r.error; render(); return; }
    // fresh: the next render draws the empty form instead of reading back
    // the fields still in the page, which hold what was just sent.
    S.creator = { agent: c.agent, text: '', done: '', project: '', estimate: '', note: r.body.message || 'Posted.', fresh: true };
    render();
    load();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-creator-agent],[data-creator-post],[data-quick],[data-more-nav],[data-nav]');
    if (!t) return;
    // On the phone, picking a page from More closes More.
    if (t.hasAttribute('data-nav')) { var open = document.querySelector('.ax-wall__nav.is-more'); if (open) open.classList.remove('is-more'); return; }
    if (t.hasAttribute('data-creator-agent')) { if (S.creator.posting) return; creatorRead(); S.creator.agent = t.getAttribute('data-creator-agent'); S.creator.note = ''; render(); }
    else if (t.hasAttribute('data-creator-post')) creatorPost();
    else if (t.hasAttribute('data-more-nav')) { var nav = document.querySelector('.ax-wall__nav'); if (nav) nav.classList.toggle('is-more'); }
    else {
      var q = t.getAttribute('data-quick');
      if (q === 'cols') { S.allCols = !S.allCols; render(); }
      else if (q === 'filters') $('wall-search').click();
      else if (q === 'mine') $('v-mine').click();
    }
  });
`

export const WALL_PAGES_CSS = `
/* List (#1355) */
.wlb { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-xs); }
.wlb__q { font: inherit; font-weight: 600; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 3px 12px; cursor: pointer; }
.wlb__q.is-on, .wlb__q[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wl .is-amber { color: var(--ax-amber-ink, var(--ax-warn)); font-weight: 600; }
.wl__g th { background: var(--ax-surface); color: var(--ax-text); font-size: var(--ax-fs-sm); font-weight: 700; cursor: default; }
.wl__g small { color: var(--ax-muted); font-weight: 400; margin-left: 6px; }

/* Projects (#1355) */
.wpc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 12px 0; }
.wpc { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--ax-bg-elev); }
.wpc header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.wpc__s { font-size: var(--ax-fs-xs); font-weight: 700; border-radius: var(--ax-radius-pill); padding: 0 8px; }
.wpc__s.is-moving { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green-d); }
.wpc__s.is-blocked { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.wpc__s.is-stalled { background: var(--ax-red-t); color: var(--ax-red-ink); }
.wpc__bar { display: flex; height: 8px; border-radius: var(--ax-radius-pill); overflow: hidden; background: var(--ax-surface-2); }
.wpc__bar .is-go { background: var(--ax-accent); } .wpc__bar .is-amber { background: var(--ax-amber); }
.wpc__bar .is-red { background: var(--ax-red); } .wpc__bar .is-idle { background: var(--ax-border-2); }
.wpc__n { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 0; }
.wpc__n dt { font-size: 11px; color: var(--ax-muted); }
.wpc__n dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.wpc__wk { display: flex; align-items: flex-end; gap: 3px; height: 30px; }
.wpc__wk span { width: 12px; background: var(--ax-accent); border-radius: 2px; opacity: .7; }
.wpc__wk small { margin-left: 6px; color: var(--ax-muted); font-size: 11px; }
.wpc__ag { display: flex; gap: 4px; flex-wrap: wrap; }
.wpc__ag small { color: var(--ax-muted); }

/* Jobs (#1355) */
.wjt { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 0 0 8px; }
.wjt div { background: var(--ax-surface); border-radius: var(--ax-radius); padding: 8px 10px; }
.wjt dt { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wjt dd { margin: 0; font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
.wjm h3 { font-size: var(--ax-fs); margin: 14px 0 6px; }
.wjm h3 small { color: var(--ax-muted); font-weight: 400; }
.wjb { border-top: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wjb summary { display: grid; grid-template-columns: minmax(0, 1fr) 140px auto 90px; gap: 10px; align-items: center; padding: 8px 0; cursor: pointer; list-style: none; }
.wjb summary::-webkit-details-marker { display: none; }
.wjb__n span { display: block; font-size: var(--ax-fs-xs); }
.wjb__n small, .wjb__w small { color: var(--ax-muted); }
.wjb__w { display: flex; flex-direction: column; font-size: var(--ax-fs-xs); }
.wjb__w code { font-family: var(--ax-mono); }
.wjb__sq { display: inline-flex; gap: 3px; }
.wjb__sq span { width: 12px; height: 12px; border-radius: 3px; background: var(--ax-surface-2); }
.wjb__sq .is-ok { background: var(--ax-green); } .wjb__sq .is-err { background: var(--ax-red); } .wjb__sq .is-idle { background: var(--ax-border-2); }
.wjb__sq .is-none { background: none; border: 1px dashed var(--ax-border-2); }
.wjb__st { text-align: right; }
.wjb__d { padding: 0 0 10px; color: var(--ax-text-2); font-size: var(--ax-fs-xs); }
.wjb__d p { margin: 0 0 6px; overflow-wrap: anywhere; }
.wjb__d .ax-btn { font-size: var(--ax-fs-xs); padding: 2px 10px; }
.wjb__d .ax-btn[disabled] { opacity: .5; cursor: not-allowed; }

/* Creator (#1355) */
.wcr { padding: 12px 16px 24px; display: flex; flex-direction: column; gap: 8px; }
.wcr h3 { font-size: var(--ax-fs); margin: 10px 0 2px; }
.wcr__warn { margin: 0; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-amber-t); color: var(--ax-amber-ink); font-size: var(--ax-fs-sm); }
.wcr__agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.wcr__a { display: flex; gap: 8px; align-items: center; text-align: left; font: inherit; color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-lg); padding: 8px 10px; cursor: pointer; }
.wcr__a.is-on { border-color: var(--ax-accent); box-shadow: 0 0 0 1px var(--ax-accent); }
.wcr__a span { min-width: 0; display: flex; flex-direction: column; }
.wcr__a small { color: var(--ax-muted); font-size: var(--ax-fs-xs); overflow: hidden; text-overflow: ellipsis; }
.wcr__a .is-amber { color: var(--ax-amber-ink); }
.wcr__f { display: flex; flex-direction: column; gap: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); flex: 1; }
.wcr__f textarea, .wcr__f input { font: inherit; font-size: var(--ax-fs); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 8px 10px; }
.wcr__row { display: flex; gap: 10px; flex-wrap: wrap; }
.wcr__what { margin: 0; padding-left: 20px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.ax-btn[disabled] { opacity: .5; cursor: not-allowed; }

@media (max-width: 640px) {
  .wjt { grid-template-columns: repeat(3, 1fr); }
  .wjb summary { grid-template-columns: minmax(0, 1fr) auto; }
  .wjb__w, .wjb__st { display: none; }
}
`
