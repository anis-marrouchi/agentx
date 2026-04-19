// --- Page shell renderer ---
//
// Every dashboard page used to hand-roll its own <html><head><body> wrapper:
// meta tags, font links, theme bootstrap script, style tags, topbar markup,
// closing tags. That's ~60 lines of boilerplate per page, identical across
// ~8 pages. This module centralises it.
//
// A page calls `renderShell({ title, activeTab, subtitle, body, css, ... })`
// and gets back a complete HTML document with:
//   - Correct <meta>, <title>, Plex font link, theme-bootstrap script
//   - AX_TOKENS_CSS (design tokens) + AX_COMPONENTS_CSS (badge/stat/card/...)
//   - TOPBAR_CSS (chrome) always included
//   - Page-specific CSS appended after
//   - renderTopbar() at the top
//   - <main> with the page body
//   - TOPBAR_SCRIPT (theme toggle + mesh selector) at the end
//   - Page-specific <script> appended after
//
// Pages that want a slimmer header (e.g. /setup, which has its own simplified
// topbar) can pass `renderHeader: "custom"` and provide their own <header>.

import { AX_TOKENS_CSS } from "./tokens"
import { AX_COMPONENTS_CSS } from "./components.css"
import {
  TOPBAR_HEAD,
  TOPBAR_CSS,
  TOPBAR_SCRIPT,
  renderTopbar,
  type TopbarOpts,
  type TopbarPeer,
} from "../topbar"

export interface ShellOpts {
  /** Browser tab title — "AgentX · Live", "AgentX · Settings", etc. */
  title: string
  /**
   * The topbar tab to highlight, OR "custom" to skip rendering the default
   * topbar so the page can provide its own header.
   */
  activeTab: TopbarOpts["activeTab"] | "custom"
  /** Subtitle after the brand — "Live", "Settings", "Setup", "Intent Graph". */
  subtitle: string
  /** Page body HTML — everything inside <main>. */
  body: string
  /** Optional HTML inserted as a second row under the topbar. */
  subheader?: string
  /**
   * Page-specific CSS appended after the shared blocks. Use this for styles
   * that aren't worth promoting to components.css (e.g. kanban column
   * layout, graph tree indentation).
   */
  css?: string
  /** Page-specific <script> blocks (full tags, not raw JS). */
  scripts?: string
  /** Mesh peers to populate the selector. */
  peers?: TopbarPeer[]
  currentPeerId?: string
  /** If provided, replaces the default topbar entirely. */
  customHeader?: string
  /**
   * When true, omit the <main> wrapper — caller renders their own. Useful
   * for pages (e.g. boards kanban) that need a full-viewport layout without
   * the default padding.
   */
  noMain?: boolean
  /** Extra content to inject into <head> (rare — e.g. preload hints). */
  headExtras?: string
}

export function renderShell(opts: ShellOpts): string {
  const css = `${AX_TOKENS_CSS}\n${AX_COMPONENTS_CSS}\n${TOPBAR_CSS}${opts.css ? "\n" + opts.css : ""}`

  const header = opts.customHeader
    ?? (opts.activeTab === "custom"
      ? ""
      : renderTopbar({
          activeTab: opts.activeTab,
          subtitle: opts.subtitle,
          subheader: opts.subheader,
          peers: opts.peers,
          currentPeerId: opts.currentPeerId,
        }))

  const main = opts.noMain ? opts.body : `<main>${opts.body}</main>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(opts.title)}</title>
${TOPBAR_HEAD}
${opts.headExtras || ""}
<style>${css}</style>
</head>
<body>
${header}
${main}
${TOPBAR_SCRIPT}
${opts.scripts || ""}
</body>
</html>`
}

function escapeTitle(s: string): string {
  return String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))
}
