// --- Wall page (#1180) ---
//
// The Wall is the main dashboard view: each open request is a post, and the
// plan steps, runs and hand-offs recorded against it are its comments.
// Read-only over records the daemon already keeps (requests, plan events,
// task traces, the live fleet snapshot). Nothing here writes or notifies.
//
// The HTML is a skeleton; WALL_PAGE_SCRIPT paints it from /api/admin/wall.

import { renderShell, type TopbarPeer } from ".."

export interface WallPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderWallPage(opts: WallPageOpts = {}): string {
  const body = `<div class="ax-wall">
  <section id="wall-nodes" class="ax-wall__nodes" aria-label="Running now"></section>
  <section id="wall-feed" class="ax-wall__feed" aria-label="Posts"><p class="ax-wall__empty">Loading…</p></section>
</div>`

  return renderShell({
    title: "AgentX · Wall",
    activeTab: "wall",
    subtitle: "Wall",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: WALL_PAGE_CSS,
    scripts: `<script>${WALL_PAGE_SCRIPT}</script>`,
  })
}

const WALL_PAGE_CSS = `
.ax-wall { display: flex; flex-direction: column; gap: var(--ax-gap); }
.ax-wall__empty { color: var(--ax-muted); }
`

const WALL_PAGE_SCRIPT = `
(function () {
  // Painted in the next commits from /api/admin/wall.
})();
`
