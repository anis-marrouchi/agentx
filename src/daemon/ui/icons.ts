// --- One icon set for the old-HTML pages (Hub review S2; orca-design P15, C9, C27) ---
//
// The SVGs live in one place, pages/hub-lucide.ts (lucide-static, ISC, one
// file per icon so the daemon bundle keeps only those listed there). This
// file draws them with the old-HTML pages' size argument and adds the one
// state set. Add a name in hub-lucide.ts before using it.
//
// icon(name) draws one inline: stroke currentColor, aria-hidden, size 16 by
// default and 14 in dense rows. The control around it carries the name.
//
// stateIcon(state) is the one state set of recipes.md §9: the same icon,
// word, colour and order on every page.
//
// A function shipped to the browser with injectFns cannot import: give it
// the SVG strings as a property instead (fn.svg = { ... }), which injectFns
// writes into the page with the function (inject.ts).

import { HUB_ICON_NAMES, hubIcon, type HubIconName } from "./pages/hub-lucide"

/** The icons the old-HTML pages may use. */
export type IconName = HubIconName
export const ICON_NAMES = HUB_ICON_NAMES

/** One lucide icon as an inline SVG string. `size` is 16 by default, 14 in dense rows. */
export function icon(name: IconName, size: 14 | 16 | number = 16, cls = ""): string {
  return hubIcon(name, cls, size)
}

/** The states of a task, run or agent, in the order lists group them (what needs the user first). */
export type State = "waiting-on-you" | "failed" | "running" | "live" | "waiting" | "not-started" | "paused" | "cancelled" | "done" | "idle"

/** recipes.md §9: icon, word, colour (a tone name, mapped to tokens by the page) and order.
 *  `live` is not in §9: a session streaming now, which sorts with Working. */
export const STATES: Record<State, { icon: IconName; word: string; tone: "warning" | "destructive" | "foreground" | "muted" | "success" | "faint"; order: number }> = {
  "waiting-on-you": { icon: "circle-alert", word: "Waiting on you", tone: "warning", order: 1 },
  "failed": { icon: "circle-x", word: "Failed", tone: "destructive", order: 2 },
  "running": { icon: "loader-circle", word: "Working", tone: "foreground", order: 3 },
  "live": { icon: "radio", word: "Live", tone: "foreground", order: 3 },
  "waiting": { icon: "clock", word: "Waiting", tone: "muted", order: 4 },
  "not-started": { icon: "circle-dashed", word: "Not started", tone: "muted", order: 5 },
  "paused": { icon: "pause", word: "Paused", tone: "muted", order: 6 },
  "cancelled": { icon: "ban", word: "Cancelled", tone: "muted", order: 7 },
  "done": { icon: "circle-check", word: "Done", tone: "success", order: 8 },
  "idle": { icon: "circle", word: "Idle", tone: "faint", order: 9 },
}

/** A state's icon. Running turns (`ax-ic-spin`, still under reduced motion: ICONS_CSS). The word goes beside it, visible or sr-only. */
export function stateIcon(state: State, size: 14 | 16 | number = 16): string {
  return icon(STATES[state].icon, size, state === "running" ? "ax-ic ax-ic-spin" : "ax-ic")
}

/** The turning spinner, still when the reader asks for reduced motion (C27). In AX_COMPONENTS_CSS. */
export const ICONS_CSS = `
.ax-ic { flex: none; vertical-align: -0.125em; }
.ax-ic-spin { animation: ax-ic-spin 1s linear infinite; }
@keyframes ax-ic-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ax-ic-spin { animation: none; } }
`
