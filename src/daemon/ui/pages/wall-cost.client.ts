// --- Wall Cost page, browser side (#1423) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's
// getJson(), avatar(), nameOf(), render() and S.budgets. The numbers and the
// markup come from costPageModel() and costPageHtml() in wall-cost.ts.
//
// renderCost(view) is the one call the Wall's render() makes. It loads the
// cost the first time the Cost view opens and again on a range change;
// refreshCost() is called from the Wall's own load(). The nav count is the
// month's total from the budgets read the Wall already makes.

export const WALL_COST_SCRIPT = String.raw`
  var C = { range: 30, data: null, loading: false, error: '' };
  async function loadCost() {
    C.loading = true;
    var want = C.range;
    try {
      var d = await getJson('/api/admin/observability/cost?range=' + Math.max(2 * want, 30));
      if (want === C.range) { C.data = d; C.error = ''; }
    } catch (e) { if (want === C.range) { C.data = null; C.error = e.message; } }
    C.loading = false;
    render();
  }
  function refreshCost() { if (C.data || C.error) loadCost(); }
  function costNames() {
    var out = {}, info = agentInfo();
    Object.keys(info).forEach(function (id) { out[id] = info[id].name; });
    return out;
  }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderCost(view) {
    var on = view === 'cost';
    $('wall-cost').hidden = !on;
    if (on) {
      $('wall-count').hidden = true;
      $('wall-profile').hidden = true;
      if (!C.data && !C.error && !C.loading) loadCost();
      $('wall-cost').innerHTML = C.error ? '<p class="ax-wall__empty">Could not load the cost: ' + esc(C.error) + '. The rest of the Wall still works; <a href="/admin/cost">the classic Cost page</a> may say more.</p>'
        : !C.data ? '<p class="ax-wall__empty">Loading…</p>'
        : costPageHtml(costPageModel(C.data, S.budgets, C.range), costNames(), function (id) { return avatar(id, 'sm'); });
    }
    var f = S.budgets && S.budgets.fleet;
    var n = $('wall-cost-n');
    n.textContent = f ? money(f.spentUsd || 0) : '';
    n.setAttribute('title', f ? 'spent this month' : '');
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-crange],[data-cagent]');
    if (!t) return;
    if (t.hasAttribute('data-crange')) { C.range = Number(t.getAttribute('data-crange')) || 30; C.data = null; C.error = ''; loadCost(); render(); return; }
    // A row opens the agent's Wall profile over its posts.
    S.view = 'feed';
    showAgent(t.getAttribute('data-cagent'));
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
.wc__amt { text-align: right; }
.wc__cap { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; min-width: 0; }
.wc__bar { flex: 0 1 120px; min-width: 40px; height: 6px; border-radius: 3px; background: var(--ax-surface); overflow: hidden; }
.wc__bar i { display: block; height: 100%; background: var(--ax-accent); }
.wc__bar.is-warn i { background: var(--ax-amber); } .wc__bar.is-err i { background: var(--ax-red, var(--ax-err)); }
.wc__runs { grid-column: 1 / -1; }
.wc__np { color: var(--ax-amber-d, var(--ax-amber)); }
.wc__rail { font-size: var(--ax-fs-sm); background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 8px 12px; }
.wc__rail h3 { font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--ax-muted); margin: 8px 0 4px; }
.wc__rail ul { list-style: none; margin: 0; padding: 0; }
.wc__rail li { display: grid; grid-template-columns: 1fr auto; gap: 0 6px; padding: 2px 0; }
.wc__rail li small { grid-column: 1 / -1; margin: 0; }
.wc__rail p { margin: 0 0 4px; }
.wc .k { color: var(--ax-muted); }
@media (max-width: 640px) {
  .wc__head { grid-template-columns: 1fr; } .wc__spark30 { display: none; }
  .wc__chart { display: none; } .wc__phone { display: block; }
  .wc__grid { grid-template-columns: 1fr; }}
`
