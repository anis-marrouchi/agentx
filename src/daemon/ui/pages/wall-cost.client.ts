// --- Wall Cost page, browser side (#1423, epic #1449) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), getJson(), act(), avatar(), agentInfo(), money(), showAgent(),
// writeHash() and render(). The numbers and the markup come from
// wall-cost.ts (costPageModel, costPageHtml, costBudgetsHtml, mergeCost,
// mergeBudgets, costCsv, costFetchRange).
//
// It reads every machine the Wall's feed reads (S.data.nodes): this one
// directly, the others through the dashboard's peer proxy, so it asks no
// machine the proxy does not know. A machine it cannot read is named, in
// plain words, and the rest still add up.
//
// renderCost(view) is the one call the Wall's render() makes; refreshCost()
// is called from the Wall's own load(). The nav count is this month's total
// on every machine read. The only write is a budget: POST /api/admin/budgets
// on the machine picked, which the dashboard lets only its owner do (its
// token gate); a refusal is shown as such.

export const WALL_COST_SCRIPT = String.raw`
  var C = { range: 30, key: '', loading: '', data: null, error: '', failed: [], peerBudgets: {}, form: {}, filter: 'all', details: false };
  /** A failed read in plain words, for the "Not read" line. */
  function costWhy(msg) {
    var m = /HTTP (\d+)/.exec(String(msg || ''));
    if (!m) return /timed out/i.test(String(msg)) ? 'did not answer in time' : 'did not answer';
    var code = +m[1];
    return code === 401 || code === 403 ? 'refused this dashboard\'s key' : code === 404 ? 'has no cost figures to send' : 'answered with an error';
  }
  /** The machines to read: the ones the feed reads; and the ones it cannot, with why. */
  function costMachines() {
    var nodes = (S.data && S.data.nodes) || [], read = [], missed = [];
    nodes.forEach(function (n, i) {
      if (i === 0 && !n.peer) read.push({ name: n.name, peer: null });
      else if (n.ok && n.peer) read.push({ name: n.name, peer: n.peer });
      else missed.push({ name: n.name, why: n.error && /timed out/.test(n.error) ? 'did not answer in time' : 'does not answer' });
    });
    if (!read.length) read.push({ name: (S.data && S.data.node) || 'this machine', peer: null });
    // A machine in the mesh that this dashboard has no address for.
    ((S.live && S.live.nodes) || []).forEach(function (n, i) {
      if (i === 0) return;
      var known = nodes.some(function (x) { return x.name === n.name || (x.peer && n.url && x.peer.replace(/\/+$/, '') === n.url.replace(/\/+$/, '')); });
      if (!known) missed.push({ name: n.name, why: 'this dashboard has no address for it' });
    });
    return { read: read, missed: missed };
  }
  function costKey(ms) { return C.range + '|' + ms.read.map(function (m) { return m.name; }).join(','); }
  async function loadCost() {
    var ms = costMachines(), key = costKey(ms), want = C.range;
    C.loading = key;
    var replies = await Promise.all(ms.read.map(function (m) {
      return getJson('/api/admin/observability/cost?range=' + costFetchRange(want), m.peer)
        .then(function (d) { return { m: m, d: d && Array.isArray(d.days) ? d : null, err: d && Array.isArray(d.days) ? '' : 'sent no figures' }; },
          function (e) { return { m: m, d: null, err: costWhy(e && e.message) }; });
    }));
    // A newer read (another range, or the machines changed) wins.
    if (C.loading !== key) return;
    var ok = replies.filter(function (r) { return r.d; });
    C.loading = ''; C.key = key;
    C.data = ok.length ? mergeCost(ok.map(function (r) { return r.d; })) : null;
    C.failed = replies.filter(function (r) { return !r.d; }).map(function (r) { return { name: r.m.name, why: r.err }; });
    C.error = ok.length ? '' : C.failed.map(function (f) { return f.name + ' ' + f.why; }).join('; ');
    render();
  }
  /** The other machines' budgets; this machine's is S.budgets, read by the Wall's load(). */
  function loadCostBudgets() {
    costMachines().read.forEach(function (m) {
      if (!m.peer) return;
      getJson('/api/admin/observability/budgets', m.peer).then(function (d) { C.peerBudgets[m.name] = d; render(); }, function () { C.peerBudgets[m.name] = null; render(); });
    });
  }
  function costBudgetMachines() {
    return costMachines().read.map(function (m) { return { name: m.name, peer: m.peer, budgets: m.peer ? (C.peerBudgets[m.name] || null) : S.budgets }; });
  }
  function costBudgets() { return mergeBudgets(costBudgetMachines().map(function (m) { return m.budgets; })); }
  function refreshCost() { if (C.key) { C.key = ''; loadCostBudgets(); } }
  function costNames() {
    var out = {}, info = agentInfo();
    Object.keys(info).forEach(function (id) { out[id] = info[id].name; });
    return out;
  }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderCost(view) {
    var on = view === 'cost';
    $('wall-cost').hidden = !on;
    var all = costBudgets(), f = all && all.fleet;
    var n = $('wall-cost-n');
    n.textContent = f ? money(f.spentUsd || 0) : '';
    n.setAttribute('title', f ? 'spent this month' : '');
    if (!on) return;
    $('wall-count').hidden = true;
    $('wall-profile').hidden = true;
    var ms = costMachines();
    if (C.key !== costKey(ms) && C.loading !== costKey(ms)) { if (!C.key) loadCostBudgets(); loadCost(); }
    // A budget being typed keeps its value: no repaint under the cursor.
    var a = document.activeElement;
    if (a && a.id && /^cb-/.test(a.id)) return;
    var budgetsHtml = costBudgetsHtml(costBudgetMachines(), C.form);
    $('wall-cost').innerHTML = C.error ? '<p class="ax-wall__empty" role="alert">Could not read the cost: ' + esc(C.error) + '. The rest of the Wall still works. Select Refresh to try again.</p>' +
        '<section class="wc__budgets" aria-label="Monthly budgets">' + budgetsHtml + '</section>'
      : !C.data ? '<p class="ax-wall__empty">Loading…</p>'
      : costPageHtml(costPageModel(C.data, all, C.range), costNames(), function (id) { return avatar(id, 'sm'); },
          { machines: { read: ms.read.filter(function (m) { return !C.failed.some(function (x) { return x.name === m.name; }); }).map(function (m) { return m.name; }), missed: ms.missed.concat(C.failed) },
            filter: C.filter, details: C.details, budgetsHtml: budgetsHtml });
  }
  /** The range's days as the classic CSV, saved by the browser. */
  function exportCostCsv() {
    if (!C.data) return;
    var m = costPageModel(C.data, costBudgets(), C.range);
    var csv = costCsv(m.daily);
    try {
      var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      var link = document.createElement('a');
      link.href = url;
      link.download = 'agentx-cost-' + (C.range ? C.range + 'd' : 'all') + '-' + m.today + '.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { C.form.note = 'The CSV could not be saved in this browser.'; render(); }
  }
  async function saveBudget() {
    if (C.form.saving) return;
    var ms = costBudgetMachines().filter(function (m) { return m.budgets && m.budgets.fleet; });
    var m = ms.find(function (x) { return x.name === C.form.machine; }) || ms[0];
    if (!m) return;
    var key = ($('cb-scope') && $('cb-scope').value) || C.form.scope || 'fleet';
    var raw = String(($('cb-usd') && $('cb-usd').value) || '').trim();
    if (raw !== '' && !(Number(raw) >= 0)) { C.form.note = 'Type a number of dollars, or leave it empty for no cap.'; render(); return; }
    var cut = key.indexOf(':');
    var body = { scope: cut < 0 ? key : key.slice(0, cut), monthlyUsd: raw === '' ? null : Number(raw) };
    if (cut >= 0) body.id = key.slice(cut + 1);
    C.form.scope = key; C.form.saving = true; C.form.note = 'Saving…';
    render();
    var r = await act('POST', '/api/admin/budgets', body, m.peer);
    C.form.saving = false;
    C.form.usd = null;
    C.form.note = r.ok ? (body.monthlyUsd ? 'Saved. It applies now; paused work resumes if the new cap allows it.' : 'Saved: no cap.')
      : 'Not saved: ' + (/unauthori[sz]ed|forbidden|401|403/i.test(r.error) ? 'only the owner can change a budget, and this dashboard did not accept the key.' : r.error);
    if (r.ok) {
      if (m.peer) loadCostBudgets();
      else getJson('/api/admin/observability/budgets').then(function (d) { S.budgets = d; render(); }, function () {});
    }
    render();
  }
  /** A row's "Set a cap": the form on the machine that runs the agent, with the agent picked. */
  function pickCap(id) {
    var ms = costBudgetMachines().filter(function (m) { return m.budgets && m.budgets.fleet; });
    var runs = function (m) { return (m.budgets.agentIds || []).indexOf(id) >= 0; };
    var lists = function (m) { return (m.budgets.agents || []).some(function (a) { return a.agentId === id; }); };
    var m = ms.find(runs) || ms.find(lists) || ms[0];
    if (!m) return;
    C.form = { machine: m.name, scope: 'agent:' + id, usd: null, note: '' };
    render();
    var box = $('cb-usd');
    if (box) { if (box.scrollIntoView) box.scrollIntoView({ block: 'center' }); if (box.focus) box.focus(); }
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-crange],[data-cagent],[data-ccap],[data-ccsv],[data-cfilter],[data-cdetails],[data-cbudgets]');
    if (!t) return;
    if (t.hasAttribute('data-crange')) {
      var r = Number(t.getAttribute('data-crange'));
      C.range = r > 0 ? r : 0; C.data = null; C.error = ''; C.key = '';
      writeHash(); render(); return;
    }
    if (t.hasAttribute('data-ccap')) { pickCap(t.getAttribute('data-ccap')); return; }
    if (t.hasAttribute('data-ccsv')) { exportCostCsv(); return; }
    if (t.hasAttribute('data-cfilter')) { C.filter = t.getAttribute('data-cfilter'); C.details = true; render(); return; }
    if (t.hasAttribute('data-cdetails')) { C.details = !C.details; render(); return; }
    if (t.hasAttribute('data-cbudgets')) { if (ev.preventDefault) ev.preventDefault(); var b = $('wall-cost-budgets'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'start' }); return; }
    // A row opens the agent's Wall profile over its posts.
    S.view = 'feed';
    showAgent(t.getAttribute('data-cagent'));
  });
  document.addEventListener('change', function (ev) {
    var id = ev.target && ev.target.id;
    if (id === 'cb-machine') { C.form.machine = ev.target.value; C.form.scope = 'fleet'; C.form.usd = null; C.form.note = ''; if (ev.target.blur) ev.target.blur(); render(); }
    else if (id === 'cb-scope') { C.form.scope = ev.target.value; C.form.usd = null; C.form.note = ''; if (ev.target.blur) ev.target.blur(); render(); }
  });
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'cb-usd') C.form.usd = ev.target.value; });
  document.addEventListener('submit', function (ev) {
    if (!ev.target || !ev.target.hasAttribute || !ev.target.hasAttribute('data-cform')) return;
    ev.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    saveBudget();
  });
`

export const WALL_COST_CSS = `
.wc__head { display: grid; grid-template-columns: 1fr 160px; gap: 4px 12px; align-items: center; margin-bottom: 8px; }
.wc__big { font-size: var(--ax-fs-lg, 1.15rem); }
.wc__big b { font-size: 1.6em; font-weight: 700; }
.wc__kpis { grid-column: 1; display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wc__kpis i, .wc__amt i, .wc__rail small { font-style: normal; color: var(--ax-muted); font-size: var(--ax-fs-xs); margin-left: 4px; }
.wc i.up { color: var(--ax-red-ink, var(--ax-err)); } .wc i.down { color: var(--ax-green-d); }
.wc__spark30 { grid-column: 2; grid-row: 1 / span 2; width: 160px; height: 40px; }
.wc svg polyline { fill: none; stroke: var(--ax-accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.wc__tabs { margin: 0 0 8px; border-bottom: 1px solid var(--ax-border); }
.wc__warn { margin: 0 0 8px; padding: 6px 10px; border-radius: var(--ax-radius-sm); background: color-mix(in oklch, var(--ax-amber) 14%, transparent); font-size: var(--ax-fs-sm); }
.wc__chart { margin: 0 0 12px; }
.wc__chart svg { width: 100%; height: 160px; display: block; background: var(--ax-surface); border-radius: var(--ax-radius-sm); }
.wc__chart figcaption { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wc__chart figcaption i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.wc-s0 { fill: var(--ax-accent); background: var(--ax-accent); }
.wc-s1 { fill: color-mix(in oklch, var(--ax-accent) 72%, white); background: color-mix(in oklch, var(--ax-accent) 72%, white); }
.wc-s2 { fill: color-mix(in oklch, var(--ax-accent) 50%, white); background: color-mix(in oklch, var(--ax-accent) 50%, white); }
.wc-s3 { fill: color-mix(in oklch, var(--ax-accent) 60%, black); background: color-mix(in oklch, var(--ax-accent) 60%, black); }
.wc-s4 { fill: color-mix(in oklch, var(--ax-accent) 32%, white); background: color-mix(in oklch, var(--ax-accent) 32%, white); }
.wc-s5 { fill: var(--ax-muted); background: var(--ax-muted); }
.wc__phone { display: none; width: 100%; height: 44px; margin-bottom: 10px; }
.wc__grid { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: start; }
.wc__rows { list-style: none; margin: 0; padding: 0; }
.wc__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 10px 4px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wc__who { display: flex; gap: 8px; align-items: center; min-width: 0; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 0; cursor: pointer; }
.wc__who span { display: flex; flex-direction: column; min-width: 0; }
.wc__who small, .wc__runs, .wc__cap small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__who:hover b { text-decoration: underline; }
.wc__link { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; background: none; border: 0; padding: 0; color: var(--ax-accent); cursor: pointer; white-space: nowrap; }
.wc__link:hover { text-decoration: underline; }
.wc__who:focus-visible, .wc__toggle:focus-visible, .wc__chips button:focus-visible, .wc__link:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.wc__amt { text-align: right; }
.wc__cap { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; min-width: 0; }
.wc__bar { flex: 0 1 120px; min-width: 40px; height: 6px; border-radius: 3px; background: var(--ax-surface); overflow: hidden; }
.wc__bar i { display: block; height: 100%; background: var(--ax-accent); }
.wc__bar.is-warn i { background: var(--ax-amber); } .wc__bar.is-err i { background: var(--ax-red, var(--ax-err)); }
.wc__runs { grid-column: 1 / -1; }
.wc__np { color: var(--ax-amber-ink, var(--ax-amber)); }
.wc__rail { font-size: var(--ax-fs-sm); background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 8px 12px; }
.wc__rail h3, .wc__more h3 { font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--ax-muted); margin: 8px 0 4px; }
.wc__rail ul { list-style: none; margin: 0; padding: 0; }
.wc__rail li { display: grid; grid-template-columns: 1fr auto; gap: 0 6px; padding: 2px 0; }
.wc__rail li small { grid-column: 1 / -1; margin: 0; }
.wc__rail p { margin: 0 0 4px; }
.wc__acts { display: flex; gap: 10px; align-items: center; margin-top: 8px !important; }
.wc__acts .ax-btn { font-size: var(--ax-fs-xs); padding: 3px 12px; }
.wc .k { color: var(--ax-muted); }
/* Details: the classic page's KPIs, token mix, cache and daily table. */
.wc__more { margin: 14px 0 0; border-top: 1px solid var(--ax-border); padding-top: 10px; }
.wc__toggle { font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; background: none; border: 0; padding: 4px 0; color: var(--ax-accent); cursor: pointer; }
.wc__grid4, .wc__cache { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
.wc__cache { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
.wc__grid4 div, .wc__cache div { background: var(--ax-surface); border-radius: var(--ax-radius); padding: 8px 10px; min-width: 0; }
.wc__grid4 dt, .wc__cache dt { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wc__grid4 dd, .wc__cache dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.wc__grid4 dd small { display: block; font-weight: 400; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.wc__mix { list-style: none; margin: 0; padding: 0; font-size: var(--ax-fs-sm); }
.wc__mix li { display: grid; grid-template-columns: 1fr auto 44px; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--ax-border); }
.wc__mix small { color: var(--ax-muted); text-align: right; }
.wc-m { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.wc-m.in { background: var(--ax-accent); } .wc-m.out { background: var(--ax-green); } .wc-m.cr { background: var(--ax-amber); } .wc-m.cw { background: var(--ax-muted); }
.wc__chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px; }
.wc__chips button { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 3px 12px; cursor: pointer; }
.wc__chips button[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wc__scroll { overflow-x: auto; }
.wc__daily td { white-space: nowrap; }
.wc__mini { display: flex; width: 70px; height: 6px; border-radius: 3px; overflow: hidden; background: var(--ax-surface); }
.wc__mini i { display: block; height: 100%; width: auto; margin: 0; border-radius: 0; }
/* Monthly budgets: each cap, and the owner's form. */
.wc__budgets { margin: 16px 0 0; border-top: 1px solid var(--ax-border); padding-top: 10px; }
.wc__h { font-size: var(--ax-fs); font-weight: 800; margin: 0 0 4px; }
.wc__budgets h3 { font-size: var(--ax-fs-sm); margin: 10px 0 2px; }
.wc__caps { list-style: none; margin: 6px 0; padding: 0; font-size: var(--ax-fs-sm); }
.wc__caps li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--ax-border); align-items: baseline; }
.wc__caps small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; margin: 10px 0 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wc__form label { display: flex; flex-direction: column; gap: 2px; }
.wc__form select, .wc__form input { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 6px 8px; min-width: 0; }
.wc__form input { width: 130px; }
@media (max-width: 640px) {
  .wc__head { grid-template-columns: 1fr; } .wc__spark30 { display: none; }
  .wc__chart { display: none; } .wc__phone { display: block; }
  .wc__grid { grid-template-columns: 1fr; }
  .wc__grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wc__pair { grid-template-columns: 1fr; }
  .wc__form label, .wc__form input, .wc__form select { width: 100%; } .wc__form .ax-btn { width: 100%; justify-content: center; }}
`
