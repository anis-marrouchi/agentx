// --- Wall build line, browser side (#1444, design #1451 frame 0) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's $.
//
// Which build the daemon runs, on every Wall view: version, short commit
// and since when, on the right of the title row (one small line under the
// title on a phone). "Restart pending" shows under the classic top bar's
// rule (the code on disk is newer than the running daemon) with the same
// hover text. Same source and the same one-minute refresh as the classic
// top bar: GET /api/node/build. Until the first answer the line is not
// drawn, but keeps its height; when an answer fails after one worked, the
// last one stays, marked "as of" its time.

export const WALL_BUILD_SCRIPT = String.raw`
  // --- Build line (#1444): version, commit, since, restart pending ---
  var BUILD_EVERY_MS = 60e3;
  function buildWhen(d) {
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  /** The build line's HTML for one answer; asOf marks an old one. */
  function buildHtml(b, asOf) {
    var d = b.startedAt ? new Date(b.startedAt) : null;
    var since = d && !isNaN(d.getTime()) ? '<span class="wbl__since">since ' + esc(buildWhen(d)) + '</span>' : '';
    return '<span class="wbl__v">' + esc(b.version) + (b.commit ? ' · ' + esc(b.commit) : '') + '</span>' + since +
      (b.diskNewer ? '<span class="ax-badge ax-badge--warn wbl__stale" role="status">Restart pending</span>' : '') +
      (asOf ? '<span class="ax-badge wbl__asof">as of ' + esc(asOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</span>' : '');
  }
  function buildTitle(b) {
    return (b.diskNewer
      ? 'The code on disk is newer than the running daemon. Restart the daemon to load it.'
      : 'The build the daemon is running, and when it started.') + (b.node ? ' Node: ' + b.node : '');
  }
  var buildLast = null, buildAt = null;
  function paintBuild(asOf) {
    var el = $('wall-build');
    if (!el || !buildLast) return;
    el.innerHTML = buildHtml(buildLast, asOf);
    el.title = buildTitle(buildLast);
    // Restart pending leads to the restart controls (Restart when idle).
    el.setAttribute('href', buildLast.diskNewer ? '/live' : '#page=live');
    el.classList.remove('is-wait');
    el.removeAttribute('aria-hidden');
  }
  function loadBuild() {
    fetch('/api/node/build').then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      if (!b || !b.version) throw new Error('no build');
      buildLast = b; buildAt = new Date();
      paintBuild(null);
    }).catch(function () { if (buildLast) paintBuild(buildAt); });
  }
  loadBuild();
  setInterval(loadBuild, BUILD_EVERY_MS);
`

export const WALL_BUILD_CSS = `
/* Build line (#1444): right of the title; under it on a phone. */
.wbl { margin-left: auto; padding-left: 12px; display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 6px; align-items: center; font-size: var(--ax-fs-xs); color: var(--ax-muted); text-decoration: none; font-variant-numeric: tabular-nums; min-height: 20px; }
.wbl:hover .wbl__v { text-decoration: underline; }
.wbl:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; border-radius: 4px; }
.wbl.is-wait { visibility: hidden; }
.wbl__v { font-family: var(--ax-mono); color: var(--ax-text); }
.wbl__stale, .wbl__asof { font-weight: 600; }
@media (max-width: 640px) {
  .ax-wall__titlebar { flex-wrap: wrap; }
  .wbl { order: 9; flex-basis: 100%; margin: 2px 0 0; padding-left: 0; justify-content: flex-start; font-size: 12px; }
}
`
