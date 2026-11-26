// --- The feed and its List view, drawn to the approved mock (#2101) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), nameOf(), avatar(), hashOf(), shortTime(), cardsOf(), until(),
// mins(), isOpen(), idleDays(), act(), load(), render(), openPost(),
// threadHtml(), wsCopiesHtml(), forgeClosedOpen(), forgeName(), sortVal()
// and the decide helpers (decAttrs, decBtn, decConfirmHtml, decOwner). The
// pure half (states, tab counts, time, keyed patching) is
// wall-feed-model.ts, injected beside it.
//
// From the mocks Anis approved (hub-feed-mock-1440, hub-list-view-mock-1440,
// hub-feed-mock-phone) and orca-design (recipes §8 table, §9 states, C27,
// C28):
//   Feed   groups in the one state order (Needs you first; a failed run
//          sits there with its reason and Retry), each folding from its
//          header with a count and showing 3 rows, then Show all (N). A row:
//          author, handle, time and state; title; two lines of what it
//          said; a card that waits on you with Deny and Approve; one meta
//          line (thread, runs, minutes, project); link and ... on hover or
//          focus, Stop always visible while it runs.
//   List   the same posts as a table: Status, Task, Owner, Project, Idle,
//          Waits on, Time, then the row's actions. Sort headers are
//          buttons; grouping and extra columns are in one "Group and
//          columns" menu kept in this browser. Flags are words with an icon.
//   Both   patch rows by key (fdPatch): a refresh replaces only the rows
//          that changed, so nothing re-animates and focus, scroll and an
//          open menu stay. A test DOM without real nodes gets the markup.

import { hubIconMap } from "./hub-lucide"

/** The icons this file draws, as strings for the browser. */
const FD_ICONS = [
  "circle-alert", "circle-x", "loader-circle", "clock", "circle-dashed", "ban", "circle-check",
  "rotate-ccw", "message-circle", "repeat-2", "timer", "folder", "link", "check", "ellipsis",
  "square", "triangle-alert", "arrow-up", "arrow-down", "chevron-down", "hourglass",
]

/** Where "Group and columns" is kept in this browser (C21). */
export const FD_COLS_KEY = "ax.hub.listCols"
/** Rows the List view shows before "Show all (N)": about one screen. */
export const FD_LIST_CAP = 10

export const WALL_FEED_SCRIPT = String.raw`
  // --- The feed and the List view (#2101, wall-feed.client.ts) ---
  var FI = ${JSON.stringify(hubIconMap(FD_ICONS))};
  var FD_LIST_CAP = ${FD_LIST_CAP};
  /** One lucide icon; cls is added to its class. */
  function fdIcon(name, cls) {
    var s = FI[name] || '';
    return cls ? s.replace('class="lucide ', 'class="lucide ' + cls + ' ') : s;
  }
  /** The run of this post going on now, with the node it runs on, or null. */
  function fdLiveRun(p) {
    var nodes = (S.live && S.live.nodes) || [];
    for (var i = 0; i < nodes.length; i++) {
      var ags = nodes[i].agents || [];
      for (var j = 0; j < ags.length; j++) {
        var ts = ags[j].runningTasks || [];
        for (var k = 0; k < ts.length; k++) {
          if (ltRequestId(ts[k]) === p.id || (p.lastRun && ts[k].id === p.lastRun.taskId)) return { node: nodes[i].url || '', task: ts[k].id, agent: ags[j].id };
        }
      }
    }
    return null;
  }
  /** The post's state in the one set (wall-feed-model.ts fdState). */
  function fdStateOf(p) { return fdState(p, !!fdLiveRun(p)); }
  /** Icon and word, in the state's tone. The working icon turns. */
  function fdStateHtml(s) {
    var i = fdStates()[s];
    return '<span class="fd-st is-' + i.tone + '">' + fdIcon(i.icon, s === 'working' ? 'fd-spin' : '') + '<span>' + i.word + '</span></span>';
  }
  /** Is the browser's DOM real? A test DOM has no <template>, so it gets
   *  the markup as one string instead of patched rows. */
  function fdReal(box) {
    if (!box || !box.children || !box.replaceChild || typeof document.createElement !== 'function') return false;
    var t = document.createElement('template');
    return !!(t && t.content);
  }
  function fdMake(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  /** Posts in groups, in the state order; newest move first inside each. */
  function fdGroups(posts) {
    var st = fdStates(), by = {};
    posts.forEach(function (p) {
      var g = fdGroupOf(fdStateOf(p));
      (by[g] = by[g] || []).push(p);
    });
    return Object.keys(by).sort(function (a, b) { return st[a].order - st[b].order; }).map(function (g) {
      return { key: g, title: fdGroupTitle(g), posts: by[g].slice().sort(function (x, y) { return y.lastMoveAt - x.lastMoveAt; }) };
    });
  }
  /** What a post said, as plain words for two lines. */
  function fdExcerpt(p) {
    var t = (p.result && p.result.text) || p.need || '';
    return String(t).replace(/\[agentx:[^\]\n]*\]?/g, '').replace(/^\s*>+/gm, '').replace(/[#*_\x60]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  }
  /** "#2258" from the post's issue or PR home, or "". */
  function fdRef(p) {
    var r = p.home && ltIssueRef(p.home.link);
    var m = r && /[#!]\d+$/.exec(r);
    return m ? m[0] : '';
  }

  // --- A card that waits on you, compact: the question, two facts, Deny and Approve ---
  function fdCardHtml(c, p) {
    var key = 'card:' + c.id, expired = c.expiresAt <= Date.now();
    var o = { key: key, kind: 'card', title: c.title, agent: c.raisedBy, choices: c.choices || [], recommend: c.recommend, draft: c.draft };
    var facts = [];
    if (c.ask && c.ask !== c.title) facts.push(['Asks', c.ask]);
    if (c.recommend) facts.push(['Suggests', c.recommend]);
    if (c.silence) facts.push(['If no answer', c.silence]);
    return '<section class="fd-card"' + decAttrs(key, p.node && p.node.peer, '', c.title) + ' aria-label="Waiting on you: ' + esc(c.title) + '">' +
      '<p class="fd-card__t">' + esc(c.title) + '</p>' +
      (facts.length ? '<dl class="fd-card__f">' + facts.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>' : '') +
      '<div class="fd-card__foot"><span class="fd-card__exp' + (expired ? ' is-late' : '') + '">' + fdIcon('hourglass') +
        '<time datetime="' + esc(new Date(c.expiresAt).toISOString()) + '" title="' + esc(stamp(c.expiresAt)) + '">' + (expired ? 'Expired' : 'Expires ' + esc(until(c.expiresAt))) + '</time></span>' +
        (decOwner() ? '<span class="fd-card__btns">' + decBtn('no', 'Deny', false, o) + decBtn('yes', 'Approve', true, o) + '</span>' : '') + '</div>' +
      decConfirmHtml(o) + '</section>';
  }
  /** A failed run: what failed, its run id, and Retry. */
  function fdFailHtml(p) {
    var f = p.lastFailure;
    var why = f ? 'Run failed: ' + esc(f.error) + ', run <code>' + esc(f.taskId) + '</code>' : 'It needs attention: its last step did not finish.';
    var said = S.fdSaid && S.fdSaid[p.id];
    return '<div class="fd-fail"><p class="fd-fail__w">' + why + (said ? ' <span class="fd-fail__said" role="status">' + esc(said) + '</span>' : '') + '</p>' +
      '<button type="button" class="ax-btn ax-btn--ghost fd-xs" data-fd-retry="' + esc(p.id) + '" data-fk="retry"' + (S.fdBusy && S.fdBusy[p.id] ? ' disabled' : '') + '>' + fdIcon('rotate-ccw') + 'Retry</button></div>';
  }
  /** The actions at the end of a row: link and ... on hover or focus, Stop always. */
  function fdActsHtml(p, s, run, list) {
    var copied = S.fdCopied === p.id;
    var b = '<button type="button" class="fd-ib fd-hov" data-fd-copy="' + esc(p.id) + '" data-fk="copy" aria-label="' + (copied ? 'Link copied' : 'Copy link') + '" title="' + (copied ? 'Link copied' : 'Copy link') + '">' + fdIcon(copied ? 'check' : 'link') + '</button>' +
      '<button type="button" class="fd-ib fd-hov" data-fd-menu="' + esc(p.id) + '" data-fk="menu" aria-haspopup="menu" aria-expanded="' + (S.fdMenu === p.id ? 'true' : 'false') + '" aria-label="More actions" title="More actions">' + fdIcon('ellipsis') + '</button>';
    if (s === 'working' && run) b += list
      ? '<button type="button" class="fd-ib" data-fd-stop="' + esc(p.id) + '" data-fk="stop" aria-label="Stop" title="Stop the run"' + (S.fdBusy && S.fdBusy[p.id] ? ' disabled' : '') + '>' + fdIcon('square') + '</button>'
      : '<button type="button" class="ax-btn ax-btn--ghost fd-xs" data-fd-stop="' + esc(p.id) + '" data-fk="stop"' + (S.fdBusy && S.fdBusy[p.id] ? ' disabled' : '') + '>' + fdIcon('square') + 'Stop</button>';
    else if (s === 'failed' && list) b += '<button type="button" class="fd-ib" data-fd-retry="' + esc(p.id) + '" data-fk="retry" aria-label="Retry" title="Retry the task"' + (S.fdBusy && S.fdBusy[p.id] ? ' disabled' : '') + '>' + fdIcon('rotate-ccw') + '</button>';
    return '<span class="fd-acts">' + b + '</span>';
  }
  /** One post in the feed. */
  function fdRowHtml(p) {
    var s = fdStateOf(p), run = s === 'working' ? fdLiveRun(p) : null, shown = !!S.shown[p.id];
    var text = fdExcerpt(p);
    var meta = [
      '<button type="button" class="fp__mi" data-thread="' + esc(p.id) + '" data-fk="thread" aria-expanded="' + (shown ? 'true' : 'false') + '">' + fdIcon('message-circle') + (shown ? 'Hide thread' : 'Thread') + '</button>',
      '<span class="fp__mi" title="Runs that worked on it">' + fdIcon('repeat-2') + p.runs + (p.runs === 1 ? ' run' : ' runs') + '</span>',
      p.runMs ? '<span class="fp__mi" title="Minutes the runs took">' + fdIcon('timer') + mins(p.runMs) + ' min</span>' : '',
      p.project ? '<span class="fp__mi fp__proj" title="Project">' + fdIcon('folder') + esc(p.project) + '</span>' : '',
      p.goal ? '<button type="button" class="fp__mi" data-goal="' + esc(p.goal.id) + '" title="Show every post for this goal">Goal: ' + esc(p.goal.title) + '</button>' : '',
    ].filter(Boolean).join('');
    var wait = s === 'waiting' || (s === 'needs' && !cardsOf(p).length) ? waitLine(p) : '';
    return '<article class="fp" data-key="p:' + esc(p.id) + '" id="post-' + esc(p.id) + '" data-post="' + esc(p.id) + '" tabindex="0" aria-label="' + esc(p.headline) + '">' +
      avatar(p.owner) +
      '<div class="fp__b">' +
        '<div class="fp__by"><button type="button" class="fp__name" data-agent="' + esc(p.owner) + '">' + esc(nameOf(p.owner)) + '</button>' +
          '<span class="fp__h">' + esc(p.owner) + '</span>' +
          '<a class="fp__time" href="' + esc(hashOf(p.id)) + '" data-open="' + esc(p.id) + '" title="Open this task">' + shortTime(p.lastMoveAt) + '</a>' +
          fdStateHtml(s) + '</div>' +
        '<h3 class="fp__t">' + esc(p.headline) + '</h3>' +
        (text && text !== p.headline ? '<p class="fp__x">' + esc(text) + '</p>' : '') +
        wsCopiesHtml(p, esc) +
        (wait ? '<p class="fp__wait">' + wait + '</p>' : '') +
        cardsOf(p).map(function (c) { return fdCardHtml(c, p); }).join('') +
        (s === 'failed' ? fdFailHtml(p) : '') +
        '<div class="fp__m">' + meta + fdActsHtml(p, s, run, false) + '</div>' +
        '<div class="wp__thread" data-for="' + esc(p.id) + '">' + (shown && S.threads[p.id] ? threadHtml(S.threads[p.id], p) : '') + '</div>' +
      '</div></article>';
  }
  /** A group's section: chevron, title, count; its rows capped at 3. */
  function fdSectionHtml(g) {
    var closed = g.key === 'done' || g.key === 'cancelled';
    return '<details class="axp-fold fd-sec" data-key="g:' + g.key + '" data-fold="feed.' + g.key + '"' + (closed ? ' data-fold-start="closed"' : '') + ' open>' +
      '<summary class="fd-sec__h">' + fdIcon('chevron-down', 'fd-sec__chev') + '<span class="fd-sec__t">' + esc(g.title) + '</span><span class="fd-sec__n" data-fd-n>' + g.posts.length + '</span></summary>' +
      '<div class="fd-rows" data-cap="feed.' + g.key + '">' + '</div></details>';
  }
  function fdEmptyHtml() {
    return '<div class="fd-empty"><p>No tasks match these filters.</p><button type="button" class="ax-btn ax-btn--ghost" data-fd-clear>Clear filters</button></div>';
  }
  /** Paints the feed, patching rows by key. */
  function fdPaintFeed(posts) {
    var box = $('wall-feed'), groups = fdGroups(posts);
    if (!posts.length) { if (!box._fdEmpty) { box.innerHTML = fdEmptyHtml(); box._fdEmpty = true; } return; }
    if (!fdReal(box)) {
      box.innerHTML = groups.map(function (g) {
        return fdSectionHtml(g).replace('</div></details>', g.posts.map(fdRowHtml).join('') + '</div></details>');
      }).join('');
      return;
    }
    if (box._fdEmpty) { box.innerHTML = ''; box._fdEmpty = false; }
    fdPatch(box, groups.map(function (g) { return { key: 'g:' + g.key, html: fdSectionHtml({ key: g.key, title: g.title, posts: [] }) }; }), fdMake, document);
    groups.forEach(function (g) {
      var sec = box.querySelector('[data-key="g:' + g.key + '"]');
      if (!sec) return;
      var n = sec.querySelector('[data-fd-n]');
      if (n && n.textContent !== String(g.posts.length)) n.textContent = String(g.posts.length);
      fdPatch(sec.querySelector('.fd-rows'), g.posts.map(function (p) { return { key: 'p:' + p.id, html: fdRowHtml(p) }; }), fdMake, document);
    });
  }

  // --- The status tabs: counts over what the other filters leave (C28) ---
  function fdPaintTabs(f) {
    var rest = Object.assign({}, f, { status: '' });
    var states = wsFold(((S.data && S.data.posts) || []).filter(function (p) { return match(p, rest); }), isOpen).map(fdStateOf);
    var tabs = [];
    document.querySelectorAll('[data-tab]').forEach(function (b) { tabs.push(b.getAttribute('data-tab')); });
    var n = fdCounts(states, tabs);
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      var c = b.querySelector && b.querySelector('[data-tab-n]');
      if (c && c.textContent !== String(n[b.getAttribute('data-tab')])) c.textContent = String(n[b.getAttribute('data-tab')]);
    });
  }
  /** "Synced 10:04", or "Not synced since 10:04" and Retry once stale. */
  function fdPaintSync(ms, failed) {
    var stale = failed || Date.now() - ms > 120000;
    $('wall-synced').textContent = fdClock(ms);
    $('wall-synced').setAttribute('datetime', new Date(ms).toISOString());
    $('wall-synced').setAttribute('title', stamp(ms));
    $('wall-sync-w').textContent = stale ? 'Not synced since' : 'Synced';
    $('wall-synced').parentNode.classList.toggle('is-stale', stale);
    $('wall-refresh').setAttribute('aria-label', stale ? 'Retry' : 'Refresh');
    $('wall-refresh').setAttribute('title', stale ? 'Retry' : 'Refresh');
  }

  // --- The List view: one table, sorted by a header button ---
  var FD_COLS = [['state', 'Status'], ['post', 'Task'], ['owner', 'Owner'], ['project', 'Project'], ['idle', 'Idle'], ['blocked', 'Waits on'], ['time', 'Time']];
  var FD_MORE = [['node', 'Node'], ['runs', 'Runs'], ['group', 'Group']];
  var FD_NUM = { idle: 1, time: 1, runs: 1 };
  /** Extra columns this browser chose, kept per user (C21). */
  function fdExtra() {
    if (S.fdExtra) return S.fdExtra;
    var v = [];
    try { v = JSON.parse(localStorage.getItem('${FD_COLS_KEY}') || '[]'); } catch (e) { v = []; }
    S.fdExtra = Array.isArray(v) ? v.filter(function (k) { return FD_MORE.some(function (c) { return c[0] === k; }); }) : [];
    return S.fdExtra;
  }
  function fdCols() {
    var x = fdExtra();
    return FD_COLS.concat(FD_MORE.filter(function (c) { return x.indexOf(c[0]) >= 0; }));
  }
  /** "2 d", "1 h", "38 m": how long it has not moved. */
  function fdIdle(p) {
    var m = Math.max(0, Math.floor((Date.now() - p.lastMoveAt) / 60000));
    return m < 60 ? m + ' m' : m < 1440 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + ' d';
  }
  function fdFlag(text) { return '<span class="fd-flag">' + fdIcon('triangle-alert') + esc(text) + '</span>'; }
  function fdCell(p, k, s) {
    if (k === 'state') {
      var flags = [];
      if (forgeClosedOpen(p)) flags.push(fdFlag('Closed on ' + forgeName(p.forgeState)));
      if (forgeOpenClosed(p)) flags.push(fdFlag('Open on ' + forgeName(p.forgeState)));
      if (p.concurrent && p.concurrent.length) flags.push(fdFlag((p.concurrent[0].runs || []).length + ' runs going'));
      if (p.awaitingQa) flags.push(fdFlag('Awaiting QA'));
      return '<td class="fl__st">' + fdStateHtml(s) + flags.join('') + '</td>';
    }
    if (k === 'post') {
      var ref = fdRef(p);
      return '<td class="fl__task"><a href="' + esc(hashOf(p.id)) + '" data-open="' + esc(p.id) + '" data-fk="open">' + esc(p.headline) + '</a>' + (ref ? ' <span class="fl__ref">' + esc(ref) + '</span>' : '') + '</td>';
    }
    if (k === 'owner') return '<td class="fl__own">' + avatar(p.owner, 'sm') + '<span>' + esc(nameOf(p.owner)) + '</span></td>';
    if (k === 'project') return '<td>' + (p.project ? esc(p.project) : '<span class="fl__none">None</span>') + '</td>';
    if (k === 'idle') return '<td class="num' + (isOpen(p) && idleDays(p) >= OLD_WAIT_DAYS ? ' is-amber' : '') + '">' + fdIdle(p) + '</td>';
    if (k === 'blocked') return '<td>' + (s === 'needs' ? 'You' : p.blocked ? esc(p.blocked.who) : '<span class="fl__none">None</span>') + '</td>';
    if (k === 'time') {
      var over = overEstimate(p);
      return '<td class="num">' + mins(p.runMs) + (p.estimateMinutes ? ' / ' + p.estimateMinutes : '') + (over ? fdFlag('Over') : '') + '</td>';
    }
    if (k === 'node') return '<td class="fl__mono">' + esc(p.node.name) + '</td>';
    if (k === 'runs') return '<td class="num">' + p.runs + (p.failedRuns ? ' <span class="fl__sub">(' + p.failedRuns + ' failed)</span>' : '') + '</td>';
    return '<td class="fl__mono">' + esc(groupKey(p)) + '</td>';
  }
  function fdListRowHtml(p, cols) {
    var s = fdStateOf(p), run = s === 'working' ? fdLiveRun(p) : null;
    return '<tr class="fl__r" data-key="p:' + esc(p.id) + '">' + cols.map(function (c) { return fdCell(p, c[0], s); }).join('') +
      '<td class="fl__a">' + fdActsHtml(p, s, run, true) + '</td></tr>';
  }
  function fdListHeadHtml(cols) {
    var k = S.sort.key, dir = S.sort.dir;
    return '<tr>' + cols.map(function (c) {
      var on = k === c[0];
      return '<th scope="col"' + (FD_NUM[c[0]] ? ' class="num"' : '') + ' aria-sort="' + (on ? (dir > 0 ? 'ascending' : 'descending') : 'none') + '">' +
        '<button type="button" data-sort="' + c[0] + '">' + c[1] + (on ? fdIcon(dir > 0 ? 'arrow-up' : 'arrow-down', 'fl__arr') : '') + '</button></th>';
    }).join('') + '<th scope="col" class="fl__a"><span class="fd-sr">Actions</span></th></tr>';
  }
  /** The value a column sorts by: the state in its order, the rest as before. */
  function fdSortVal(p, k) { return k === 'state' ? fdStates()[fdStateOf(p)].order : k === 'idle' ? -p.lastMoveAt : sortVal(p, k); }
  function fdListItems(posts, cols) {
    var rows = fdSortBy(posts, function (p) { return fdSortVal(p, S.sort.key); }, S.sort.dir);
    var by = $('f-grp').value;
    if (!by) return rows.map(function (p) { return { key: 'p:' + p.id, html: fdListRowHtml(p, cols) }; });
    var groups = {}, order = [];
    rows.forEach(function (p) {
      var g = by === 'blocked' ? blockKey(p, 'agent') : by === 'project' ? (p.project ? { key: p.project, label: p.project } : { key: '~', label: 'Other' }) : { key: p.owner, label: nameOf(p.owner) };
      if (!groups[g.key]) { groups[g.key] = { label: g.label, posts: [] }; order.push(g.key); }
      groups[g.key].posts.push(p);
    });
    var out = [];
    order.forEach(function (key) {
      var g = groups[key];
      out.push({ key: 'g:' + key, html: '<tr class="wl__g" data-key="g:' + esc(key) + '"><th colspan="' + (cols.length + 1) + '" scope="rowgroup">' + esc(g.label) + ' <small>' + g.posts.length + '</small></th></tr>' });
      g.posts.forEach(function (p) { out.push({ key: 'p:' + p.id, html: fdListRowHtml(p, cols) }); });
    });
    return out;
  }
  function fdListFootHtml(shown, total, open) {
    var words = shown + ' of ' + total + (open ? ' open tasks' : ' tasks') + '. Time in minutes, spent / estimate.';
    var more = total > FD_LIST_CAP ? '<button type="button" class="axp-more" data-fd-all aria-expanded="' + (S.fdAll ? 'true' : 'false') + '">' + (S.fdAll ? 'Show fewer' : 'Show all (' + total + ')') + '</button>' : '';
    return '<span>' + words + '</span>' + more;
  }
  /** Paints the List view, patching rows by key. */
  function fdPaintList(posts, f) {
    var box = $('wall-list'), cols = fdCols();
    if (!posts.length) { if (!box._fdEmpty) { box.innerHTML = fdEmptyHtml(); box._fdEmpty = true; } return; }
    var capped = S.fdAll ? posts : fdSortBy(posts, function (p) { return fdSortVal(p, S.sort.key); }, S.sort.dir).slice(0, FD_LIST_CAP);
    var items = fdListItems(capped, cols), head = fdListHeadHtml(cols), foot = fdListFootHtml(capped.length, posts.length, f.status === 'open');
    if (!fdReal(box)) {
      box.innerHTML = '<div class="fl"><table class="wl fl__t"><thead>' + head + '</thead><tbody>' + items.map(function (x) { return x.html; }).join('') + '</tbody></table></div><p class="fl__foot">' + foot + '</p>';
      return;
    }
    if (box._fdEmpty || !box.querySelector('tbody')) {
      box.innerHTML = '<div class="fl"><table class="wl fl__t"><thead></thead><tbody></tbody></table></div><p class="fl__foot"></p>';
      box._fdEmpty = false;
    }
    var th = box.querySelector('thead'), ft = box.querySelector('.fl__foot');
    if (th._fdHtml !== head) { th.innerHTML = head; th._fdHtml = head; }
    if (ft._fdHtml !== foot) { ft.innerHTML = foot; ft._fdHtml = foot; }
    fdPatch(box.querySelector('tbody'), items, function (html) {
      var t = document.createElement('tbody');
      t.innerHTML = html.trim();
      return t.firstElementChild;
    }, document);
  }
  /** The Group and columns menu: the grouping select and a box per extra column. */
  function fdPaintColMenu() {
    var x = fdExtra();
    document.querySelectorAll('[data-fd-col]').forEach(function (b) { b.checked = x.indexOf(b.getAttribute('data-fd-col')) >= 0; });
  }

  // --- The ... menu: what a task can do besides its primary action ---
  function fdMenuOpen(id, btn) {
    var m = $('fd-menu');
    if (!m || !m.getBoundingClientRect) return;
    if (S.fdMenu === id) { fdMenuClose(true); return; }
    fdMenuClose(false);
    S.fdMenu = id;
    btn.setAttribute('aria-expanded', 'true');
    S.fdMenuBtn = btn;
    m.hidden = false;
    var r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    var top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    m.style.top = top + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    var first = m.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }
  function fdMenuClose(refocus) {
    var m = $('fd-menu');
    if (m) m.hidden = true;
    var b = S.fdMenuBtn;
    S.fdMenu = ''; S.fdMenuBtn = null;
    if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus && b.focus) b.focus(); }
  }
  async function fdMenuDo(kind) {
    var id = S.fdMenu, p = findPost(id);
    fdMenuClose(false);
    if (!p) return;
    if (kind === 'call') {
      fdSay(p.id, 'Calling…');
      var c = await act('POST', '/api/admin/wall/call', { id: p.id }, p.node && p.node.peer);
      fdSay(p.id, c.ok ? nameOf(p.owner) + ' is calling you on AgentX Voice.' : 'No call: ' + c.error);
      return;
    }
    // The rest ask for more (who, which machine, the closing words): the
    // task opens with that part ready, where it is done today.
    openPost(p.id);
    var focus = { hand: 'wdo-hand', runon: 'wro-node', space: 'wdo-with' }[kind];
    if (kind === 'done') closeAsk('done');
    else if (focus && $(focus) && $(focus).focus) $(focus).focus();
  }
  /** One line under a task's row, in words: what an action did. */
  function fdSay(id, text) {
    S.fdSaid = S.fdSaid || {};
    S.fdSaid[id] = text;
    render();
  }
  async function fdRetry(id) {
    var p = findPost(id);
    if (!p) return;
    S.fdBusy = S.fdBusy || {};
    S.fdBusy[id] = true;
    fdSay(id, 'Asking ' + nameOf(p.owner) + ' to try again…');
    var why = p.lastFailure ? ' The last run (' + p.lastFailure.taskId + ') failed: ' + p.lastFailure.error : '';
    var r = await act('POST', '/api/admin/wall/comment', { id: p.id, text: 'Please try this again.' + why }, p.node && p.node.peer);
    delete S.fdBusy[id];
    fdSay(id, r.ok ? 'Asked ' + nameOf(p.owner) + ' to try again.' : 'Not sent: ' + r.error);
    if (r.ok) load();
  }
  async function fdStop(id) {
    var p = findPost(id), run = p && fdLiveRun(p);
    if (!run) return;
    S.fdBusy = S.fdBusy || {};
    S.fdBusy[id] = true;
    render();
    var r = await fetch('/api/task/action?node=' + encodeURIComponent(run.node) + '&task=' + encodeURIComponent(run.task) + '&kind=cancel',
      { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), body: JSON.stringify({ reason: 'Stopped from the Hub' }) })
      .then(function (x) { return x.ok; }).catch(function () { return false; });
    delete S.fdBusy[id];
    fdSay(id, r ? 'Stopped.' : 'Could not stop it. Try again.');
    if (r) load();
  }
  function fdCopy(id) {
    var url = location.origin + location.pathname + hashOf(id);
    var done = function () {
      S.fdCopied = id;
      render();
      setTimeout(function () { if (S.fdCopied === id) { S.fdCopied = ''; render(); } }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () {});
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-fd-retry],[data-fd-stop],[data-fd-copy],[data-fd-menu],[data-fd-do],[data-fd-clear],[data-fd-all],[data-fd-pop],[data-fd-q]');
    // A click outside an open menu or popover closes it.
    if (S.fdMenu && !(t && (t.hasAttribute('data-fd-do') || t.hasAttribute('data-fd-menu'))) && !(ev.target.closest && ev.target.closest('#fd-menu'))) fdMenuClose(false);
    if (!(t && t.hasAttribute('data-fd-pop')) && !(ev.target.closest && ev.target.closest('.fd-pop'))) fdPopClose();
    if (!t) return;
    if (t.hasAttribute('data-fd-retry')) fdRetry(t.getAttribute('data-fd-retry'));
    else if (t.hasAttribute('data-fd-stop')) fdStop(t.getAttribute('data-fd-stop'));
    else if (t.hasAttribute('data-fd-copy')) fdCopy(t.getAttribute('data-fd-copy'));
    else if (t.hasAttribute('data-fd-menu')) fdMenuOpen(t.getAttribute('data-fd-menu'), t);
    else if (t.hasAttribute('data-fd-do')) fdMenuDo(t.getAttribute('data-fd-do'));
    else if (t.hasAttribute('data-fd-all')) { S.fdAll = !S.fdAll; render(); }
    else if (t.hasAttribute('data-fd-pop')) fdPopToggle(t);
    else if (t.hasAttribute('data-fd-q')) { var h = document.querySelector('.ax-wall__head'); var on = h.classList.toggle('is-q'); t.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) $('f-q').focus(); }
    else if (t.hasAttribute('data-fd-clear')) {
      FILTERS.forEach(function (k) { var el = $('f-' + k); if (k === 'status') el.value = 'open'; else if (el.type === 'checkbox') el.checked = false; else el.value = ''; });
      writeHash(); render();
    }
  });
  /** A popover (Filters, Group and columns): one open at a time. */
  function fdPopToggle(btn) {
    var pop = $(btn.getAttribute('aria-controls')), open = btn.getAttribute('aria-expanded') !== 'true';
    fdPopClose();
    if (!open || !pop) return;
    pop.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    var f = pop.querySelector('select,input,button');
    if (f && f.focus) f.focus();
  }
  function fdPopClose(refocus) {
    document.querySelectorAll('[data-fd-pop][aria-expanded="true"]').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
      var pop = $(b.getAttribute('aria-controls'));
      if (pop) pop.classList.remove('is-open');
      if (refocus && b.focus) b.focus();
    });
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-fd-col')) return;
    var k = t.getAttribute('data-fd-col'), x = fdExtra().filter(function (c) { return c !== k; });
    if (t.checked) x.push(k);
    S.fdExtra = x;
    try { localStorage.setItem('${FD_COLS_KEY}', JSON.stringify(x)); } catch (e) { /* private mode: this page only */ }
    render();
  });
  document.addEventListener('keydown', function (ev) {
    var m = $('fd-menu');
    if (S.fdMenu && m && !m.hidden) {
      var items = Array.prototype.slice.call(m.querySelectorAll('[role="menuitem"]')), i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); fdMenuClose(true); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); var n = items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]; if (n) n.focus(); return; }
    }
    if (ev.key === 'Escape' && document.querySelector('[data-fd-pop][aria-expanded="true"]')) { fdPopClose(true); return; }
    // "/" goes to the search box, unless a field is in use.
    var tag = ev.target && ev.target.tagName;
    if (ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(tag || '') && !(ev.target && ev.target.isContentEditable) && $('f-q') && $('f-q').offsetParent !== null) {
      ev.preventDefault();
      $('f-q').focus();
    }
  });
  window.addEventListener('resize', function () { if (S.fdMenu) fdMenuClose(false); });
`

export const WALL_FEED_CSS = `
/* The feed and its List view (#2101, wall-feed.client.ts): the approved mock. */
.fd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ax-wall.is-posts .ax-wall__main > :is(.ax-wall__head, .fd-compose, .fd-bar, .ax-wall__sub, .ax-wall__feed) { max-width: 720px; margin-left: auto; margin-right: auto; }
.ax-wall.is-posts.is-wide .ax-wall__main > :is(.ax-wall__head, .fd-bar, .ax-wall__sub, .ax-wall__list) { max-width: 976px; margin-left: auto; margin-right: auto; }
.ax-wall.is-posts .ax-wall__head { position: static; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-bottom: 0; }
.ax-wall.is-posts .ax-wall__titlebar { padding: 24px 0 16px; gap: 8px; flex-wrap: wrap; }
.ax-wall.is-posts .ax-wall__titlebar h1 { font-size: var(--ax-fs-pane); font-weight: var(--ax-fw-strong); letter-spacing: -.01em; }
/* The build line sits after the tools, so search, Filters and Chat stay one group on the right. */
.ax-wall.is-posts .ax-wall__titlebar > .wbl { margin-left: 0; padding-left: 0; }
.ax-wall.is-posts .ax-wall__titlebar > .wbl.is-wait { display: none; }

/* Feed | List: a toggle group beside the title. */
.fd-switch { display: inline-flex; gap: 2px; padding: 2px; margin-left: 4px; border-radius: var(--ax-radius-md); background: var(--ax-surface-3); }
.fd-switch button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; font: inherit; font-size: var(--ax-fs-sm); font-weight: 500; color: var(--ax-muted); background: none; border: 0; border-radius: calc(var(--ax-radius-md) - 2px); cursor: pointer; }
.fd-switch button svg { width: 14px; height: 14px; }
.fd-switch button.is-on { background: var(--ax-bg); color: var(--ax-text); box-shadow: var(--ax-shadow-xs); }
@media (hover: hover) { .fd-switch button:not(.is-on):hover { color: var(--ax-text); } }

/* Search, Filters, Group and columns: the tools on the right. */
.fd-tools { position: relative; margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.fd-q { display: inline-flex; align-items: center; gap: 8px; height: 32px; width: 200px; padding: 0 6px 0 10px; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-md); background: var(--ax-bg); color: var(--ax-muted); }
.fd-q svg { width: 16px; height: 16px; flex: none; }
.fd-q input { flex: 1; min-width: 0; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: none; border: 0; padding: 0; outline: none; }
.fd-q input::-webkit-search-cancel-button { display: none; }
.fd-q:focus-within { border-color: var(--ax-ring, var(--ax-accent)); box-shadow: var(--ax-focus-ring); }
/* Key names, as in the mock: small, in the body font, on a quiet chip. */
.fd-q kbd, .fd-hint kbd { font-family: inherit; font-size: 11px; line-height: 16px; padding: 0 5px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-muted); }
.fd-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; }
.fd-btn svg { width: 16px; height: 16px; }
.fd-btn b { font-weight: 500; font-variant-numeric: tabular-nums; }
.fd-btn b:empty { display: none; }
.fd-ib { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--ax-radius-md); background: none; color: var(--ax-muted); cursor: pointer; flex: none; }
.fd-ib svg { width: 16px; height: 16px; }
.fd-ib:disabled { opacity: .5; cursor: default; }
@media (hover: hover) { .fd-ib:hover:not(:disabled) { background: var(--ax-surface-3); color: var(--ax-text); } }
.ax-wall__titlebar > .fd-ib, .fd-tools > .fd-ib { width: 32px; height: 32px; }
.fd-tools > .fd-ib[aria-expanded="true"] { background: var(--ax-surface-3); color: var(--ax-text); }
.fd-qbtn { display: none !important; }
/* A popover: floating, so it may carry a shadow (C7). */
.fd-pop { position: absolute; top: calc(100% + 6px); right: 0; z-index: 20; width: min(560px, calc(100vw - 32px)); padding: 12px; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); box-shadow: var(--ax-shadow-lg); }
.fd-pop:not(.is-open) { display: none; }
.ax-wall__filters.fd-pop { display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; border-bottom: 1px solid var(--ax-border); }
.ax-wall__filters.fd-pop:not(.is-open) { display: none; }
.fd-pop .ax-wall__fset { padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.fd-pop .ax-wall__fset label { display: flex; flex-direction: column; align-items: stretch; gap: 4px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.fd-pop .ax-wall__fset label.ax-wall__check { flex-direction: row; align-items: center; gap: 6px; color: var(--ax-text-2); }
.fd-pop select { font: inherit; font-size: var(--ax-fs-sm); max-width: none; height: 32px; padding: 0 8px; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-md); background: var(--ax-bg); color: var(--ax-text); }
.fd-pop .ax-wall__saved { justify-content: flex-end; border-top: 1px solid var(--ax-border); padding-top: 10px; }
.fd-cols { width: 240px; display: flex; flex-direction: column; gap: 8px; font-size: var(--ax-fs-sm); }
.fd-cols h2 { margin: 0; font-size: 11px; font-weight: 500; color: var(--ax-muted); }
.fd-cols label { display: flex; align-items: center; gap: 8px; color: var(--ax-text-2); }
.fd-cols label.fd-cols__grp { flex-direction: column; align-items: stretch; gap: 4px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.fd-cols hr { border: 0; border-top: 1px solid var(--ax-border); margin: 2px 0; width: 100%; }

/* The composer: one bordered box, tools left, send right (A1). */
.fd-compose { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; padding: 12px 12px 8px 16px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-bg); box-shadow: var(--ax-shadow-xs); }
.fd-compose:focus-within { border-color: var(--ax-border-2); }
.fd-compose textarea { width: 100%; min-height: 24px; max-height: 200px; font: inherit; font-size: var(--ax-fs); line-height: 1.5; color: var(--ax-text); background: none; border: 0; resize: none; padding: 0; outline: none; field-sizing: content; }
.fd-compose textarea::placeholder { color: var(--ax-muted); }
/* The box shows focus (its border), not the field inside it. */
.fd-compose textarea:focus, .fd-compose textarea:focus-visible { outline: none; box-shadow: none; }
.fd-compose__row { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.fd-pick { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; border-radius: var(--ax-radius-md); color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.fd-pick svg { width: 14px; height: 14px; flex: none; color: var(--ax-muted); }
.fd-pick select { appearance: none; -webkit-appearance: none; font: inherit; color: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; max-width: 160px; field-sizing: content; }
.fd-pick:focus-within { box-shadow: var(--ax-focus-ring); }
@media (hover: hover) { .fd-pick:hover { background: var(--ax-surface-3); } }
.fd-compose .wdo__n { font-size: var(--ax-fs-xs); }
.fd-hint { margin-left: auto; font-size: var(--ax-fs-xs); color: var(--ax-muted); white-space: nowrap; }
.fd-hint kbd { margin-right: 2px; }
.fd-send { display: inline-grid; place-items: center; width: 32px; height: 32px; flex: none; padding: 0; border: 0; border-radius: 50%; background: var(--ax-primary); color: var(--ax-primary-fg); cursor: pointer; }
.fd-send svg { width: 16px; height: 16px; }
.fd-send:disabled { background: var(--ax-surface-3); color: var(--ax-muted); cursor: default; }
.fd-compose .wdo__n:empty + .fd-hint { margin-left: auto; }

/* Status tabs with counts, and the quiet "Synced" line. */
.fd-bar { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--ax-border); position: sticky; top: 0; z-index: 3; background: var(--ax-bg); }
.fd-bar .ax-wall__views { flex: 1; min-width: 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.fd-bar .ax-wall__views button { flex: none; display: inline-flex; align-items: baseline; gap: 6px; height: 40px; padding: 0 10px; font-size: var(--ax-fs-sm); font-weight: 500; color: var(--ax-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.fd-bar .ax-wall__views button.is-on { color: var(--ax-text); border-bottom-color: var(--ax-text); }
@media (hover: hover) { .fd-bar .ax-wall__views button:hover { background: none; color: var(--ax-text); } }
.fd-n { font-size: var(--ax-fs-xs); font-weight: 400; color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.fd-n.is-err:not(:empty) { color: var(--ax-red-ink); }
button[data-tab="failed"] .fd-n:not(:empty) { color: var(--ax-red-ink); }
.fd-sync { flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); white-space: nowrap; }
.fd-sync > svg { width: 14px; height: 14px; }
.fd-sync.is-stale { color: var(--ax-amber-ink); }
.fd-sync .fd-ib { width: 24px; height: 24px; }
.fd-sync .fd-ib svg { width: 14px; height: 14px; }
.fd-sync.is-stale > svg { display: none; }
.ax-wall.is-posts .ax-wall__sub { padding: 0; }
.ax-wall.is-posts .ax-wall__sub .ax-wall__count:not(:has(.ax-wall__asker)) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ax-wall.is-posts .ax-wall__sub .ax-wall__count:has(.ax-wall__asker) { display: block; padding: 8px 0 0; }

/* Groups: chevron, title, count; a hairline under the header. */
.ax-wall__feed { padding-bottom: 48px; }
.fd-sec { margin: 0; }
.fd-sec > summary.fd-sec__h { display: flex; align-items: center; gap: 8px; margin: 0; padding: 16px 0 10px; border-bottom: 1px solid var(--ax-border); border-radius: 0;
  font-size: var(--ax-fs-sm); font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--ax-text); }
.fd-sec > summary.fd-sec__h::before { content: none; display: none; }
.fd-sec__chev { width: 16px; height: 16px; color: var(--ax-muted); transition: transform 150ms ease-out; }
.fd-sec:not([open]) .fd-sec__chev { transform: rotate(-90deg); }
.fd-sec__n { font-size: var(--ax-fs-sm); font-weight: 400; color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.fd-sec .axp-more { margin: 4px 0 8px 44px; }

/* A task in the feed. */
.fp { display: flex; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--ax-border); cursor: pointer; border-radius: 0; }
.fp:focus-visible { outline: none; box-shadow: var(--ax-focus-ring); border-radius: var(--ax-radius-md); }
.fp > .av, .fl__own .av { --av-size: 28px; width: 28px; height: 28px; border-radius: var(--ax-radius-md); background: var(--ax-surface-2); color: var(--ax-text-2); border: 1px solid var(--ax-border); font-size: 11px; font-weight: 600; }
.fp > .av.is-live::after, .fl__own .av.is-live::after { display: none; }
.fp__b { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.fp__by { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.fp__name { font: inherit; font-weight: 500; color: var(--ax-text); background: none; border: 0; padding: 0; cursor: pointer; }
.fp__h { font-family: var(--ax-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fp__time { color: var(--ax-muted); text-decoration: none; flex: none; }
@media (hover: hover) { .fp__name:hover, .fp__time:hover { text-decoration: underline; } }
.fd-st { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: var(--ax-fs-sm); align-self: center; }
.fd-st svg { width: 14px; height: 14px; flex: none; }
.fd-st.is-warn { color: var(--ax-amber-ink); }
.fd-st.is-err { color: var(--ax-red-ink); }
.fd-st.is-text { color: var(--ax-text); }
.fd-st.is-muted { color: var(--ax-muted); }
.fd-st.is-ok { color: var(--ax-muted); }
.fd-st.is-ok svg { color: var(--ax-green); }
/* The one turning icon: it says "still alive" (motion.md rule 7). */
.fd-spin { animation: fd-spin 1s linear infinite; }
@keyframes fd-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fd-spin { animation: none; } .fd-sec__chev { transition: none; } }
.fp__t { margin: 0; font-size: var(--ax-fs); font-weight: 500; line-height: 1.4; color: var(--ax-text); overflow-wrap: anywhere; }
.fp__x { margin: 0; font-size: var(--ax-fs-sm); line-height: 1.5; color: var(--ax-text-2); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fp__wait { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.fp__wait b { font-weight: 500; color: var(--ax-text-2); }
.fp .wp__copies { margin: 0; }
.fp__m { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin-top: 6px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.fp__mi { display: inline-flex; align-items: center; gap: 5px; font: inherit; color: inherit; background: none; border: 0; padding: 0; text-decoration: none; }
.fp__mi svg { width: 14px; height: 14px; flex: none; }
button.fp__mi { cursor: pointer; }
@media (hover: hover) { button.fp__mi:hover { color: var(--ax-text); } }
.fd-acts { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; }
.fd-acts .fd-xs { margin-left: 6px; }
/* Link and ... show on hover or focus, and always on touch (C12). */
@media (hover: hover) {
  .fd-hov { opacity: 0; transition: opacity 120ms ease-out; }
  .fp:hover .fd-hov, .fp:focus-within .fd-hov, .fl__r:hover .fd-hov, .fl__r:focus-within .fd-hov, .fd-hov[aria-expanded="true"] { opacity: 1; }
}
.fd-xs { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; font-size: var(--ax-fs-xs); }
.fd-xs svg { width: 14px; height: 14px; }
.fp .wp__thread:empty { display: none; }

/* A card that waits on you: question, facts, Deny and Approve. */
.fd-card { margin-top: 8px; padding: 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-md); background: var(--ax-bg); font-size: var(--ax-fs-sm); cursor: default; }
.fd-card__t { margin: 0 0 8px; font-weight: 500; color: var(--ax-text); overflow-wrap: anywhere; }
.fd-card__f { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; margin: 0 0 8px; font-size: var(--ax-fs-sm); }
.fd-card__f dt { color: var(--ax-muted); }
.fd-card__f dd { margin: 0; color: var(--ax-text); overflow-wrap: anywhere; }
.fd-card__foot { display: flex; align-items: center; gap: 8px; }
.fd-card__exp { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.fd-card__exp svg { width: 14px; height: 14px; }
.fd-card__exp.is-late { color: var(--ax-red-ink); }
.fd-card__btns { margin-left: auto; display: inline-flex; gap: 8px; }
.fd-card__btns .ax-btn { height: 32px; min-width: 0; padding: 0 12px; }
/* Deny is the quiet choice beside Approve: no border at rest (C11). */
.fd-card__btns .ax-btn--ghost { border-color: transparent; background: none; box-shadow: none; }
.fd-card .wdc__confirm { margin-top: 8px; }

/* A failed run: its reason, the run id, Retry. The one red. */
.fd-fail { display: flex; align-items: center; gap: 12px; margin-top: 6px; padding: 8px 8px 8px 12px; border: 1px solid var(--ax-red-e, var(--ax-red-t)); border-radius: var(--ax-radius-md); background: var(--ax-red-t); color: var(--ax-red-ink); cursor: default; }
.fd-fail__w { flex: 1; min-width: 0; margin: 0; font-size: var(--ax-fs-sm); overflow-wrap: anywhere; }
.fd-fail code { font-family: var(--ax-mono); font-size: 12px; }
.fd-fail__said { color: var(--ax-text-2); }
.fd-fail .ax-btn { flex: none; background: var(--ax-bg); }

/* The ... menu: floating. */
.fd-menu { position: fixed; z-index: 30; min-width: 208px; padding: 4px; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-md); box-shadow: var(--ax-shadow-lg); transform-origin: top right; animation: fd-pop 150ms ease-out; }
@keyframes fd-pop { from { opacity: 0; transform: scale(.95); } }
@media (prefers-reduced-motion: reduce) { .fd-menu { animation: none; } }
.fd-menu [role="menuitem"] { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: none; border: 0; border-radius: var(--ax-radius-sm); cursor: pointer; text-align: left; }
.fd-menu [role="menuitem"] svg { width: 16px; height: 16px; color: var(--ax-muted); }
.fd-menu [role="menuitem"]:focus-visible, .fd-menu [role="menuitem"]:focus { outline: none; background: var(--ax-surface-3); box-shadow: none; }
@media (hover: hover) { .fd-menu [role="menuitem"]:hover { background: var(--ax-surface-3); } }
.fd-menu hr { border: 0; border-top: 1px solid var(--ax-border); margin: 4px -4px; }

.fd-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 16px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.fd-empty p { margin: 0; }

/* The List view: one bordered table, hairlines between rows (recipes §8). */
.ax-wall__list.fl-box, .ax-wall__list { overflow: visible; }
.fl { margin-top: 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); overflow-x: auto; background: var(--ax-bg); }
.fl__t { width: 100%; border-collapse: collapse; font-size: var(--ax-fs-sm); }
.fl__t th, .fl__t td { padding: 10px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; text-align: left; }
.fl__t th:first-child, .fl__t td:first-child { padding-left: 16px; }
.fl__t tbody tr:last-child td { border-bottom: 0; }
.fl__t thead th { padding-top: 8px; padding-bottom: 8px; font-size: var(--ax-fs-xs); font-weight: 500; color: var(--ax-muted); white-space: nowrap; cursor: default; }
.fl__t thead th button { display: inline-flex; align-items: center; gap: 4px; font: inherit; color: inherit; background: none; border: 0; padding: 2px 4px; margin: -2px -4px; border-radius: var(--ax-radius-sm); cursor: pointer; }
.fl__t thead th[aria-sort="ascending"] button, .fl__t thead th[aria-sort="descending"] button { color: var(--ax-text); }
@media (hover: hover) { .fl__t thead th button:hover { color: var(--ax-text); background: var(--ax-surface-3); } }
.fl__arr { width: 14px; height: 14px; }
.fl__t .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fl__t thead th.num button { flex-direction: row; }
@media (hover: hover) { .fl__r:hover { background: var(--ax-surface-2); } }
.fl__st .fd-st { margin: 0; display: flex; white-space: nowrap; }
.fd-flag { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-amber-ink); white-space: nowrap; }
.fd-flag svg { width: 14px; height: 14px; flex: none; }
.num .fd-flag { justify-content: flex-end; }
.fl__task { min-width: 220px; }
.fl__task a { font-weight: 500; color: var(--ax-text); text-decoration: none; overflow-wrap: anywhere; }
@media (hover: hover) { .fl__task a:hover { text-decoration: underline; } }
.fl__ref, .fl__mono { font-family: var(--ax-mono); font-size: 12px; color: var(--ax-muted); }
.fl__own { white-space: nowrap; }
.fl__t td { line-height: 20px; }
.fl__own .av { display: inline-grid; place-items: center; width: 20px; height: 20px; font-size: 10px; line-height: 1; vertical-align: top; margin-right: 8px; cursor: default; }
.fl__none, .fl__sub { color: var(--ax-muted); }
.fl__t .is-amber { color: var(--ax-amber-ink); font-weight: 400; }
.fl__a { width: 1%; white-space: nowrap; text-align: right; }
.fl__a .fd-acts { margin: -4px 0; }
.fl__t .wl__g th { background: var(--ax-surface-2); color: var(--ax-text); font-size: var(--ax-fs-sm); font-weight: 500; }
.fl__t .wl__g small { color: var(--ax-muted); font-weight: 400; margin-left: 6px; }
.fl__foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 32px; padding: 0 0 0 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.fl__foot .axp-more { margin: 0; }

/* Mid width: the side menu is a rail; the search box is shorter. */
@media (max-width: 1180px) {
  .ax-wall.is-posts .ax-wall__main > :is(.ax-wall__head, .fd-compose, .fd-bar, .ax-wall__sub, .ax-wall__feed) { padding-left: 24px; padding-right: 24px; max-width: 768px; }
  .ax-wall.is-posts.is-wide .ax-wall__main > :is(.ax-wall__head, .fd-bar, .ax-wall__sub, .ax-wall__list) { padding-left: 24px; padding-right: 24px; max-width: none; }
  .ax-wall.is-posts .ax-wall__main > .fd-compose { margin-left: 24px; margin-right: 24px; padding-left: 16px; padding-right: 12px; }
  @media (min-width: 769px) { .ax-wall.is-posts .ax-wall__main > .fd-compose { margin-left: auto; margin-right: auto; max-width: 720px; } }
  .fd-q { width: 160px; }
  .fd-hint { display: none; }
  .fd-compose__row .fd-send { margin-left: auto; }
  /* The tabs' hairline ends where the rows end. */
  .ax-wall.is-posts .ax-wall__main > .fd-bar { padding-left: 0; padding-right: 0; max-width: min(720px, calc(100% - 48px)); }
}
/* Phone: the title row, then Feed | List full width; search is an icon. */
@media (max-width: 640px) {
  .ax-wall.is-posts .ax-wall__main > :is(.ax-wall__head, .fd-bar, .ax-wall__sub, .ax-wall__feed, .ax-wall__list) { padding-left: 16px; padding-right: 16px; }
  .ax-wall.is-posts .ax-wall__main > .fd-compose { margin: 0 16px 12px; }
  .ax-wall.is-posts .ax-wall__main > .fd-bar { max-width: none; }
  .ax-wall.is-posts .ax-wall__titlebar { padding: 12px 0; }
  .ax-wall.is-posts .ax-wall__titlebar h1 { font-size: 20px; }
  .fd-switch { order: 10; flex: 1 0 100%; margin: 4px 0 0; }
  .fd-switch button { flex: 1; justify-content: center; height: 32px; }
  .fd-q { display: none; }
  .ax-wall__head.is-q .fd-q { display: inline-flex; order: 11; flex: 1 0 100%; width: auto; height: 40px; }
  .ax-wall__head.is-q .fd-tools { flex-wrap: wrap; }
  .fd-qbtn { display: inline-grid !important; }
  .fd-btn span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .fd-btn { border-color: transparent; box-shadow: none; background: none; padding: 0 8px; }
  .fd-compose textarea { font-size: 16px; }
  .fd-sync { display: none; }
  .fd-bar { position: static; }
  /* The tabs scroll sideways: the clipped edge fades (C26). */
  .fd-bar .ax-wall__views { -webkit-mask-image: linear-gradient(to right, #000 85%, transparent); mask-image: linear-gradient(to right, #000 85%, transparent); }
  .fd-bar .ax-wall__views button { padding: 0 8px; }
  .fp { gap: 12px; }
  .fp__h { display: none; }
  /* The phone row keeps thread, runs and minutes, and the ... menu (mock). */
  .fp__proj, .fd-hov[data-fd-copy] { display: none; }
  .fp__m { flex-wrap: nowrap; }
  .fp__m > .fp__mi { white-space: nowrap; }
  .fd-card__f { grid-template-columns: 80px 1fr; }
  .fd-pop { position: fixed; top: auto; left: 8px; right: 8px; width: auto; }
  .fd-pop .ax-wall__fset { grid-template-columns: 1fr; }
  /* The table becomes stacked rows: title, then state and meta. */
  .fl { border: 0; border-radius: 0; overflow: visible; margin-top: 0; }
  .fl__t thead { display: none; }
  .fl__t, .fl__t tbody { display: block; }
  .fl__t tr.fl__r { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 12px 0; border-bottom: 1px solid var(--ax-border); }
  .fl__t tr.fl__r td { display: block; padding: 0; border: 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
  .fl__t tr.fl__r td:first-child { padding-left: 0; }
  .fl__t tr.fl__r td.fl__task { order: -1; flex: 1 0 100%; min-width: 0; padding-right: 64px; font-size: var(--ax-fs-sm); }
  /* The row's actions sit at the end of the title line. */
  .fl__t tr.fl__r td.fl__a { position: absolute; top: 8px; right: 0; width: auto; }
  .fl__t tr.fl__r td.num { text-align: left; }
  .fl__t tr.fl__r td.num .fd-flag { display: inline-flex; margin: 0 0 0 8px; vertical-align: top; }
  /* An empty cell ("None") says nothing on a stacked row. */
  .fl__t tr.fl__r td:has(> .fl__none:only-child) { display: none; }
  .fl__st .fd-st, .fd-flag { font-size: var(--ax-fs-xs); }
  .fl__st { display: flex !important; gap: 8px; align-items: center; }
  .fl__st .fd-flag { margin: 0; }
}
`
