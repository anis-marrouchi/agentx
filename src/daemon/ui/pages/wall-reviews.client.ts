// --- Wall review queue, browser side (#1182) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc(),
// when(), stateBadge(), getJson(), headers() and plainMarkerText(). Reads only
// /api/admin/wall/reviews on this node: graph classifications that went to
// review, the decision and its reason, the nodes an approval added, and a
// link to the wiki search for the path. No decision buttons: deciding stays
// on the graph page and with `agentx graph review`.
//
// renderReviews(view) is the one call the Wall's render() makes. It loads
// the queue the first time the Reviews view opens; refreshReviews() is
// called from the Wall's own load() so the queue refreshes with the page.

export const WALL_REVIEWS_SCRIPT = String.raw`
  var R = { data: null, loading: false, threads: {}, tab: 'pending' };
  function revPath(path) { return (path || []).join(' › ') || '(root)'; }
  function revAxes(axes) { return Object.keys(axes || {}).map(function (k) { return k + '=' + axes[k]; }).join(', '); }
  function revDiff(lines) {
    var mark = { add: '+', keep: ' ', missing: '?' };
    return '<pre class="wr__diff" aria-label="Taxonomy change">' + lines.map(function (l) {
      var where = l.level ? ' (' + l.level + (l.parentId ? ', under ' + l.parentId : '') + ')' : '';
      var axes = revAxes(l.axes);
      return '<span class="' + esc(l.op) + '">' + mark[l.op] + ' ' + esc(l.id) + esc(where) + (axes ? '  ' + esc(axes) : '') +
        (l.op === 'missing' ? '  ' + esc('not in nodes.json now') : '') + '</span>';
    }).join('\n') + '</pre>';
  }
  function revThread(t) {
    if (t.loading) return '<p class="ax-wall__empty">Loading thread…</p>';
    if (t.error) return '<p class="ax-wall__empty">Thread not available: ' + esc(t.error) + '</p>';
    return '<ol class="wt">' + t.events.map(function (e) {
      return '<li><span class="k">' + esc(e.status) + '</span> <span class="who">' + esc(e.who || '') + '</span> ' + when(e.at) + '<div class="txt">' + esc(plainMarkerText(e.text)) + '</div></li>';
    }).join('') + '</ol>';
  }
  function revCard(r) {
    var d = r.decision;
    var decided = d ? '<b>' + (d.verdict === 'approved' ? 'Approved' : 'Rejected') + '</b> by ' + esc(d.by || 'the graph page (no reviewer recorded)') + ' ' + when(d.at) +
      '<div>' + (d.reason ? esc(d.reason) : '<span class="k">No reason recorded.</span>') + '</div>'
      : 'Waiting for a decision. <span class="k">A skip leaves no record, so a skipped item stays here.</span>';
    var proposed = Object.keys(r.proposedAxes || {});
    var wiki = r.wikiQuery ? '<a href="/admin/wiki/search?q=' + encodeURIComponent(r.wikiQuery) + '">Wiki results for this path</a> <span class="k">(the reviewer’s own queries are not recorded)</span>'
      : '<span class="k">No path to search.</span>';
    var t = R.threads[r.id];
    return '<article class="wr is-' + esc(r.status) + '" id="review-' + esc(r.id) + '">' +
      '<div class="wr__head">' + stateBadge(r.status) + '<span class="wr__path">' + esc(revPath(r.path)) + '</span>' +
        (r.confidence != null ? '<span class="k">confidence ' + Number(r.confidence).toFixed(2) + '</span>' : '<span class="k">no confidence</span>') + '</div>' +
      (r.message ? '<p class="wr__msg">' + esc(plainMarkerText(r.message)) + '</p>' : '') +
      '<dl class="wr__facts">' +
        '<dt>Proposed axes</dt><dd>' + (proposed.length ? proposed.map(function (id) { return '<div><b>' + esc(id) + '</b> ' + esc(revAxes(r.proposedAxes[id]) || '—') + '</div>'; }).join('') : 'none, existing nodes only') + '</dd>' +
        '<dt>Decision</dt><dd>' + decided + '</dd>' +
        '<dt>Wiki</dt><dd>' + wiki + '</dd>' +
      '</dl>' +
      (r.taxonomy && r.taxonomy.length ? revDiff(r.taxonomy) : '') +
      '<div class="wr__meta"><span>Classification <b title="' + esc(r.id) + '">' + esc(r.id.slice(0, 12)) + '</b></span>' +
        '<span>Proposed ' + when(r.proposedAt) + '</span><span>By ' + esc(r.source) + (r.agentId ? ', for ' + esc(r.agentId) : '') + '</span>' +
        (r.channel ? '<span>Channel ' + esc(r.channel) + '</span>' : '') +
        '<button type="button" data-rthread="' + esc(r.id) + '" aria-expanded="' + (t ? 'true' : 'false') + '">' + (t ? 'Hide thread' : 'Thread') + '</button></div>' +
      (t ? revThread(t) : '') + '</article>';
  }
  function revList() {
    var v = R.data;
    if (!v) return '<p class="ax-wall__empty">Loading…</p>';
    if (v.error) return '<p class="ax-wall__empty">Could not load the review queue: ' + esc(v.error) + '</p>';
    var list = v.reviews || [], c = v.counts || {};
    var head = '<p class="ax-wall__count">' + (c.pending || 0) + ' pending · ' + (c.approved || 0) + ' approved · ' + (c.rejected || 0) + ' rejected' +
      (c.autoApproved ? ' · ' + c.autoApproved + ' approved by the classifier without review (not shown)' : '') +
      '</p>';
    if (!list.length) return head + '<p class="ax-wall__empty">No classification has gone to review on this machine.' +
      (v.enabled ? '' : ' The intent graph is off here (graph.enabled in agentx.json).') + '</p>';
    // A feed with Pending, Approved and Rejected tabs (#1355), and the
    // paths the graph is least sure about over the pending ones.
    var tabs = [['pending', 'Pending', c.pending || 0], ['approved', 'Approved', c.approved || 0], ['rejected', 'Rejected', c.rejected || 0]];
    var shown = list.filter(function (r) { return r.status === R.tab; });
    var unsure = list.filter(function (r) { return r.status === 'pending' && r.confidence != null; })
      .sort(function (a, b) { return a.confidence - b.confidence; }).slice(0, 3);
    return head + '<div class="ax-wall__views wr__tabs" role="tablist">' + tabs.map(function (t) {
        return '<button type="button" role="tab" data-rtab="' + t[0] + '" class="' + (R.tab === t[0] ? 'is-on' : '') + '" aria-selected="' + (R.tab === t[0] ? 'true' : 'false') + '">' + t[1] + ' ' + t[2] + '</button>';
      }).join('') + '</div>' +
      (R.tab === 'pending' && unsure.length ? '<p class="ax-wall__count">Least sure: ' + unsure.map(function (r) { return esc(revPath(r.path)) + ' (' + Number(r.confidence).toFixed(2) + ')'; }).join(', ') + '</p>' : '') +
      (shown.length ? shown.map(revCard).join('') : '<p class="ax-wall__empty">Nothing ' + esc(R.tab) + '.</p>');
  }
  async function loadReviews() {
    R.loading = true;
    try { R.data = await getJson('/api/admin/wall/reviews?status=all'); } catch (e) { R.data = { error: e.message }; }
    R.loading = false;
    render();
  }
  function refreshReviews() { if (R.data) loadReviews(); }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderReviews(view) {
    var on = view === 'reviews';
    $('wall-reviews').hidden = !on;
    if (on) {
      $('wall-count').hidden = true;
      $('wall-profile').hidden = true;
      if (!R.data && !R.loading) loadReviews();
      $('wall-reviews').innerHTML = revList();
    }
    $('wall-rev-n').textContent = R.data && R.data.counts && R.data.counts.pending ? String(R.data.counts.pending) : '';
  }
  async function toggleReviewThread(id) {
    if (R.threads[id]) { delete R.threads[id]; render(); return; }
    R.threads[id] = { loading: true };
    render();
    try {
      var r = await fetch('/api/admin/wall/reviews?id=' + encodeURIComponent(id), { headers: headers() });
      var body = await r.json();
      R.threads[id] = r.ok ? { events: body.events || [] } : { error: body.error || ('HTTP ' + r.status) };
    } catch (e) { R.threads[id] = { error: String(e && e.message || e) }; }
    render();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-rthread],[data-rtab]');
    if (t && t.hasAttribute('data-rtab')) { R.tab = t.getAttribute('data-rtab'); render(); }
    else if (t) toggleReviewThread(t.getAttribute('data-rthread'));
  });
`

export const WALL_REVIEWS_CSS = `
.wr__tabs { margin: 0 0 10px; border-bottom: 1px solid var(--ax-border); }
.wr { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 10px 12px; margin-bottom: 10px; font-size: var(--ax-fs-sm); }
.wr.is-pending { border-left: 3px solid var(--ax-amber); }
.wr.is-rejected { border-left: 3px solid var(--ax-red); }
.wr__head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.wr__path { font-family: var(--ax-mono); font-weight: 600; overflow-wrap: anywhere; }
.wr__msg { margin: 4px 0 0; color: var(--ax-text-2); overflow-wrap: anywhere; }
.wr__facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 6px 0 0; }
.wr__facts dt { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wr__facts dd { margin: 0; overflow-wrap: anywhere; }
.wr__facts .k, .wr__meta { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wr__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
.wr__meta button { font: inherit; background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 0; }
.wr__diff { margin: 6px 0 0; padding: 6px 8px; background: var(--ax-surface); border-radius: var(--ax-radius-sm); font-family: var(--ax-mono); font-size: var(--ax-fs-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.wr__diff .add { color: var(--ax-green-d); }
.wr__diff .missing { color: var(--ax-red-ink, var(--ax-err)); }
.wr__diff .keep { color: var(--ax-muted); }
@media (max-width: 640px) { .wr__facts { grid-template-columns: 1fr; } }
`
