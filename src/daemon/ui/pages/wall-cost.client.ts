// --- Wall Cost page, browser side (#1423, #1449) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's
// getJson(), act(), headers(), avatar(), render() and S.budgets. The
// numbers and the markup come from costPageModel() and costPageHtml() in
// wall-cost.ts.
//
// renderCost(view) is the one call the Wall's render() makes. It loads the
// cost the first time the Cost view opens and again on a range change;
// refreshCost() is called from the Wall's own load(). The nav count is the
// month's total from the budgets read the Wall already makes.
//
// The page is drawn again only when its markup changes, so a redraw from
// another read does not wipe the dollars being typed in the caps form.

export const WALL_COST_SCRIPT = String.raw`
  var C = { range: 30, data: null, loading: false, error: '', scope: '', capMsg: '', csvMsg: '', more: false, filter: 'all', html: '', usd: null };
  async function loadCost() {
    C.loading = true;
    var want = C.range;
    try {
      var d = await getJson('/api/admin/observability/cost?range=' + (want ? Math.max(2 * want, 30) : 'all'));
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
      var html = C.error ? '<p class="ax-wall__empty" role="alert">Could not load the cost: ' + esc(C.error) + '. The rest of the Wall still works. Pick a range to try again.</p>' +
          '<div class="ax-wall__views wc__tabs" role="tablist" aria-label="Range">' + [7, 14, 30, 90, 0].map(function (n) { return '<button type="button" role="tab" data-crange="' + n + '" class="' + (C.range === n ? 'is-on' : '') + '" aria-selected="' + (C.range === n) + '">' + (n ? n + ' days' : 'All') + '</button>'; }).join('') + '</div>'
        : !C.data ? '<p class="ax-wall__empty">Loading…</p>'
        : costPageHtml(costPageModel(C.data, S.budgets, C.range), costNames(), function (id) { return avatar(id, 'sm'); },
            { scope: C.scope, capMsg: C.capMsg, csvMsg: C.csvMsg, more: C.more, filter: C.filter });
      if (html !== C.html) {
        C.html = html;
        $('wall-cost').innerHTML = html;
        var box = $('wcost-cap-usd');
        if (box && C.usd != null) box.value = C.usd;
      }
    }
    var f = S.budgets && S.budgets.fleet;
    var n = $('wall-cost-n');
    n.textContent = f ? money(f.spentUsd || 0) : '';
    n.setAttribute('title', f ? 'spent this month' : '');
  }
  function costNote(text) { C.capMsg = text; var el = $('wcost-cap-msg'); if (el) el.textContent = text; }
  /** Save the cap in the form: POST /api/admin/budgets, owner-only on the server. */
  async function saveCap() {
    var key = C.scope || ($('wcost-cap-scope') && $('wcost-cap-scope').value) || 'fleet';
    var raw = String(($('wcost-cap-usd') && $('wcost-cap-usd').value) || '').trim();
    var usd = raw === '' ? null : Number(raw);
    if (usd != null && !(usd >= 0 && usd <= 1000000)) { costNote('Type a number of dollars, or empty the box for no cap.'); return; }
    var cut = key.indexOf(':');
    var body = { scope: cut < 0 ? key : key.slice(0, cut), monthlyUsd: usd };
    if (cut >= 0) body.id = key.slice(cut + 1);
    costNote('Saving…');
    var r = await act('POST', '/api/admin/budgets', body);
    if (!r.ok) { costNote(r.error === 'unauthorized' ? 'Not saved: only the owner can change a cap. Sign in with the dashboard token.' : 'Not saved: ' + r.error); return; }
    C.usd = null;
    C.capMsg = usd ? 'Saved. It applies now; paused work resumes if the new cap allows it.' : 'Saved: no cap.';
    try { S.budgets = await getJson('/api/admin/observability/budgets'); } catch (e) { /* the old figures stay until the next refresh */ }
    render();
  }
  /** The CSV of the range picked, fetched with the token, then saved. */
  async function exportCsv() {
    try {
      var r = await fetch('/api/admin/observability/cost.csv?range=' + (C.range || 'all'), { headers: headers() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
      var blob = await r.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : 'agentx-cost.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      C.csvMsg = '';
    } catch (e) { C.csvMsg = 'Export failed: ' + (e && e.message || e) + '.'; }
    render();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-crange],[data-cagent],[data-ccap],[data-ccapsave],[data-ccsv],[data-cmore],[data-cfilter]');
    if (!t) return;
    if (t.hasAttribute('data-crange')) { var n = Number(t.getAttribute('data-crange')); C.range = n >= 0 ? n : 30; C.data = null; C.error = ''; loadCost(); render(); return; }
    if (t.hasAttribute('data-ccap')) {
      C.scope = t.getAttribute('data-ccap'); C.usd = null; C.capMsg = '';
      render();
      var box = $('wcost-cap-usd');
      if (box) { if (box.scrollIntoView) box.scrollIntoView({ block: 'center' }); box.focus(); }
      return;
    }
    if (t.hasAttribute('data-ccapsave')) { saveCap(); return; }
    if (t.hasAttribute('data-ccsv')) { exportCsv(); return; }
    if (t.hasAttribute('data-cmore')) { C.more = !C.more; render(); return; }
    if (t.hasAttribute('data-cfilter')) { C.filter = t.getAttribute('data-cfilter'); render(); return; }
    // A row opens the agent's Wall profile over its posts.
    S.view = 'feed';
    showAgent(t.getAttribute('data-cagent'));
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'wcost-cap-scope') { C.scope = ev.target.value; C.usd = null; C.capMsg = ''; render(); }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'wcost-cap-usd') C.usd = ev.target.value;
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
.wc__bar-row { display: flex; align-items: flex-end; gap: 8px; margin: 0 0 8px; border-bottom: 1px solid var(--ax-border); }
.wc__tabs { flex: 1; min-width: 0; margin: 0; overflow-x: auto; }
.wc__csv { flex: none; margin-bottom: 4px; }
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
.wc__grid > * { min-width: 0; }
.wc__rows { list-style: none; margin: 0; padding: 0; }
.wc__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 10px 4px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wc__who { display: flex; gap: 8px; align-items: center; min-width: 0; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 0; cursor: pointer; }
.wc__who span { display: flex; flex-direction: column; min-width: 0; }
.wc__who small, .wc__runs, .wc__cap small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__who:hover b { text-decoration: underline; }
.wc__amt { text-align: right; }
.wc__cap { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; min-width: 0; }
.wc__bar { flex: 0 1 120px; min-width: 40px; height: 6px; border-radius: 3px; background: var(--ax-surface); overflow: hidden; }
.wc__bar i { display: block; height: 100%; background: var(--ax-accent); }
.wc__bar.is-warn i { background: var(--ax-amber); } .wc__bar.is-err i { background: var(--ax-red, var(--ax-err)); }
.wc__runs { grid-column: 1 / -1; }
.wc__np { color: var(--ax-amber-d, var(--ax-amber)); }
.wc__link { font: inherit; font-size: var(--ax-fs-xs); color: var(--ax-accent); background: none; border: 0; padding: 2px 0; cursor: pointer; }
.wc__link:hover { text-decoration: underline; }
.wc__rail { font-size: var(--ax-fs-sm); background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 8px 12px; }
.wc h3 { font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--ax-muted); margin: 8px 0 4px; }
.wc h3 small { text-transform: none; letter-spacing: 0; }
.wc__rail ul { list-style: none; margin: 0; padding: 0; }
.wc__rail li { display: grid; grid-template-columns: 1fr auto; gap: 0 6px; padding: 2px 0; }
.wc__rail li small { grid-column: 1 / -1; margin: 0; }
.wc__rail p { margin: 0 0 4px; }
.wc__caps, .wc__more { margin-top: 14px; padding-top: 4px; border-top: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wc__caplist, .wc__mix { list-style: none; margin: 0 0 8px; padding: 0; }
.wc__caprow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2px 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--ax-border); }
.wc__capname { min-width: 0; overflow-wrap: anywhere; }
.wc__capline { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; min-width: 0; }
.wc__mix li { display: grid; grid-template-columns: 6.5em minmax(40px, 1fr) auto; gap: 4px 10px; align-items: center; padding: 4px 0; }
.wc__mix small { white-space: nowrap; }
.wc__caprow small, .wc__mix small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__caprow b { font-size: var(--ax-fs-xs); font-weight: 600; }
.wc__caprow.is-warn b { color: var(--ax-amber-d, var(--ax-amber)); } .wc__caprow.is-paused b { color: var(--ax-red-ink, var(--ax-err)); }
.wc__capform { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; }
.wc__capform select, .wc__capform input { font: inherit; padding: 6px 8px; min-height: 36px; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-sm); background: var(--ax-bg); color: var(--ax-text); }
.wc__capform select { max-width: 100%; } .wc__capform input { width: 9em; }
.wc__capmsg { flex-basis: 100%; margin: 0; min-height: 1.2em; }
.wc__caphint { flex-basis: 100%; margin: 0; font-size: var(--ax-fs-xs); }
.wc__toggle { font: inherit; font-weight: 600; color: var(--ax-text); background: none; border: 0; padding: 6px 0; cursor: pointer; }
.wc__mixgrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 16px; }
.wc__mixgrid p { margin: 0 0 4px; }
.wc__chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px; }
.wc__chips button { font: inherit; font-size: var(--ax-fs-xs); padding: 4px 10px; border: 1px solid var(--ax-border-2); border-radius: 999px; background: none; color: var(--ax-text-2); cursor: pointer; }
.wc__chips button.is-on { background: var(--ax-surface); color: var(--ax-text); font-weight: 600; }
.wc__scroll { overflow-x: auto; max-width: 100%; }
.wc__table { width: 100%; border-collapse: collapse; font-size: var(--ax-fs-xs); white-space: nowrap; }
.wc__table th, .wc__table td { padding: 4px 8px; border-bottom: 1px solid var(--ax-border); text-align: left; }
.wc__table th { color: var(--ax-muted); font-weight: 600; }
.wc__table .num { text-align: right; font-variant-numeric: tabular-nums; }
.wc .k { color: var(--ax-muted); }
@media (max-width: 640px) {
  .wc__head { grid-template-columns: 1fr; } .wc__spark30 { display: none; }
  .wc__chart { display: none; } .wc__phone { display: block; }
  .wc__grid { grid-template-columns: minmax(0, 1fr); }
  .wc__bar-row { flex-wrap: wrap; } .wc__tabs { flex-basis: 100%; order: 1; } .wc__csv { margin-left: auto; }}
`
