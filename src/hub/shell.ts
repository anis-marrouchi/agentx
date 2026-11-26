// --- The simple shell's side menu, as data (#2226 S3) ---
//
// What the React shell (pages/ShellPage.tsx) lists in its side menu for a
// layout view (layout.ts): the default items first, as #2226 lists them,
// then each hidden item that is switched on, then Settings. Plain data and
// pure functions, so the tests check every layout without a browser.
//
// The items open today's Hub pages by their hash (the old Hub draws them);
// later steps move them into React one by one (S4: Tasks as List/Kanban).

import type { HubBoot } from "./boot"
import { resolveHubLayout, type HubLayoutView, type HubShowItem } from "./layout"

/** The React page id of the shell (pages.ts). */
export const SHELL_PAGE = "home"

export interface ShellNavItem {
  id: string
  label: string
  /** A lucide icon name (ui/icons.tsx). */
  icon: string
  /** A hash on /hub, or a path; none for Search (it opens ⌘K). */
  href?: string
}

/** The side menu's default items (#2226: "Left sidebar, default items").
 *  Agents is a heading here: the shell lists the agents under it. */
export const SHELL_MAIN: readonly ShellNavItem[] = [
  { id: "search", label: "Search", icon: "search" },
  { id: "tasks", label: "Tasks", icon: "list-todo", href: "#status=open&view=feed" },
  { id: "automations", label: "Automations", icon: "clock", href: "#view=jobs" },
  { id: "agents", label: "Agents", icon: "bot", href: "#page=agents" },
  { id: "projects", label: "Projects", icon: "folder", href: "#view=projects" },
  { id: "needs", label: "Waiting on you", icon: "inbox", href: "#status=open&view=decide" },
]

/** The items the simple layout hides that are a place to go, in Settings
 *  order. Rules has no page yet; gates and hosts are parts of a post and of
 *  the status bar, not menu items, so the shell has nothing to show for them. */
export const SHELL_MORE: Readonly<Partial<Record<HubShowItem, ShellNavItem>>> = {
  mobile: { id: "mobile", label: "Mobile app", icon: "smartphone", href: "#page=mobile" },
  workflows: { id: "workflows", label: "Workflows", icon: "workflow", href: "#page=workflows" },
  wiki: { id: "wiki", label: "Wiki", icon: "book-open", href: "/admin/wiki/" },
  activity: { id: "activity", label: "Activity", icon: "activity", href: "#page=activity" },
  org: { id: "org", label: "Org", icon: "network", href: "#page=org" },
  sessions: { id: "sessions", label: "Sessions", icon: "radio", href: "#page=live" },
  usage: { id: "usage", label: "Usage", icon: "gauge", href: "#view=cost" },
}

export const SHELL_SETTINGS: ShellNavItem = { id: "settings", label: "Settings", icon: "settings", href: "#page=settings" }

export interface ShellNav {
  main: ShellNavItem[]
  /** The hidden items switched on, under "More". Empty in the simple layout. */
  more: ShellNavItem[]
  /** Settings, for the owner only. */
  foot: ShellNavItem[]
}

/** The side menu for this view and viewer. */
export function shellNav(view: HubLayoutView, opts: { owner: boolean }): ShellNav {
  const more: ShellNavItem[] = []
  for (const [id, item] of Object.entries(SHELL_MORE) as [HubShowItem, ShellNavItem][]) {
    if (view.show[id]) more.push(item)
  }
  return { main: [...SHELL_MAIN], more, foot: opts.owner ? [SHELL_SETTINGS] : [] }
}

/** Where /hub opens: the shell, when the layout is simple, the viewer has
 *  it, and the address names nothing else (an empty hash). null: stay. */
export function shellLandingHash(hash: string, boot: Pick<HubBoot, "pages" | "layout">): string | null {
  if (hash.replace(/^#/, "") !== "") return null
  if (boot.layout.layout !== "simple" || !boot.pages.includes(SHELL_PAGE)) return null
  return "#page=" + SHELL_PAGE
}

/** The layout now: Settings › Layout writes the saved view to
 *  `window.AX_HUB_LAYOUT` (hub-layout.ts), so a switch turned on shows in the
 *  shell with no reload. Before any save, the view the page loaded with. */
export function currentLayout(boot: Pick<HubBoot, "layout">, w: { AX_HUB_LAYOUT?: unknown } = typeof window === "undefined" ? {} : window as { AX_HUB_LAYOUT?: unknown }): HubLayoutView {
  const live = w.AX_HUB_LAYOUT as { layout?: string; show?: Record<string, boolean> } | undefined
  if (!live || typeof live !== "object" || !live.show || typeof live.show !== "object") return boot.layout
  // Every item is set on a resolved view, so its show map reads as overrides.
  return resolveHubLayout({ layout: live.layout, show: live.show })
}
