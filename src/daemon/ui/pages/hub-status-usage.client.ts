// --- The status bar's engines and their drop-downs, in the browser (#2101 R28) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, right after HUB_STATUS_SCRIPT.
// Uses $, esc, S, headers, getJson, render from the Hub script; haModel and
// haRunHref (hub-nav.client.ts); agmHold and agmHoldSet (wall-agents.client.ts,
// the Agents page hold); lvBtn and lvState (wall-live.client.ts, the Task
// page's stop); and the injected hub-status-usage.ts functions and
// engineIcon. The usage is read every minute from /api/admin/hub/usage,
// which asks the daemon (daemon/hub-usage-api.ts); the items are painted
// with the agent list (hsPaintRunning).
//
// One drop-down (#hsu-pop) serves every item. It opens on hover or focus
// and closes a moment after the pointer leaves both the item and the
// drop-down; a click pins it open (touch, keyboard), Escape or a click
// outside closes it. A hidden tab does not poll.
export const HUB_USAGE_SCRIPT = String.raw`
  var HSU = { use: null, open: '', pinned: false, closeT: 0, last: '', chips: null, note: '', noteAt: 0, orgAsked: false, retryT: 0, retries: 0 };
  function hsuIcon(k) { return engineIcon(k, 'ax-eng'); }
  function hsuLoad() {
    // A hidden tab reads nothing; it reads again when it shows (#2314 review).
    if (document.hidden) return;
    clearTimeout(HSU.retryT);
    fetch('/api/admin/hub/usage', { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error('usage read failed'); return r.json(); })
      .then(function (d) {
        HSU.use = d;
        if (d && d.engines && d.engines.length) HSU.retries = 0; else hsuRetry();
        hsuPaint();
      })
      // Not read: the engines in use keep their item, with no bars (R28g).
      .catch(function () { HSU.use = null; hsuRetry(); hsuPaint(); });
  }
  /** No engine read (a busy daemon, a restart): asked again in 10 s, up to 3 times, then each minute (R5). */
  function hsuRetry() {
    if (HSU.retries >= 3) return;
    HSU.retries++;
    HSU.retryT = setTimeout(hsuLoad, 10e3);
  }
  /** The plan engines with a reading to draw: each keeps its item with no agent on it (R5). */
  function hsuRead(now) {
    return ((HSU.use && HSU.use.engines) || []).filter(function (e) { return hubUsageRows(e.rows, now).length > 0; }).map(function (e) { return e.engine; });
  }
  function hsuUse(engine) {
    return ((HSU.use && HSU.use.engines) || []).filter(function (e) { return e.engine === engine; })[0] || null;
  }
  function hsuNodes() { return (S.live && S.live.nodes) || []; }
  /** An API engine's spend today (R28e); null for a plan engine or when not read. */
  function hsuSpend(e) {
    return hubApiEngines().indexOf(e.engine) >= 0 ? hubSpendView(e.agents, HSU.use && HSU.use.spend) : null;
  }
  function hsuPaint() {
    var box = $('hs-engines');
    if (!box) return;
    var now = Date.now();
    var html = hubEnginesInUse(hsuNodes(), hsuRead(now)).map(function (e) {
      var u = hsuUse(e.engine), rows = hubUsageRows(u && u.rows, now), tone = hubEngineTone(rows);
      // R28i: an engine at or near its limit is marked on the bar itself.
      return '<button type="button" class="hs__btn hsu__eng" data-hsu-pop="' + esc(e.engine) + '"' + (tone ? ' data-tone="' + tone + '"' : '') + ' aria-haspopup="true" aria-controls="hsu-pop" aria-expanded="false">' +
        hubEngineChipHtml(e.engine, rows, esc, hsuIcon, hsuSpend(e), now) + '</button>';
    }).join('');
    // Repainted only on a change, so a hover or focus on an item survives.
    if (html !== HSU.chips) { box.innerHTML = HSU.chips = html; }
    document.querySelectorAll('[data-hsu-pop]').forEach(function (b) { b.setAttribute('aria-expanded', String(b.getAttribute('data-hsu-pop') === HSU.open)); });
    if (HSU.open) hsuPaintPop();
  }
  /** The agents drop-down's rows: the Hub's agent rows, with engine, hold and run controls. */
  function hsuAgents() {
    var tiers = {};
    hsuNodes().forEach(function (n) { (n.agents || []).forEach(function (a) { if (a && a.id && !tiers[a.id]) tiers[a.id] = a.tier || 'claude-code'; }); });
    return haModel().rows.map(function (r) {
      var run = r.state === 'working' && r.taskId ? haRunHref(r) : '';
      return { id: r.id, name: r.name, face: r.face, color: r.color, state: r.state, paused: typeof agmHold === 'function' && agmHold(r.id) === 'paused',
        tier: tiers[r.id] || 'claude-code', line: r.line, runHref: run,
        stopHtml: r.state === 'working' && r.taskId ? lvBtn('pause', r.nodeUrl, r.taskId, 'Stop run', 'Stop it?', 'Stop this run and keep a resume plan, so it can be resumed later', true) : '' };
    });
  }
  function hsuPaintPop() {
    var pop = $('hsu-pop');
    if (!pop) return;
    var now = Date.now(), html;
    if (HSU.open === 'agents') {
      var note = HSU.note && now - HSU.noteAt < 20000 ? HSU.note : '';
      // A Stop run's outcome is the Live page's note (lvAct).
      if (!note && HSU.lvAt && now - HSU.lvAt < 20000) note = lvState().msg || '';
      html = hubAgentsPopHtml(hsuAgents(), !!window.AX_WALL_SETTINGS, note, esc, hsuIcon);
    } else {
      var e = hubEnginesInUse(hsuNodes(), hsuRead(now)).filter(function (x) { return x.engine === HSU.open; })[0];
      if (!e) { hsuOpen(''); return; }
      var u = hsuUse(e.engine);
      // Add account opens the accounts form (#2206), which is the owner's.
      html = hubEnginePopHtml(e.engine, u, hubUsageRows(u && u.rows, now), e.agents, now, esc, hsuIcon, !!window.AX_WALL_SETTINGS, hsuSpend(e));
    }
    pop.classList.toggle('is-agents', HSU.open === 'agents');
    if (html !== HSU.last) { pop.innerHTML = HSU.last = html; }
  }
  function hsuPlace(trigger) {
    var pop = $('hsu-pop');
    if (!pop || !trigger) return;
    var r = trigger.getBoundingClientRect(), w = pop.offsetWidth || 300;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  }
  function hsuOpen(which, trigger) {
    clearTimeout(HSU.closeT);
    var pop = $('hsu-pop');
    if (!pop) return;
    if (!which) { HSU.open = ''; HSU.pinned = false; HSU.last = ''; pop.hidden = true; hsuPaint(); return; }
    var again = HSU.open === which && !pop.hidden;
    HSU.open = which;
    if (which === 'agents' && !S.org && !HSU.orgAsked && window.AX_WALL_SETTINGS) {
      // Paused or not is the org view's (the Agents page reads it the same way).
      HSU.orgAsked = true;
      getJson('/api/admin/org').then(function (d) { S.org = d; hsuPaint(); }).catch(function () {});
    }
    pop.hidden = false;
    hsuPaint();
    if (!again) hsuPlace(trigger);
  }
  function hsuLater() {
    clearTimeout(HSU.closeT);
    if (HSU.pinned) return;
    HSU.closeT = setTimeout(function () { hsuOpen(''); }, 220);
  }
  function hsuIn(el) { return el && el.closest ? el.closest('[data-hsu-pop],#hsu-pop') : null; }
  // Hover only where there is a pointer that hovers; a touch opens on tap.
  var hsuHover = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
  document.addEventListener('mouseover', function (ev) {
    if (!hsuHover) return;
    var t = hsuIn(ev.target);
    if (!t) return;
    clearTimeout(HSU.closeT);
    if (t.id !== 'hsu-pop' && !HSU.pinned) hsuOpen(t.getAttribute('data-hsu-pop'), t);
  });
  document.addEventListener('mouseout', function (ev) {
    if (!hsuHover || !hsuIn(ev.target) || hsuIn(ev.relatedTarget)) return;
    hsuLater();
  });
  document.addEventListener('focusin', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-hsu-pop]');
    if (t && HSU.open !== t.getAttribute('data-hsu-pop')) hsuOpen(t.getAttribute('data-hsu-pop'), t);
  });
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target : null;
    if (!el) return;
    var t = el.closest('[data-hsu-pop]');
    if (t) {
      var w = t.getAttribute('data-hsu-pop');
      if (HSU.open === w && HSU.pinned) { hsuOpen(''); return; }
      hsuOpen(w, t);
      HSU.pinned = true;
      return;
    }
    if (!HSU.open) return;
    var add = el.closest('[data-hsu-add]');
    if (add) { hsuAddAccount(add.getAttribute('data-hsu-add')); return; }
    var hold = el.closest('[data-hsu-hold]');
    if (hold) { hsuHold(hold.getAttribute('data-id'), hold.getAttribute('data-hsu-hold') === 'pause'); return; }
    if (el.closest('#hsu-pop [data-lv]')) { HSU.lvAt = Date.now(); HSU.note = ''; return; }
    // A link in the drop-down goes somewhere: the drop-down closes behind it.
    if (el.closest('#hsu-pop a[href]')) { hsuOpen(''); return; }
    if (!el.closest('#hsu-pop')) hsuOpen('');
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !HSU.open) return;
    var back = document.querySelector('[data-hsu-pop="' + HSU.open + '"]');
    hsuOpen('');
    if (back) back.focus();
  });
  /** Pause / Resume new work: the Agents page's own hold (agmHoldSet). */
  async function hsuHold(id, pause) {
    HSU.note = (pause ? 'Pausing ' : 'Resuming ') + id + '…'; HSU.noteAt = Date.now(); HSU.lvAt = 0;
    hsuPaintPop();
    await agmHoldSet(id, pause);
    HSU.note = (typeof AGM !== 'undefined' && AGM.flash) || (pause ? 'Paused.' : 'Resumed.'); HSU.noteAt = Date.now();
    hsuPaintPop();
  }
  /** R28c: the accounts form (#2206), open at this engine's add row. */
  function hsuAddAccount(provider) {
    hsuOpen('');
    var pop = $('hs-acct-pop'), b = $('hs-acct');
    if (!pop || !b || b.hidden) return;
    if (pop.hidden) b.click();
    var f = pop.querySelector('[data-hsa-add="' + provider + '"]');
    if (!f) return;
    f.scrollIntoView({ block: 'nearest' });
    if (f.elements.name) f.elements.name.focus();
  }
  window.addEventListener('resize', function () { if (HSU.open) hsuPlace(document.querySelector('[data-hsu-pop="' + HSU.open + '"]')); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) hsuLoad(); });
  hsuLoad();
  setInterval(hsuLoad, 60e3);
`
