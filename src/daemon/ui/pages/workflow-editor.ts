// --- Workflow visual editor — host page ---
//
// Thin shell that loads the React Flow-based editor bundle served from
// /assets/workflow-editor.js. All interaction logic lives in
// src/web/workflow-editor/ (see main.tsx). This page is deliberately
// minimal — just a root div the bundle mounts into, plus a reset stylesheet
// so the bundle's CSS-in-TS can take over without inheriting dashboard
// component styles we don't want on the canvas.

import { renderShell, type TopbarPeer } from ".."

export interface WorkflowEditorPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderWorkflowEditorPage(opts: WorkflowEditorPageOpts = {}): string {
  const body = `<div id="wfe-root" style="height:100%"></div>`

  return renderShell({
    title: "AgentX · Workflow editor",
    activeTab: "workflows",
    subtitle: "Workflow editor",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: HOST_CSS,
    // Bundle is served as an IIFE from /assets/workflow-editor.js — built
    // by `tsup --config tsup.web.config.ts` to dist/web/workflow-editor.js.
    // `defer` keeps the script out of the head-blocking path; the bundle
    // itself waits for DOMContentLoaded before mounting.
    scripts: `<script src="/assets/workflow-editor.global.js" defer></script>`,
    noMain: true,
  })
}

const HOST_CSS = `
/* Preload the fonts the redesign's CSS references. Placed in the shell so
 * they start fetching while the React bundle is still parsing. */
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif&display=swap");

html, body { height: 100%; }
body { margin: 0; overflow: hidden; }
/* The editor takes over the whole viewport except the dashboard topbar. The
 * topbar still renders via the shell so the Workflows tab highlights and
 * global nav works. */
.ax-topbar { position: relative; z-index: 50; }
#wfe-root { width: 100%; height: calc(100vh - 48px); }
/* Tiny fallback while the bundle loads — prevents an empty flash. */
#wfe-root:empty::before {
  content: "Loading editor…";
  display: block;
  padding: 40px 24px;
  color: #94a3b8;
  font: 13px/1 -apple-system, BlinkMacSystemFont, sans-serif;
  text-align: center;
}
`
