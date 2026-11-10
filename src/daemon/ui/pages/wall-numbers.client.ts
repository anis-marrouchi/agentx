// --- Hub Numbers page, browser side (#1826 N2) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), getJson(), writeHash(), render() and the Cost page's
// costMachines() (the machines the Hub's feed reads). The markup comes
// from wall-numbers.ts (numbersPageHtml, numMerge, numJobHtml).
//
// #page=numbers. The link keeps the tags picked (n-tags), the grouping
// (n-by) and the number shown opened (num). It reads GET /api/admin/numbers
// on every machine the feed reads, this one directly and the others
// through the dashboard's peer proxy. A machine on an older AgentX (404)
// has no numbers; another failure is named under the list.
//
// The nav entry shows once any machine has a number, so a Hub with no
// numbers set up looks as it did. The Jobs page shows a value line's
// number (crons.<id>.value.number) through numJob(). It only reads.

export const WALL_NUMBERS_SCRIPT = String.raw`
  var NUM = { key: '', loading: '', list: null, byNode: {}, failed: [], tags: [], by: '', open: '' };
  function numRead(q) {
    NUM.tags = (q.get('n-tags') || '').split(',').filter(Boolean);
    NUM.by = q.get('n-by') || '';
    NUM.open = q.get('num') || '';
    NUM.scrolled = false;
  }
  function numWrite(q) {
    if (NUM.tags.length) q.set('n-tags', NUM.tags.join(','));
    if (NUM.by) q.set('n-by', NUM.by);
    if (NUM.open) q.set('num', NUM.open);
  }
  function numKey() { return costMachines().read.map(function (m) { return m.name; }).join(','); }
  async function loadNumbers() {
    var ms = costMachines(), key = numKey();
    NUM.loading = key;
    var replies = await Promise.all(ms.read.map(function (m) {
      return getJson('/api/admin/numbers', m.peer).then(function (d) { return { m: m, d: d && Array.isArray(d.numbers) ? d : { numbers: [] } }; },
        function (e) {
          // An older AgentX has no /api/admin/numbers: it has no numbers to show.
          if (/HTTP 404/.test(String(e && e.message))) return { m: m, d: { numbers: [] } };
          return { m: m, d: null, err: costWhy(e && e.message) };
        });
    }));
    if (NUM.loading !== key) return;
    NUM.loading = ''; NUM.key = key;
    var ok = replies.filter(function (r) { return r.d; });
    NUM.list = numMerge(ok.map(function (r) { return { node: r.m.name, numbers: r.d.numbers }; }));
    NUM.byNode = {};
    NUM.list.forEach(function (n) { (NUM.byNode[n.node] = NUM.byNode[n.node] || {})[n.id] = n; });
    NUM.failed = replies.filter(function (r) { return !r.d; }).map(function (r) { return { name: r.m.name, why: r.err }; });
    NUM.error = ok.length ? '' : NUM.failed.map(function (f) { return f.name + ' ' + f.why; }).join('; ');
    render();
  }
  function refreshNumbers() { NUM.key = ''; loadNumbers(); }
  /** Each owner agent's department, from the org read (S.org). */
  function numDepts() {
    var out = {}, by = S.org && S.org.byDepartment;
    ((by && by.boxes) || []).forEach(function (d) {
      [d.head].concat(d.members || []).forEach(function (key) {
        var m = /^agent:(.+)$/.exec(key || '');
        if (m && !out[m[1]]) out[m[1]] = { id: d.id, name: d.name };
      });
    });
    return out;
  }
  /** The number a job's value line names, on the job's own machine first. */
  function numJob(v, nodeName) {
    var id = v && v.number;
    if (!id) return '';
    var n = (NUM.byNode[nodeName] && NUM.byNode[nodeName][id]) || (NUM.list || []).find(function (x) { return x.id === id; }) || null;
    if (!NUM.list && !NUM.loading) loadNumbers();
    return numJobHtml(id, n, !!NUM.list);
  }
  /** Called from the Wall's render(), on every page. */
  function renderNumbers(page) {
    var on = page === 'numbers';
    $('wall-numbers').hidden = !on;
    if (numKey() !== NUM.key && numKey() !== NUM.loading && (on || NUM.key)) loadNumbers();
    var n = NUM.list ? NUM.list.length : 0;
    // No number anywhere: no nav entry, so nothing changes for a Hub without numbers.
    document.querySelectorAll('[data-nav="numbers"]').forEach(function (a) { a.hidden = !n && !on; });
    var c = $('nav-n-numbers');
    if (c) {
      var bad = (NUM.list || []).filter(function (x) { return x.status === 'missed' || x.status === 'missed_twice' || x.status === 'no_reading'; }).length;
      c.textContent = NUM.list ? String(bad) : '';
      c.classList.toggle('is-zero', !bad);
      c.setAttribute('title', NUM.list ? bad + ' of ' + n + ' numbers missed or without a reading' : '');
    }
    if (!on) return;
    // A select in use keeps its value: no repaint under it.
    var a = document.activeElement;
    if (a && a.id === 'n-by') return;
    $('wall-numbers').innerHTML = numbersPageHtml({ list: NUM.list, tags: NUM.tags, by: NUM.by, open: NUM.open, deptOf: numDepts(),
      missed: costMachines().missed.concat(NUM.failed), error: NUM.error });
    if (NUM.open && !NUM.scrolled) {
      var el = document.getElementById('num-' + NUM.open);
      if (el) { NUM.scrolled = true; if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); var s = el.querySelector('summary'); if (s && s.focus) s.focus(); }
    }
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-ntag],[data-nclear]');
    if (!t) return;
    if (t.hasAttribute('data-nclear')) NUM.tags = [];
    else {
      var tag = t.getAttribute('data-ntag'), i = NUM.tags.indexOf(tag);
      if (i >= 0) NUM.tags.splice(i, 1); else NUM.tags.push(tag);
    }
    writeHash(); render();
    var again = document.querySelector('[data-ntag="' + (t.getAttribute('data-ntag') || '').replace(/"/g, '') + '"]') || document.querySelector('[data-ntag]');
    if (again && again.focus) again.focus();
  });
  document.addEventListener('change', function (ev) {
    if (!ev.target || ev.target.id !== 'n-by') return;
    NUM.by = ev.target.value;
    if (ev.target.blur) ev.target.blur();
    writeHash(); render();
  });
  // Opening a number keeps it in the link, so the page can be shared opened.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.getAttribute || !d.hasAttribute('data-num') || S.page !== 'numbers') return;
    var id = d.getAttribute('data-num');
    if (d.open) NUM.open = id; else if (NUM.open === id) NUM.open = '';
    NUM.scrolled = true;
    writeHash();
  }, true);
`

export const WALL_NUMBERS_CSS = `
.wnm__sum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 12px 16px 10px; }
.wnm__sum div { background: var(--ax-surface); border-radius: var(--ax-radius); padding: 8px 10px; min-width: 0; border-left: 3px solid var(--ax-border-2); }
.wnm__sum dt { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wnm__sum dd { margin: 0; font-weight: 700; font-size: 1.3em; font-variant-numeric: tabular-nums; }
.wnm__sum .is-on_target { border-left-color: var(--ax-green); }
.wnm__sum .is-missed { border-left-color: var(--ax-amber); }
.wnm__sum .is-missed_twice { border-left-color: var(--ax-red); }
.wnd { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin: 0 16px 12px; }
.wnd__card { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 8px 12px; min-width: 0; }
.wnd__card h3 { font-size: var(--ax-fs-sm); margin: 0 0 6px; overflow-wrap: anywhere; }
.wnd__card h3 small { color: var(--ax-muted); font-weight: 400; }
.wnd__counts { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 4px; }
.wnd__bad { list-style: none; margin: 4px 0 0; padding: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wnd__bad li { padding: 1px 0; overflow-wrap: anywhere; }
.wnm__tools { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; justify-content: space-between; margin: 0 16px 8px; }
.wnm__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wnm__chips button { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 4px 12px; cursor: pointer; min-height: 30px; }
.wnm__chips button[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wnm__chips button.is-clear { color: var(--ax-accent); border-color: transparent; }
.wnm__by { font-size: var(--ax-fs-xs); color: var(--ax-muted); display: inline-flex; gap: 6px; align-items: center; }
.wnm__by select { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 5px 8px; }
.wnm__warn { margin: 0 16px 8px; padding: 6px 10px; border-radius: var(--ax-radius-sm); background: color-mix(in oklch, var(--ax-amber) 14%, transparent); font-size: var(--ax-fs-sm); }
.wnm__gh { font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--ax-muted); margin: 14px 16px 4px; }
.wnm__gh small { font-weight: 400; }
.wnm__list { border-top: 1px solid var(--ax-border); }
.wnm { border-bottom: 1px solid var(--ax-border); }
.wnm > summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(90px, auto) 96px 110px; gap: 4px 12px; align-items: center; padding: 10px 16px; cursor: pointer; list-style: none; }
.wnm > summary::-webkit-details-marker { display: none; }
.wnm > summary:hover { background: var(--ax-surface); }
.wnm > summary:focus-visible, .wnm__chips button:focus-visible, .wnm__by select:focus-visible, .wnd__bad a:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
.wnm__n { display: flex; flex-direction: column; min-width: 0; }
.wnm__n b { overflow-wrap: anywhere; }
.wnm__n small, .wnm__v small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wnm__tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.wnm__tag { font-size: var(--ax-fs-xs); color: var(--ax-text-2); background: var(--ax-surface); border-radius: var(--ax-radius-pill); padding: 0 8px; }
.wnm__v { display: flex; flex-direction: column; text-align: right; font-variant-numeric: tabular-nums; }
.wnm__v b.is-none, .wnm__rd .is-none { color: var(--ax-muted); font-style: italic; font-weight: 500; }
.wnm__spark { width: 96px; height: 24px; display: block; }
.wnm__spark polyline { fill: none; stroke: var(--ax-accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.wnm__spark circle { fill: var(--ax-accent); }
.wnm__spark.is-on_target .wnm__dot { fill: var(--ax-green); }
.wnm__spark.is-missed .wnm__dot { fill: var(--ax-amber); }
.wnm__spark.is-missed_twice .wnm__dot { fill: var(--ax-red); }
.wnm__st { display: inline-block; justify-self: end; font-size: var(--ax-fs-xs); font-weight: 600; border-radius: var(--ax-radius-pill); padding: 1px 9px; white-space: nowrap; background: var(--ax-surface); color: var(--ax-text-2); }
.wnm__st.is-on_target { background: color-mix(in oklch, var(--ax-green) 18%, transparent); color: var(--ax-green-d); }
.wnm__st.is-missed { background: color-mix(in oklch, var(--ax-amber) 22%, transparent); color: var(--ax-amber-ink); }
.wnm__st.is-missed_twice { background: color-mix(in oklch, var(--ax-red) 18%, transparent); color: var(--ax-red-ink); }
.wnm__st.is-no_reading { background: transparent; border: 1px dashed var(--ax-border-2); color: var(--ax-muted); }
.wnm__d { padding: 0 16px 12px; font-size: var(--ax-fs-sm); }
.wnm__d p { margin: 0 0 6px; overflow-wrap: anywhere; }
.wnm__d .k { color: var(--ax-muted); }
.wnm__d code { font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.wnm__scroll { overflow-x: auto; }
.wnm__rd { border-collapse: collapse; width: 100%; font-size: var(--ax-fs-xs); }
.wnm__rd th, .wnm__rd td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wnm__rd th { color: var(--ax-muted); font-weight: 600; }
.wnm__rd td:first-child { white-space: nowrap; }
.wnm__rd .is-err { color: var(--ax-red-ink); }
.wnm__none { margin: 16px; padding: 16px; border: 1px dashed var(--ax-border-2); border-radius: var(--ax-radius); font-size: var(--ax-fs-sm); }
.wnm__none p { margin: 0 0 6px; }
.wnm__foot { padding: 10px 16px; }
.wnm__job .wnm__st, .wjb__n .wnm__job .wnm__st { display: inline-block; padding: 0 7px; vertical-align: 1px; }
.wnm__rd td:nth-child(2) { white-space: nowrap; }
/* Dark redefines the ink tokens; the green one stays dark, so lift it. */
[data-theme="dark"] .wnm__st.is-on_target { color: var(--ax-green); }
@media (max-width: 640px) {
  .wnm__sum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wnm > summary { grid-template-columns: minmax(0, 1fr) auto; }
  .wnm__v { text-align: right; }
  .wnm__spark { grid-column: 1; width: 100%; max-width: 160px; }
  .wnm__st { grid-column: 2; }
  .wnm__tools { flex-direction: column; align-items: stretch; }
  .wnm__by { justify-content: space-between; }
}
`
