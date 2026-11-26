// --- Hub Jobs page, browser side (#1861) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// getJson(), writeHash(), render() and the Cost page's costMachines() and
// costWhy() (the machines the Hub's feed reads). The markup comes from
// wall-jobledger.ts (jobLedgerPageHtml).
//
// #page=jobledger. The link keeps the state picked (j-state), the door
// (j-door) and the job opened (job, and j-node when it is on another
// machine). It reads GET /api/admin/job-ledger on every machine the feed
// reads, this one directly and the others through the dashboard's peer
// proxy. A machine on an older AgentX (404) has no jobs; another failure
// is named above the list.
//
// The status line of each job is shown as the daemon sent it. The page
// only reads. It reads while it is open, and again with the Hub's own
// refresh; the nav count (jobs stalled or blocked) shows once it has read.

export const WALL_JOBLEDGER_SCRIPT = String.raw`
  var JL = { key: '', loading: '', list: null, counts: null, total: 0, queue: [], failed: [], error: '', state: 'open', door: '', open: '', node: '', detail: null, detailFor: '', detailErr: '', detailLoading: '' };
  function jlRead(q) {
    var st = q.get('j-state') || 'open', door = q.get('j-door') || '';
    JL.state = jlStates().some(function (s) { return s[0] === st; }) ? st : 'open';
    JL.door = jlDoors().some(function (d) { return d[0] === door; }) ? door : '';
    JL.open = q.get('job') || '';
    JL.node = q.get('j-node') || '';
  }
  function jlWrite(q) {
    if (JL.state !== 'open') q.set('j-state', JL.state);
    if (JL.door) q.set('j-door', JL.door);
    if (JL.open) q.set('job', JL.open);
    if (JL.open && JL.node) q.set('j-node', JL.node);
  }
  function jlUrl() { return '/api/admin/job-ledger?state=' + encodeURIComponent(JL.state) + (JL.door ? '&door=' + encodeURIComponent(JL.door) : ''); }
  function jlKey() { return costMachines().read.map(function (m) { return m.name; }).join(',') + '|' + JL.state + '|' + JL.door; }
  async function loadJobLedger() {
    var ms = costMachines(), key = jlKey();
    JL.loading = key;
    var replies = await Promise.all(ms.read.map(function (m) {
      return getJson(jlUrl(), m.peer).then(function (d) { return { m: m, d: d && Array.isArray(d.jobs) ? d : { jobs: [], total: 0, counts: {} } }; },
        function (e) {
          // An older AgentX has no job ledger to read: it has no jobs to show.
          if (/HTTP 404/.test(String(e && e.message))) return { m: m, d: { jobs: [], total: 0, counts: {} } };
          return { m: m, d: null, err: costWhy(e && e.message) };
        });
    }));
    // A newer read (another state or door, or the machines changed) wins.
    if (JL.loading !== key) return;
    JL.loading = ''; JL.key = key;
    var ok = replies.filter(function (r) { return r.d; }), list = [], counts = {}, total = 0, queue = [];
    ok.forEach(function (r) {
      r.d.jobs.forEach(function (j) { list.push(Object.assign({}, j, { node: r.m.peer ? r.m.name : '', nodeName: r.m.name })); });
      // The queue with its computed times (#1909): sent where due times are on or in shadow.
      (Array.isArray(r.d.queue) ? r.d.queue : []).forEach(function (q) { queue.push(Object.assign({}, q, { nodeName: r.m.name })); });
      Object.keys(r.d.counts || {}).forEach(function (k) { counts[k] = (counts[k] || 0) + (r.d.counts[k] || 0); });
      total += r.d.total || 0;
    });
    // Most recently active first, across machines.
    list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    JL.list = list; JL.counts = counts; JL.total = total;
    JL.queue = queue.sort(function (a, b) { return (b.clearsAt || 0) - (a.clearsAt || 0); });
    JL.failed = replies.filter(function (r) { return !r.d; }).map(function (r) { return { name: r.m.name, why: r.err }; });
    JL.error = ok.length ? '' : JL.failed.map(function (f) { return f.name + ' ' + f.why; }).join('; ');
    render();
  }
  /** The peer to ask for a job on the machine named; undefined when it is not read. */
  function jlPeer(node) {
    if (!node) return null;
    var m = costMachines().read.find(function (x) { return x.name === node; });
    return m ? m.peer : undefined;
  }
  async function loadJobDetail() {
    var id = JL.open, node = JL.node, peer = jlPeer(node);
    if (!id) return;
    // Its machine is not known yet: the feed names the machines, and render() asks again.
    if (peer === undefined && !(S.data && S.data.nodes)) return;
    var mark = id + '|' + node;
    JL.detailLoading = mark;
    var d = null, err = '';
    if (peer === undefined) err = node + ' is not read by this Hub';
    else {
      try { d = await getJson('/api/admin/job-ledger/' + encodeURIComponent(id), peer); }
      catch (e) { err = /HTTP 404/.test(String(e && e.message)) ? 'it is no longer in the ledger' : (node || 'this machine') + ' ' + costWhy(e && e.message); }
    }
    // Handed to another machine: read the same job there too, for the
    // tree across machines. That machine may not be read by this Hub.
    if (d && d.job && d.job.peer) {
      var far = jlPeer(d.job.peer), fd = null, ferr = '';
      if (far === undefined || far === null) ferr = 'this Hub does not read that machine';
      else {
        try { fd = await getJson('/api/admin/job-ledger/' + encodeURIComponent(d.job.remoteId || id), far); }
        catch (e) { ferr = /HTTP 404/.test(String(e && e.message)) ? 'it has no such job yet' : costWhy(e && e.message); }
      }
      d.remote = { peer: d.job.peer, detail: fd && fd.job ? fd : null, err: fd && fd.job ? '' : ferr || 'the reply had no job' };
    }
    if (JL.detailLoading !== mark) return;
    JL.detailLoading = '';
    if (JL.open !== id || JL.node !== node) return;
    if (d && d.job) d.job = Object.assign({}, d.job, { node: node, nodeName: node });
    JL.detail = d && d.job ? d : null;
    JL.detailErr = d && d.job ? '' : err || 'the reply had no job';
    JL.detailFor = mark;
    render();
  }
  /** Called with the Hub's own refresh: a page that was read is read again. */
  function refreshJobLedger() {
    if (!JL.key || S.page !== 'jobledger') return;
    JL.key = ''; loadJobLedger();
    if (JL.open) loadJobDetail();
  }
  /** Called from the Wall's render(), on every page. */
  function renderJobLedger(page) {
    var on = page === 'jobledger';
    $('wall-jobledger').hidden = !on;
    var c = $('nav-n-jobledger');
    if (c) {
      var bad = JL.counts ? (JL.counts.stalled || 0) + (JL.counts.blocked || 0) : 0;
      c.textContent = JL.counts ? String(bad) : '';
      c.classList.toggle('is-zero', !bad);
      c.setAttribute('title', JL.counts ? bad + ' jobs stalled or blocked' : '');
    }
    if (!on) return;
    if (jlKey() !== JL.key && jlKey() !== JL.loading) loadJobLedger();
    var mark = JL.open + '|' + JL.node;
    if (JL.open && JL.detailFor !== mark && JL.detailLoading !== mark) loadJobDetail();
    // A select in use keeps its value: no repaint under it.
    var a = document.activeElement;
    if (a && a.id === 'jl-door') return;
    var shown = JL.open && JL.detailFor === mark;
    $('wall-jobledger').innerHTML = jobLedgerPageHtml({
      list: JL.list, counts: JL.counts, total: JL.total, state: JL.state, door: JL.door, open: JL.open, node: JL.node,
      detail: shown ? JL.detail : null, detailErr: shown ? JL.detailErr : '',
      missed: costMachines().missed.concat(JL.failed), error: JL.error, multi: costMachines().read.length > 1, now: Date.now(), queue: JL.queue,
    });
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-jlstate],[data-jlopen]');
    if (!t || S.page !== 'jobledger') return;
    if (t.hasAttribute('data-jlstate')) {
      JL.state = t.getAttribute('data-jlstate') || 'open';
      // Another list: the first read of it shows as loading, not as the old rows.
      JL.list = null;
    } else {
      var id = t.getAttribute('data-jlopen'), node = t.getAttribute('data-jlnode') || '';
      // Selecting the opened row closes it.
      if (JL.open === id && JL.node === node) { JL.open = ''; JL.node = ''; }
      else { JL.open = id; JL.node = node; }
      JL.detail = null; JL.detailErr = ''; JL.detailFor = '';
    }
    writeHash(); render();
  });
  document.addEventListener('change', function (ev) {
    if (!ev.target || ev.target.id !== 'jl-door') return;
    JL.door = ev.target.value || '';
    JL.list = null;
    if (ev.target.blur) ev.target.blur();
    writeHash(); render();
  });
`

export const WALL_JOBLEDGER_CSS = `
.wjl__tools { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; justify-content: space-between; margin: 12px 16px 8px; }
.wjl__fold { flex: 1; min-width: 0; }
.wjl__fold > summary { margin: 0 0 4px; }
.wjl__fold .axp-fold__n { margin-left: 0; }
.wjl__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wjl__chips button { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 4px 12px; cursor: pointer; min-height: 30px; }
.wjl__chips button .n { font-weight: 500; color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.wjl__chips button[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wjl__chips button[aria-pressed="true"] .n { color: inherit; }
.wjl__by { font-size: var(--ax-fs-xs); color: var(--ax-muted); display: inline-flex; gap: 6px; align-items: center; }
.wjl__by select { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 5px 8px; }
.wjl__warn { margin: 0 16px 8px; padding: 6px 10px; border-radius: var(--ax-radius-sm); background: color-mix(in oklch, var(--ax-amber) 14%, transparent); font-size: var(--ax-fs-sm); }
.wjl__queue { margin: 0 16px 10px; padding: 8px 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.wjl__queue ul { list-style: none; margin: 0; padding: 0; }
.wjl__queue li { padding: 2px 0; overflow-wrap: anywhere; }
.wjl__queue .k, .wjl__qh .k { color: var(--ax-muted); font-weight: 400; font-size: var(--ax-fs-xs); }
.wjl__qh { margin: 0 0 4px; font-weight: 600; }
.wjl__list { border-top: 1px solid var(--ax-border); }
.wjl__top { margin-bottom: 12px; border-bottom: 2px solid var(--ax-border-2); }
.wjl { border-bottom: 1px solid var(--ax-border); border-left: 3px solid transparent; }
.wjl.is-blocked { border-left-color: var(--ax-amber); }
.wjl.is-stalled { border-left-color: var(--ax-red); }
.wjl__row { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; width: 100%; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 10px 16px 2px 13px; cursor: pointer; }
.wjl__row:hover, .wjl.is-open > .wjl__row { background: var(--ax-surface); }
.wjl__h { font-weight: 600; overflow-wrap: anywhere; }
.wjl__st { display: inline-block; font-size: var(--ax-fs-sm); font-weight: 600; border-radius: var(--ax-radius-sm); padding: 2px 9px; background: var(--ax-surface); color: var(--ax-text-2); overflow-wrap: anywhere; }
.wjl__st.is-working { background: color-mix(in oklch, var(--ax-green) 18%, transparent); color: var(--ax-green-d); }
.wjl__st.is-blocked { background: color-mix(in oklch, var(--ax-amber) 22%, transparent); color: var(--ax-amber-ink); }
.wjl__st.is-stalled { background: color-mix(in oklch, var(--ax-red) 18%, transparent); color: var(--ax-red-ink); }
.wjl__st.is-done, .wjl__st.is-dropped { background: transparent; border: 1px dashed var(--ax-border-2); color: var(--ax-muted); font-weight: 500; }
.wjl__facts { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; padding: 4px 16px 10px 13px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wjl__facts > span { overflow-wrap: anywhere; min-width: 0; }
.wjl__tag { font-weight: 600; color: var(--ax-text-2); background: var(--ax-surface); border-radius: var(--ax-radius-pill); padding: 0 8px; }
.wjl__d { padding: 0 16px 12px 13px; font-size: var(--ax-fs-sm); }
.wjl__d p { margin: 0 0 6px; overflow-wrap: anywhere; }
.wjl__d .k { color: var(--ax-muted); }
.wjl__d code { font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.wjl__text { white-space: pre-wrap; background: var(--ax-surface); border-radius: var(--ax-radius-sm); padding: 8px 10px; max-height: 320px; overflow-y: auto; }
.wjl__kids { list-style: none; margin: 0 0 8px; padding: 0 0 0 12px; border-left: 2px solid var(--ax-border-2); }
.wjl__kids li { padding: 2px 0; }
.wjl__far { margin: 0 0 8px; padding: 6px 0 0 12px; border-left: 2px solid var(--ax-border-2); }
.wjl__link { font: inherit; font-weight: 600; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.wjl__link:hover { text-decoration: underline; }
.wjl__scroll { overflow-x: auto; }
.wjl__runs { border-collapse: collapse; width: 100%; font-size: var(--ax-fs-xs); margin: 0 0 6px; }
.wjl__runs th, .wjl__runs td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wjl__runs th { color: var(--ax-muted); font-weight: 600; }
.wjl__runs .is-err { color: var(--ax-red-ink); }
.wjl__foot { padding: 10px 16px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
#wall-jobledger > .ax-wall__empty { padding: 32px 16px; text-align: center; }
/* Dark redefines the ink tokens; the green one stays dark, so lift it. */
[data-theme="dark"] .wjl__st.is-working { color: var(--ax-green); }
@media (max-width: 640px) {
  .wjl__tools { flex-direction: column; align-items: stretch; }
  .wjl__by { justify-content: space-between; }
}
`
