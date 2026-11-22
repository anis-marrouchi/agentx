import { injectFns } from "../inject"

// --- Run on: the machine an issue's runs go to, on an open post (#2104) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc(),
// $(), act(), note(), findPost(), isOpen() and load().
//
// On an open post whose home is an issue, the owner picks the machine its
// next run starts on: this Mac or a mesh node that hosts the post's agent
// and has the repository checked out. Each node shows its swap use and
// load. A node that went offline shows as such, with Back to this Mac.
// The calls are GET and POST /api/admin/wall/run-on, sent to the node that
// keeps the post, like a comment; the daemon there checks the move (no run
// open, nothing uncommitted, nothing unpushed) and says why when it is
// refused. Owner only: window.AX_WALL_SETTINGS (wall.ts) says who that is,
// and the guard refuses anyone else anyway (#1454).

/** One choice in the select: its name, offline, and its swap and load. */
export function runOnChoiceText(c: { node: string; label?: string; healthy?: boolean; swapUsedPct?: number; load1?: number }): string {
  const nums: string[] = []
  if (typeof c.swapUsedPct === "number") nums.push("swap " + c.swapUsedPct + "%")
  if (typeof c.load1 === "number") nums.push("load " + c.load1.toFixed(1))
  return (c.label || c.node) + (c.healthy === false ? " (offline)" : "") + (nums.length ? " — " + nums.join(", ") : "")
}

/** The stale line: the node it runs on is offline, and since when. */
export function runOnStaleText(d: { current: string; stale?: boolean; staleSince?: string }): string {
  if (!d.stale) return ""
  return d.current + " offline" + (d.staleSince ? " since " + new Date(d.staleSince).toLocaleString() : "") + ": this issue's runs wait for it."
}

export const WALL_RUN_ON_SCRIPT = String.raw`
  ${injectFns({ runOnChoiceText, runOnStaleText })}
  /** Read per post: { loading } | { data } | { error }. */
  var RUNON = {};
  function runOnFits(p) {
    return !!window.AX_WALL_SETTINGS && !!p && !!p.home && p.home.kind === 'issue' && isOpen(p);
  }
  function runOnHtml(p) {
    if (!runOnFits(p)) return '';
    var r = RUNON[p.id];
    if (!r) { RUNON[p.id] = { loading: true }; setTimeout(function () { runOnLoad(p.id); }, 0); r = RUNON[p.id]; }
    if (r.loading) return '<div class="wdo__row wro" aria-label="Run on"><span class="wdo__n">Run on: checking the machines…</span></div>';
    if (r.error) return '<div class="wdo__row wro" aria-label="Run on"><span class="wdo__n">Run on: ' + esc(r.error) + '</span></div>';
    var d = r.data, off = r.sending ? ' disabled' : '';
    var opts = (d.choices || []).map(function (c) {
      return '<option value="' + esc(c.node) + '"' + (c.node === d.current ? ' selected' : '') + '>' + esc(runOnChoiceText(c)) + '</option>';
    });
    // A node it runs on that is no longer offered (offline, or gone from the mesh) still shows as the current one.
    if (d.current !== 'local' && !(d.choices || []).some(function (c) { return c.node === d.current; })) {
      opts.unshift('<option value="' + esc(d.current) + '" selected>' + esc(d.current + (d.stale ? ' (offline)' : '')) + '</option>');
    }
    var stale = runOnStaleText(d);
    return '<div class="wdo__row wro" aria-label="Run on">' +
      '<label for="wro-node">Run on</label> <select id="wro-node"' + off + '>' + opts.join('') + '</select>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-runon="move"' + off + '>Move</button>' +
      (d.current !== 'local' ? '<button type="button" class="ax-btn ax-btn--ghost" data-runon="back"' + off + '>Back to this Mac</button>' : '') +
      (stale ? ' <span class="ax-badge ax-badge--warn" role="note">⚠ ' + esc(stale) + '</span>' : '') +
      '</div>';
  }
  function paintRunOn() {
    var p = findPost(S.post), el = $('wdo-runon');
    if (p && el) el.innerHTML = runOnHtml(p);
  }
  async function runOnLoad(id) {
    var p = findPost(id);
    if (!p) return;
    var r = await act('GET', '/api/admin/wall/run-on?id=' + encodeURIComponent(id), null, p.node && p.node.peer);
    RUNON[id] = r.ok ? { data: r.body } : { error: r.error };
    paintRunOn();
  }
  async function runOnMove(node) {
    var p = findPost(S.post), r = p && RUNON[p.id];
    if (!p || !r || !r.data || r.sending) return;
    if (node === r.data.current) { note(node === 'local' ? 'It already runs on this Mac.' : 'It already runs on ' + node + '.'); return; }
    r.sending = true;
    paintRunOn();
    note('Checking the move…');
    var m = await act('POST', '/api/admin/wall/run-on', { id: p.id, node: node }, p.node && p.node.peer);
    r.sending = false;
    note(m.ok ? (m.body.message || 'Moved.') : 'Not moved: ' + m.error);
    delete RUNON[p.id];
    paintRunOn();
    if (m.ok) load();
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('[data-runon]');
    if (!b) return;
    if (b.getAttribute('data-runon') === 'back') runOnMove('local');
    else runOnMove(($('wro-node') && $('wro-node').value) || 'local');
  });
`
