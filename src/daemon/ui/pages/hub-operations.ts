// Hub › Operations (#2101 P8, mock R8): the fleet's Operations views in the
// Hub, under the Hub's own navigation, instead of a jump to the separate
// /mesh page with its old top bar.
//
// The page holds /mesh in embed mode (no top bar, no assistant drawer) in a
// same-origin frame. The Operations scripts keep their own ids, polling and
// drawer, so nothing in the Hub's script has to change shape for them. The
// frame loads the first time the page opens, not with the Hub, because
// Operations polls the fleet while it is showing.

/** Where the frame points: /mesh without its top bar, on the Operations tab. */
export const HUB_OPERATIONS_SRC = "/mesh?embed=1&view=ops"

/** The Hub's Operations section. Empty frame until the page first opens. */
export function hubOperationsPageHtml(): string {
  return `<section id="wall-operations" class="hops" aria-label="Operations: schedules, routines, nodes and agents across the fleet" hidden>
    <iframe class="hops__frame" id="wall-ops-frame" title="Operations" data-src="${HUB_OPERATIONS_SRC}"></iframe>
    <p class="hops__foot"><a href="/mesh" target="_top">Open Operations on its own page</a></p>
  </section>`
}

export const HUB_OPERATIONS_CSS = `
.hops { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.hops__frame { width: 100%; height: calc(100vh - 150px); min-height: 480px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius, 10px); background: var(--ax-bg); }
.hops__foot { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
@media (max-width: 760px) { .hops__frame { height: calc(100vh - 190px); border-radius: 0; border-left: 0; border-right: 0; } }
`

/** Client: load the frame on first open and keep its theme with the Hub's. */
export const HUB_OPERATIONS_SCRIPT = `
  function opsShow(on) {
    var f = document.getElementById('wall-ops-frame');
    if (!f) return;
    if (on && !f.getAttribute('src')) f.setAttribute('src', f.getAttribute('data-src'));
  }
  (function () {
    var f = document.getElementById('wall-ops-frame');
    if (!f || !window.MutationObserver) return;
    function sync() {
      try { var d = f.contentDocument; if (d && d.documentElement) d.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'light'); } catch (e) { /* not loaded yet */ }
    }
    f.addEventListener('load', sync);
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  })();
`
