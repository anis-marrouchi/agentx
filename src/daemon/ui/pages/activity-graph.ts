import { renderShell, type TopbarPeer } from ".."

// --- /admin/activity-graph — Fleet Activity perspective view ---
//
// Thin shell that loads the React-based fleet view bundle from
// /assets/activity-graph.global.js. All interaction logic lives in
// src/web/activity-graph/ (see main.tsx). The dashboard's topbar
// renders via `renderShell`; the bundle mounts into #ax-fleet-root
// and consumes /api/admin/activity-graph + the SSE stream there.

export interface ActivityGraphPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderActivityGraphPage(opts: ActivityGraphPageOpts = {}): string {
  const body = `<div id="ax-fleet-root"></div>`

  return renderShell({
    title: "AgentX · Activity Graph",
    activeTab: "graph",
    subtitle: "Activity Graph",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: HOST_CSS,
    scripts: `<script src="/assets/activity-graph.global.js" defer></script>`,
    noMain: true,
  })
}

const HOST_CSS = `
html, body { height: 100%; }
body { margin: 0; }
#ax-fleet-root { height: calc(100vh - 48px); }
#ax-fleet-root:empty::before {
  content: "Loading fleet snapshot…";
  display: block;
  padding: 40px 24px;
  color: var(--ax-muted);
  font: 13px/1 -apple-system, BlinkMacSystemFont, sans-serif;
  text-align: center;
}
`
