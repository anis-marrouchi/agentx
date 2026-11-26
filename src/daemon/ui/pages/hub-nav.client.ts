// --- The Hub's side menu in the browser (#2101 P4, hub-nav.ts) ---
//
// Paints the agents (hub-agents.ts) from the live snapshot the page
// already follows (S.live) and the Needs you list (decAll), each time the
// tree is painted (every snapshot, 2 s): the grouped list, the 641-1180 px
// icon rail, and the line naming machines that do not answer. A refresh
// patches the rows by their data-key (haPatch), so nothing re-animates and
// focus, scroll and an open fold or menu survive it (orca-design C28).
//
// The shell by width (orca-design C26): over 1180 px the full menu; 641-1180
// px the 56 px rail (also the folded menu on a computer, hub-panels.ts
// .is-rail); 640 px and below a top bar whose menu button opens the same
// menu as a left Sheet (X, scrim and Esc close it). No bottom bar.
//
// ⌘K (Ctrl K) opens the search; ⌘1…⌘9 open the agents in its order
// (Alt 1…9 elsewhere, as Ctrl 1 is the browser's own tab key); ⌃Tab goes
// back to the last agent. Opening an agent is its chat link,
// #page=chat&agent=, which opens its latest conversation; a working agent
// opens its live run instead (#2270, #2101 R26, wall-task.client.ts
// wallTaskHref). A row's Stop and its menu (Open chat, Open live run, Copy
// agent ID, Stop) sit at its end on hover or focus, always on touch.
// One tooltip (#ax-tip) serves every [data-tip] control.
//
// A fragment of WALL_PAGE_SCRIPT: it uses S, $, esc, act, decAll, isOpen,
// hlNavHidden (hub-layout.ts) and the injected hubAgentRows, haListHtml,
// haRailHtml, haDownHtml, haSwitchHits, haSwitchHtml, haHitCount, ltAge.

import { HUB_NAV_ICON_NAMES, HUB_PAGE_ICON } from "./hub-nav"
import { hubIconMap } from "./hub-lucide"

export const HUB_NAV_SCRIPT = String.raw`
  var HA_IC = ${JSON.stringify(hubIconMap(HUB_NAV_ICON_NAMES))};
  var HA_PAGE_IC = ${JSON.stringify(HUB_PAGE_ICON)};
  var HA_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  // The shortcut's modifier for this computer: ⌘ on a Mac; Ctrl K and Alt 1…9 elsewhere.
  function haMod(key) { return HA_MAC ? '⌘' + key : (key === 'K' ? 'Ctrl K' : 'Alt+' + key); }
  document.querySelectorAll('[data-mod-key]').forEach(function (k) { k.textContent = haMod(k.getAttribute('data-mod-key')); });
  // What the reader opened (Anis 2026-11-26, orca-design C21), saved:
  // Working starts open, the other groups folded, live groups at 3 rows.
  var HA = { open: { needs: false, working: false, idle: false, work: true, done: false, needsAll: false }, last: '', rail: '', model: null, cur: '', prev: '', k: { q: '', sel: 0, hits: null, back: null }, menu: null };
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

  // --- Patch in place (orca-design C28) ---
  // The new HTML is matched to what is there by data-key (or tag and place
  // for parts without one): an unchanged part is left alone, a changed one
  // gets its attributes and children patched, so a refresh re-creates
  // nothing that did not change.
  function haKey(n, i) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.tagName + '#' + i) : '#' + n.nodeType + ':' + i; }
  function haAttrs(o, n) {
    var keepX = HA.menu && HA.menu.btn === o;
    Array.prototype.slice.call(o.attributes).forEach(function (a) { if (!n.hasAttribute(a.name) && !(keepX && a.name === 'aria-expanded')) o.removeAttribute(a.name); });
    Array.prototype.forEach.call(n.attributes, function (a) { if (o.getAttribute(a.name) !== a.value && !(keepX && a.name === 'aria-expanded')) o.setAttribute(a.name, a.value); });
  }
  function haSync(old, neu) {
    var have = {};
    Array.prototype.forEach.call(old.childNodes, function (c, i) { have[haKey(c, i)] = c; });
    var put = Array.prototype.slice.call(neu.childNodes).map(function (n, i) {
      var k = haKey(n, i), o = have[k];
      if (!o || o.nodeType !== n.nodeType || (o.nodeType === 1 && o.tagName !== n.tagName)) return n;
      delete have[k];
      if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return o; }
      if (o.outerHTML !== n.outerHTML) { haAttrs(o, n); if (o.innerHTML !== n.innerHTML) haSync(o, n); }
      return o;
    });
    Object.keys(have).forEach(function (k) { old.removeChild(have[k]); });
    put.forEach(function (n, i) { if (old.childNodes[i] !== n) old.insertBefore(n, old.childNodes[i] || null); });
  }
  function haPatch(box, html) {
    // A first paint, or a document with no templates: draw it whole.
    if (!box.firstChild || typeof document.createElement !== 'function') { box.innerHTML = html; return; }
    var t = document.createElement('template');
    t.innerHTML = html;
    haSync(box, t.content);
  }

  function renderHubAgents() {
    hsPaintRunning();
    var el = $('hub-agents');
    if (!el) return;
    // No machine read yet, or the live read failed with none: say so (it
    // is the side menu's only live list since #2101 R26).
    var none = !S.live || (S.liveError && !(S.live.nodes || []).length);
    if (none) { if (S.liveError) { HA.last = ''; haPatch(el, '<p class="ha__empty" data-key="err" role="status">Could not reach the machines just now; trying again.</p>'); } return; }
    HA.model = haModel();
    HA.cur = haChatAgent();
    var draw = { runHref: haRunHref, ic: HA_IC, acts: true };
    var html = haDownHtml(HA.model.down, esc, HA_IC) + haListHtml(HA.model, HA.cur, HA.open, esc, ltAge, draw);
    if (html !== HA.last) { HA.last = html; haPatch(el, html); }
    var rail = $('hub-rail');
    var rhtml = haRailHtml(HA.model, HA.cur, esc, draw);
    if (rail && rhtml !== HA.rail) { HA.rail = rhtml; haPatch(rail, rhtml); }
  }

  // --- Stop and the row menu ---
  function haRow(id) { return ((HA.model && HA.model.rows) || []).filter(function (r) { return r.id === id; })[0]; }
  /** Stop an agent's runs: the stop signal of the Task page's Pause
   *  (POST /api/admin/wall/live/pause, wall-task-ctl.ts), once per run. */
  function haStop(id, btn) {
    var nodes = (S.live && S.live.nodes) || [], calls = [];
    nodes.forEach(function (n) {
      (n && n.agents || []).forEach(function (a) {
        if (!a || a.id !== id) return;
        (a.runningTasks || []).forEach(function (t) {
          if (t && t.id) calls.push(act('POST', '/api/admin/wall/live/pause?node=' + encodeURIComponent(n.url || ''), { taskId: t.id }));
        });
      });
    });
    if (!calls.length) return;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    Promise.all(calls).then(function (rs) {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      var bad = rs.filter(function (r) { return !r.ok; })[0];
      if (bad && btn) haTip(btn, 'Not stopped: ' + bad.error, true);
    });
  }
  function haMenuClose(back) {
    var m = $('ha-menu');
    if (!m || m.hidden) return;
    m.hidden = true;
    if (HA.menu && HA.menu.btn) { HA.menu.btn.setAttribute('aria-expanded', 'false'); if (back && HA.menu.btn.isConnected) HA.menu.btn.focus(); }
    HA.menu = null;
  }
  function haMenuOpen(btn) {
    var m = $('ha-menu'), r = haRow(btn.getAttribute('data-ha-menu'));
    if (!m || !r) return;
    if (HA.menu && HA.menu.btn === btn) { haMenuClose(true); return; }
    haMenuClose(false);
    var run = r.state === 'working' && r.taskId ? haRunHref(r) : '';
    var item = function (attrs, icon, label) { return '<' + (attrs.indexOf('href=') === 0 ? 'a ' : 'button type="button" ') + attrs + ' role="menuitem" tabindex="-1">' + (HA_IC[icon] || '') + '<span>' + esc(label) + '</span></' + (attrs.indexOf('href=') === 0 ? 'a' : 'button') + '>'; };
    m.setAttribute('aria-label', r.name);
    m.innerHTML = item('href="' + esc(haChatHref(r)) + '"', 'message-square', 'Open chat') +
      (run ? item('href="' + esc(run) + '"', 'activity', 'Open live run') : '') +
      item('data-ha-copy="' + esc(r.id) + '"', 'copy', 'Copy agent ID') +
      (r.state === 'working' && r.runs ? '<hr>' + item('class="is-danger" data-ha-stop="' + esc(r.id) + '"', 'square', r.runs === 1 ? 'Stop the run' : 'Stop ' + r.runs + ' runs') : '');
    m.hidden = false;
    var b = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    var left = b.right + 4 + w <= innerWidth - 8 ? b.right + 4 : Math.max(8, b.right - w);
    var top = Math.max(8, Math.min(b.top, innerHeight - h - 8));
    if (left < b.right && left + w > b.left) top = Math.min(b.bottom + 4, innerHeight - h - 8);
    m.style.left = left + 'px'; m.style.top = top + 'px';
    HA.menu = { btn: btn };
    btn.setAttribute('aria-expanded', 'true');
    var first = m.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }
  if ($('ha-menu')) $('ha-menu').addEventListener('keydown', function (ev) {
    var items = Array.prototype.slice.call(this.querySelectorAll('[role="menuitem"]'));
    var i = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); haMenuClose(true); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); var n = items.length; if (n) items[(i + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n].focus(); }
    else if (ev.key === 'Home' || ev.key === 'End') { ev.preventDefault(); if (items.length) items[ev.key === 'Home' ? 0 : items.length - 1].focus(); }
    else if (ev.key === 'Tab') haMenuClose(false);
  });

  // --- One tooltip for every [data-tip] control ---
  var HA_TIP = { el: null, t: 0 };
  function haTipHide() { clearTimeout(HA_TIP.t); HA_TIP.el = null; var t = $('ax-tip'); if (t) t.hidden = true; }
  function haTip(el, text, now) {
    var t = $('ax-tip');
    if (!t || !el.isConnected) return;
    var key = el.getAttribute('data-tip-key');
    t.innerHTML = esc(text) + (key ? ' <kbd>' + esc(haMod(key)) + '</kbd>' : '');
    t.hidden = false;
    var b = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
    var right = el.getAttribute('data-tip-side') === 'right';
    var left = right ? b.right + 8 : b.left + b.width / 2 - w / 2;
    var top = right ? b.top + b.height / 2 - h / 2 : b.bottom + 6;
    if (left + w > innerWidth - 8) left = right ? b.left - w - 8 : innerWidth - w - 8;
    if (top + h > innerHeight - 8) top = b.top - h - 6;
    t.style.left = Math.max(8, left) + 'px'; t.style.top = Math.max(8, top) + 'px';
    HA_TIP.el = el;
    if (now === true) { clearTimeout(HA_TIP.t); HA_TIP.t = setTimeout(haTipHide, 4000); }
  }
  /** A control whose own words show needs no tooltip (the full menu's labels). */
  function haTipWanted(el) {
    var text = el.getAttribute('data-tip');
    if (!text) return '';
    var own = el.querySelector(':scope > span');
    return own && own.getClientRects().length && own.textContent.trim() === text ? '' : text;
  }
  document.addEventListener('pointerover', function (ev) {
    if (ev.pointerType === 'touch') return;
    var el = ev.target.closest && ev.target.closest('[data-tip]');
    if (!el || el === HA_TIP.el) return;
    var text = haTipWanted(el);
    clearTimeout(HA_TIP.t);
    if (!text) { haTipHide(); return; }
    // Warm: once one shows, the next shows at once (Radix's skip delay).
    var warm = !$('ax-tip').hidden;
    HA_TIP.t = setTimeout(function () { haTip(el, text); }, warm ? 0 : 500);
  });
  document.addEventListener('pointerout', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-tip]');
    if (el && !(ev.relatedTarget && el.contains(ev.relatedTarget))) haTipHide();
  });
  document.addEventListener('focusin', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-tip]');
    if (!el || !el.matches(':focus-visible')) { haTipHide(); return; }
    var text = haTipWanted(el);
    if (text) haTip(el, text); else haTipHide();
  });
  document.addEventListener('focusout', haTipHide);
  document.addEventListener('scroll', haTipHide, true);

  // --- The phone Sheet, and the expanded rail (orca-design C26) ---
  var HA_SHEET = { back: null };
  function haSheet(on) {
    var wall = document.querySelector('.ax-wall'), nav = $('wall-nav');
    if (!wall || !nav || wall.classList.contains('is-sheet') === on) return;
    wall.classList.toggle('is-sheet', on);
    if (on) { nav.setAttribute('role', 'dialog'); nav.setAttribute('aria-modal', 'true'); } else { nav.removeAttribute('role'); nav.removeAttribute('aria-modal'); }
    document.querySelectorAll('[data-sheet-open]').forEach(function (b) { b.setAttribute('aria-expanded', String(on)); });
    if (on) {
      HA_SHEET.back = document.activeElement;
      var x = nav.querySelector('[data-sheet-close]');
      if (x) x.focus();
    } else if (HA_SHEET.back && HA_SHEET.back.focus && nav.contains(document.activeElement)) HA_SHEET.back.focus();
  }
  // Wider than 1180 px there is no Sheet: the full menu shows.
  window.addEventListener('resize', function () { if (innerWidth > 1180) haSheet(false); });

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    if (HA.menu && !t.closest('#ha-menu') && !t.closest('[data-ha-menu]')) haMenuClose(false);
    var more = t.closest('[data-ha-more]');
    if (more) {
      var mk = more.getAttribute('data-ha-more') === 'needs' ? 'needsAll' : 'working';
      HA.open[mk] = !HA.open[mk]; haSaveOpen(); renderHubAgents(); return;
    }
    var stop = t.closest('[data-ha-stop]');
    if (stop) { ev.preventDefault(); haStop(stop.getAttribute('data-ha-stop'), stop.closest('#ha-menu') ? (HA.menu && HA.menu.btn) : stop); haMenuClose(true); return; }
    var mb = t.closest('[data-ha-menu]');
    if (mb) { ev.preventDefault(); haTipHide(); haMenuOpen(mb); return; }
    var cp = t.closest('[data-ha-copy]');
    if (cp) {
      var id = cp.getAttribute('data-ha-copy');
      var done = function (ok) {
        cp.innerHTML = (ok ? HA_IC.check || '' : HA_IC.copy || '') + '<span>' + (ok ? 'Copied' : 'Copy failed') + '</span>';
        setTimeout(function () { haMenuClose(true); }, 900);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(id).then(function () { done(true); }, function () { done(false); });
      else done(false);
      return;
    }
    if (t.closest('#ha-menu a[href]')) haMenuClose(false);
    if (t.closest('[data-sheet-open]')) { haSheet(true); return; }
    if (t.closest('[data-sheet-close]')) { haSheet(false); return; }
    // Picking a page or an agent in the Sheet closes it.
    if (t.closest('#wall-nav a[href]')) haSheet(false);
    if (t.closest('#hub-k') || t.closest('[data-hk-open]')) { haSheet(false); haOpenK(); return; }
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
    haMenuClose(false); haSheet(false);
    HA.last = ''; renderHubAgents();
  });

  // --- ⌘K: search agents and pages (V3) ---
  function haReqs() {
    var posts = (S.data && S.data.posts) || [];
    return posts.filter(function (p) { return p && p.id && isOpen(p); })
      .sort(function (a, b) { return (b.lastMoveAt || 0) - (a.lastMoveAt || 0); })
      .map(function (p) { return { id: p.id, title: String(p.headline || p.id).split('\n')[0].slice(0, 100), owner: p.owner, sub: (p.owner ? nameOf(p.owner) : '') + (p.status ? ' · ' + String(p.status).replace(/_/g, ' ') : '') }; });
  }
  // The pages the side menu does not show (#2101 R22), from the hidden
  // page links (wall.ts #wall-pagelinks), each once, in menu order, with
  // the page's own icon (hub-nav.ts HUB_PAGE_ICON).
  function haPages() {
    var seen = {}, out = [];
    document.querySelectorAll('#wall-pagelinks a[data-nav]').forEach(function (a) {
      var key = a.getAttribute('data-nav');
      // A page the layout hides (#2226 S1, hub-layout.ts) is left out too.
      if (!key || seen[key] || a.hidden || hlNavHidden(key)) return;
      seen[key] = true;
      var span = a.querySelector('span');
      out.push({ key: key, label: (span ? span.textContent : a.textContent || '').trim(), href: a.getAttribute('href') || '', icon: HA_PAGE_IC[key] || '' });
    });
    return out;
  }
  function haPaintK() {
    var rows = (HA.model || haModel()).rows;
    HA.k.hits = haSwitchHits(rows, haReqs(), HA.k.q, haPages());
    var n = haHitCount(HA.k.hits);
    if (HA.k.sel >= n) HA.k.sel = Math.max(0, n - 1);
    $('hub-k-list').innerHTML = haSwitchHtml(HA.k.hits, HA.k.sel, esc, haHref, { ic: HA_IC, mod: HA_MAC ? '⌘' : 'Alt+' });
    var on = $('hub-k-list').querySelector('.is-sel');
    if (on) {
      $('hub-k-q').setAttribute('aria-activedescendant', on.id || '');
      if (on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
  }
  function haOpenK() {
    var d = $('hub-k-dlg');
    if (!d || !d.hidden) return;
    haMenuClose(false); haTipHide();
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
  // ⌘K / Ctrl K anywhere; ⌘1…⌘9 or Alt 1…9; ⌃Tab for the last agent; Esc closes the Sheet.
  document.addEventListener('keydown', function (ev) {
    var k = String(ev.key || '').toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && k === 'k') {
      if (!$('hub-k-dlg')) return;
      ev.preventDefault();
      if ($('hub-k-dlg').hidden) { haSheet(false); haOpenK(); } else haCloseK();
      return;
    }
    if (ev.key === 'Escape' && !ev.defaultPrevented && document.querySelector('.ax-wall.is-sheet') && !HA.menu && $('hub-k-dlg').hidden) { ev.preventDefault(); haSheet(false); return; }
    if (ev.key === 'Escape') haTipHide();
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
