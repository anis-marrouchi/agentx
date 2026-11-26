// --- The Hub's left column in the browser (#2101 P4, hub-nav.ts) ---
//
// Paints the agents (hub-agents.ts) from the live snapshot the page
// already follows (S.live) and the Needs you list (decAll), each time the
// tree is painted (every snapshot, 2 s). Drawn only when it changed.
// ⌘K (Ctrl K) opens the switcher; ⌘1…⌘9 open the agents in its order
// (Alt 1…9 too, as ⌘1 is the browser's own tab key); ⌃Tab goes back to the
// last agent. Opening an agent is its chat link, #page=chat&agent=, which
// opens its latest conversation (wall-chat.client.ts switchAgent); a
// working agent opens its live run instead, from the list (#2270) and from
// ⌘K and ⌘1…9 (#2101 R26, wall-task.client.ts wallTaskHref).
//
// A fragment of WALL_PAGE_SCRIPT: it uses S, $, esc, decAll, decOwner,
// isOpen, hlNavHidden (hub-layout.ts) and the injected hubAgentRows, haListHtml, haSwitchHits,
// haSwitchHtml, haHitCount, ltAge.

export const HUB_NAV_SCRIPT = String.raw`
  // What the reader opened (Anis 2026-11-26, orca-design C21): saved like the
  // filter. A first visit starts with Needs you folded and Working at 3 rows.
  // Every group folds (#2352): Working starts open, the others folded.
  var HA = { filter: 'all', open: { needs: false, working: false, idle: false, work: true, done: false, needsAll: false }, last: '', model: null, cur: '', prev: '', k: { q: '', sel: 0, hits: null, back: null } };
  try { HA.filter = localStorage.getItem('ax.hub.agentFilter') || 'all'; } catch (e) { /* private mode */ }
  try {
    var haSaved = JSON.parse(localStorage.getItem('ax.hub.agentOpen') || '{}');
    for (var hk in HA.open) if (typeof haSaved[hk] === 'boolean') HA.open[hk] = haSaved[hk];
  } catch (e) { /* private mode or bad value: keep the defaults */ }
  function haSaveOpen() { try { localStorage.setItem('ax.hub.agentOpen', JSON.stringify(HA.open)); } catch (e) { /* private mode */ } }
  // The agent in view: its chat, or the Task page of one of its runs (R26).
  function haChatAgent() {
    var m = /(?:^#|&)page=(?:chat|task)(?:&|$)/.test(location.hash) && /(?:^#|&)agent=([^&]*)/.exec(location.hash);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    var hc = window.AXHubChat;
    return hc && document.querySelector('.ax-wall.hc-open') && typeof hc.agent === 'function' ? hc.agent() || '' : '';
  }
  /** Where a row goes (#2101 R26): a working agent's live run, streaming on
   *  its Task page; any other agent, its chat. */
  function haHref(r) {
    return (r && r.state === 'working' && r.taskId && haRunHref(r)) || haChatHref(r);
  }
  function haDayStart() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function haModel() {
    var nodes = (S.live && S.live.nodes) || [];
    var needs = typeof decAll === 'function' ? decAll() : [];
    return hubAgentRows(nodes, needs, Date.now(), haDayStart(), function (t) { return ltTitle(t, null); }, ltPlain, liveWorkCount(nodes));
  }
  /** A working row's run, on its Task page
   *  (wall-task.client.ts wallTaskHref, #2270); '' when the run is gone. */
  function haRunHref(r) {
    var nodes = (S.live && S.live.nodes) || [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || (n.url || '') !== r.nodeUrl) continue;
      var a = (n.agents || []).filter(function (x) { return x && x.id === r.id; })[0];
      var t = a && (a.runningTasks || []).filter(function (x) { return x && x.id === r.taskId; })[0];
      if (t) return wallTaskHref(t, r.id, n.url);
    }
    return '';
  }
  function renderHubAgents() {
    hsPaintRunning();
    var el = $('hub-agents');
    if (!el) return;
    // No machine read yet, or the live read failed with none: say so (it
    // is the side menu's only live list since #2101 R26).
    var none = !S.live || (S.liveError && !(S.live.nodes || []).length);
    if (none) { if (S.liveError) { HA.last = ''; el.innerHTML = '<p class="ha__empty">Could not reach the machines just now; trying again.</p>'; } return; }
    HA.model = haModel();
    HA.cur = haChatAgent();
    var html = haListHtml(HA.model, HA.filter, HA.cur, HA.open, esc, ltAge, haRunHref);
    if (html === HA.last) return;
    HA.last = html;
    el.innerHTML = html;
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var chip = t.closest('[data-ha-filter]');
    if (chip) {
      HA.filter = chip.getAttribute('data-ha-filter');
      try { localStorage.setItem('ax.hub.agentFilter', HA.filter); } catch (e) { /* private mode */ }
      HA.last = ''; renderHubAgents(); return;
    }
    var more = t.closest('[data-ha-more]');
    if (more) {
      var mk = more.getAttribute('data-ha-more') === 'needs' ? 'needsAll' : 'working';
      HA.open[mk] = !HA.open[mk]; haSaveOpen(); HA.last = ''; renderHubAgents(); return;
    }
    if (t.closest('#hub-k')) { haOpenK(); return; }
    if (t.closest('[data-hk-close]')) { haCloseK(); return; }
    if (t.closest('#hub-k-dlg a[href]')) haCloseK(true);
  });
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    var k = d && d.getAttribute && d.closest && d.closest('#hub-agents') ? d.getAttribute('data-ha-open') : '';
    if (k && HA.open[k] !== d.open) { HA.open[k] = d.open; haSaveOpen(); }
  }, true);
  // The agent in view changes: the current row follows, and ⌃Tab knows the last one.
  window.addEventListener('hashchange', function () {
    var a = haChatAgent();
    if (a && a !== HA.cur) { if (HA.cur) HA.prev = HA.cur; }
    HA.last = ''; renderHubAgents();
  });

  // --- The switcher (V3) ---
  function haReqs() {
    var posts = (S.data && S.data.posts) || [];
    return posts.filter(function (p) { return p && p.id && isOpen(p); })
      .sort(function (a, b) { return (b.lastMoveAt || 0) - (a.lastMoveAt || 0); })
      .map(function (p) { return { id: p.id, title: String(p.headline || p.id).split('\n')[0].slice(0, 100), owner: p.owner, sub: (p.owner ? nameOf(p.owner) : '') + (p.status ? ' · ' + String(p.status).replace(/_/g, ' ') : '') }; });
  }
  // The pages the side menu no longer shows (#2101 R22), from the hidden
  // page links (wall.ts #wall-pagelinks), each once, in menu order.
  function haPages() {
    var seen = {}, out = [];
    document.querySelectorAll('#wall-pagelinks a[data-nav]').forEach(function (a) {
      var key = a.getAttribute('data-nav');
      // A page the layout hides (#2226 S1, hub-layout.ts) is left out too.
      if (!key || seen[key] || a.hidden || hlNavHidden(key)) return;
      seen[key] = true;
      var span = a.querySelector('span');
      out.push({ key: key, label: (span ? span.textContent : a.textContent || '').trim(), href: a.getAttribute('href') || '' });
    });
    return out;
  }
  function haPaintK() {
    var rows = (HA.model || haModel()).rows;
    HA.k.hits = haSwitchHits(rows, haReqs(), HA.k.q, haPages());
    var n = haHitCount(HA.k.hits);
    if (HA.k.sel >= n) HA.k.sel = Math.max(0, n - 1);
    $('hub-k-list').innerHTML = haSwitchHtml(HA.k.hits, HA.k.sel, esc, haHref);
    var on = $('hub-k-list').querySelector('.is-sel');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function haOpenK() {
    var d = $('hub-k-dlg');
    if (!d || !d.hidden) return;
    HA.k.back = document.activeElement;
    HA.k.q = ''; HA.k.sel = 0;
    $('hub-k-q').value = '';
    d.hidden = false;
    haPaintK();
    $('hub-k-q').focus();
  }
  function haCloseK(went) {
    var d = $('hub-k-dlg');
    if (!d || d.hidden) return;
    d.hidden = true;
    if (!went && HA.k.back && HA.k.back.focus) HA.k.back.focus();
  }
  // A page of the Hub is a hash; a classic dashboard page is its own address.
  function haGo(href) {
    if (!href) return;
    if (href.charAt(0) === '#') location.hash = href.slice(1);
    else location.href = href;
  }
  if ($('hub-k-q')) $('hub-k-q').addEventListener('input', function () { HA.k.q = this.value; HA.k.sel = 0; haPaintK(); });
  if ($('hub-k-dlg')) $('hub-k-dlg').addEventListener('keydown', function (ev) {
    var n = haHitCount(HA.k.hits);
    if (ev.key === 'Escape') { ev.preventDefault(); haCloseK(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); if (n) { HA.k.sel = (HA.k.sel + 1) % n; haPaintK(); } }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (n) { HA.k.sel = (HA.k.sel - 1 + n) % n; haPaintK(); } }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      var a = $('hub-k-list').querySelector('[data-hk-i="' + HA.k.sel + '"]');
      if (a) { haCloseK(true); haGo(a.getAttribute('href')); }
    } else if (ev.key === 'Tab') {
      // Focus stays in the dialog.
      ev.preventDefault(); $('hub-k-q').focus();
    }
  });
  // ⌘K / Ctrl K anywhere; ⌘1…⌘9 or Alt 1…9; ⌃Tab for the last agent.
  document.addEventListener('keydown', function (ev) {
    var k = String(ev.key || '').toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && k === 'k') {
      if (!$('hub-k-dlg')) return;
      ev.preventDefault();
      if ($('hub-k-dlg').hidden) haOpenK(); else haCloseK();
      return;
    }
    var digit = /^Digit([1-9])$/.exec(ev.code || '');
    if (digit && ((ev.metaKey && !ev.ctrlKey) || (ev.altKey && !ev.metaKey && !ev.ctrlKey)) && !ev.shiftKey) {
      var rows = HA.k.hits && !$('hub-k-dlg').hidden ? HA.k.hits.agents : haSwitchHits((HA.model || haModel()).rows, [], '').agents;
      var r = rows[Number(digit[1]) - 1];
      if (!r) return;
      ev.preventDefault(); haCloseK(true);
      haGo(haHref(r));
      return;
    }
    if (ev.ctrlKey && !ev.metaKey && ev.key === 'Tab' && HA.prev) {
      ev.preventDefault();
      haGo('#page=chat&agent=' + encodeURIComponent(HA.prev));
    }
  });
`
