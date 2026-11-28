// --- The simple shell's side menu, as data (#2226 S3) ---
//
// What the React shell (pages/ShellPage.tsx) lists in its side menu for a
// layout view (layout.ts): the default items first, as #2226 lists them,
// then each hidden item that is switched on, then Settings. Plain data and
// pure functions, so the tests check every layout without a browser.
//
// The items open today's Hub pages by their hash (the old Hub draws them);
// later steps move them into React one by one. Tasks (S4, tasks.ts),
// Automations and Waiting on you (S5, automations.ts, waiting.ts) and
// Projects (#2454, projects.ts) open in the shell's centre.

import type { HubBoot } from "./boot"
import { resolveHubLayout, type HubLayoutView, type HubShowItem } from "./layout"
import { settingsHash } from "./settings/address"
import { PAGE_ICONS } from "./settings/menu-model"
import type { Menu, MenuCatalog, MenuCatalogPage } from "../daemon/hub-menu"

/** The React page id of the shell (pages.ts). */
export const SHELL_PAGE = "home"

export interface ShellNavItem {
  id: string
  label: string
  /** A lucide icon name (ui/icons.tsx). */
  icon: string
  /** A hash on /hub, or a path; none for Search (it opens ⌘K). */
  href?: string
  /** A group header of the saved menu (#2149): a label, not a link. */
  group?: boolean
  /** A link the owner added (an outside site): opens in a new tab. */
  external?: boolean
}

/** The side menu's default items (#2226: "Left sidebar, default items").
 *  Agents is a heading here: the shell lists the agents under it. */
export const SHELL_MAIN: readonly ShellNavItem[] = [
  { id: "search", label: "Search", icon: "search" },
  { id: "tasks", label: "Tasks", icon: "list-todo", href: "#page=home&pane=tasks" },
  { id: "automations", label: "Automations", icon: "clock", href: "#page=home&pane=automations" },
  { id: "agents", label: "Agents", icon: "bot", href: "#page=agents" },
  { id: "projects", label: "Projects", icon: "folder", href: "#page=home&pane=projects" },
  { id: "needs", label: "Waiting on you", icon: "inbox", href: "#page=home&pane=waiting" },
]

/** The items the simple layout hides that are a place to go, in Settings
 *  order. Rules has no page yet, and Settings › Layout shows no switch for
 *  it until it has one (noPlace in layout.ts, #2313 E6); gates and hosts are parts of a post and of
 *  the status bar, not menu items, so the shell has nothing to show for them. */
export const SHELL_MORE: Readonly<Partial<Record<HubShowItem, ShellNavItem>>> = {
  mobile: { id: "mobile", label: "Mobile app", icon: "smartphone", href: "#page=home&pane=mobile" },
  workflows: { id: "workflows", label: "Workflows", icon: "workflow", href: "#page=home&pane=workflows" },
  wiki: { id: "wiki", label: "Wiki", icon: "book-open", href: "/admin/wiki/" },
  activity: { id: "activity", label: "Activity", icon: "activity", href: "#page=home&pane=activity" },
  org: { id: "org", label: "Org", icon: "network", href: "#page=org" },
  sessions: { id: "sessions", label: "Sessions", icon: "radio", href: "#page=live" },
  usage: { id: "usage", label: "Usage", icon: "gauge", href: "#view=cost" },
}

/** The pages the agents list now shows (#2101 R1: one live list): what is
 *  running (Running now), the live sessions (Sessions, the old Live) and
 *  every run (Activity). They are not drawn in the menu, saved or not; ⌘K
 *  still finds them. */
export const IN_AGENT_LIST: ReadonlySet<string> = new Set(["running", "sessions", "activity"])

/** Settings opens the new React Settings (#2101 ST1–ST5), not the old page:
 *  settingsHash() follows SETTINGS_PAGE, so ST4's rename needs no edit here. */
export const SHELL_SETTINGS: ShellNavItem = { id: "settings", label: "Settings", icon: "settings", href: settingsHash() }

export interface ShellNav {
  main: ShellNavItem[]
  /** The hidden items switched on, under "More". Empty in the simple layout. */
  more: ShellNavItem[]
  /** Pages the saved menu leaves out: not drawn, found by search (⌘K) only,
   *  so a page taken out of the menu is never out of reach (#2149). */
  hidden: ShellNavItem[]
  /** Settings, for the owner only. */
  foot: ShellNavItem[]
}

/** The side menu for this view and viewer. Once the owner has saved the
 *  Hub's menu (Settings › Menu, #2149), the menu follows it (menuNav);
 *  until then it is the default list below, as before. */
export function shellNav(view: HubLayoutView, opts: { owner: boolean; menu?: ShellMenu }): ShellNav {
  if (opts.menu?.saved) return menuNav(opts.menu, opts.owner, view)
  const more: ShellNavItem[] = []
  const hidden: ShellNavItem[] = []
  for (const [id, item] of Object.entries(SHELL_MORE) as [HubShowItem, ShellNavItem][]) {
    if (IN_AGENT_LIST.has(item.id)) hidden.push(item)
    else if (view.show[id]) more.push(item)
  }
  return { main: [...SHELL_MAIN], more, hidden, foot: opts.owner ? [SHELL_SETTINGS] : [] }
}

// --- The saved Hub menu (#2149 M2) ---
//
// The store (src/daemon/hub-menu.ts, GET /api/admin/wall/menu) keeps the
// menu as the old Hub's page keys (its catalog), saved views of the feed,
// links and group headers. The shell draws each page key as its own item
// where it has one (PAGE_SHELL), else as a link to the old Hub's page.

/** What the shell reads of GET /api/admin/wall/menu (settings/menu-model.ts MenuReply). */
export interface ShellMenu {
  menu: Pick<Menu, "items">
  /** False until the owner first saves: the menu is then the default list. */
  saved: boolean
  catalog: MenuCatalog
}

/** The catalog pages the shell has an item for: the Hub feed is Tasks (it
 *  lists the same requests), Schedules is Automations (the same reply),
 *  Live is Sessions, Cost is Usage. */
export const PAGE_SHELL: Readonly<Record<string, string>> = {
  wall: "tasks", jobs: "automations", needs: "needs", projects: "projects", agents: "agents",
  workflows: "workflows", activity: "activity", org: "org", live: "sessions", cost: "usage",
}

const SHELL_BY_ID = new Map<string, ShellNavItem>([...SHELL_MAIN, ...Object.values(SHELL_MORE) as ShellNavItem[]].map((i) => [i.id, i]))

/** A catalog page as a shell item: the shell's own one, else the old Hub's page. */
function pageItem(page: MenuCatalogPage): ShellNavItem | null {
  const own = PAGE_SHELL[page.key]
  if (own) return SHELL_BY_ID.get(own) ?? null
  if (!page.href) return null
  return { id: page.key, label: page.label, icon: PAGE_ICONS[page.key] ?? "circle", href: page.href }
}

/** A saved view opens the Hub feed with its filters (the old Hub's hash). */
export function viewHref(filter: Record<string, string>): string {
  return "#" + new URLSearchParams({ view: "feed", ...filter }).toString()
}

/** The side menu from the saved menu: Search and the agents first (the
 *  shell's frame, never in the store), then the items in the owner's order,
 *  with group headers; the catalog pages left out go to `hidden`. Links are
 *  the owner's: another viewer never gets them. The items switched on in
 *  Settings › Layout that the menu has no page for (Wiki, Mobile app) stay
 *  under More, as before the save, so turning them on still reaches them. */
export function menuNav(m: ShellMenu, owner: boolean, view?: HubLayoutView): ShellNav {
  const pages = new Map(m.catalog.flatMap((g) => g.items.map((p) => [p.key, p] as const)))
  const main: ShellNavItem[] = [SHELL_BY_ID.get("search")!, SHELL_BY_ID.get("agents")!]
  const shown = new Set<string>(["search", "agents"])
  for (const it of m.menu.items) {
    if (it.kind === "group") { main.push({ id: it.id, label: it.label, icon: "", group: true }); continue }
    if (it.kind === "link") { if (owner) main.push({ id: it.id, label: it.label, icon: it.icon || "link", href: it.url, external: true }); continue }
    if (it.kind === "view") { main.push({ id: it.id, label: it.label, icon: it.icon || "bookmark", href: viewHref(it.filter) }); continue }
    const page = pages.get(it.page)
    const item = page && pageItem(page)
    if (!item || shown.has(item.id) || IN_AGENT_LIST.has(item.id)) continue
    shown.add(item.id)
    main.push({ ...item, label: it.label || item.label, icon: it.icon || item.icon })
  }
  const hidden: ShellNavItem[] = []
  for (const page of pages.values()) {
    const item = pageItem(page)
    if (item && !shown.has(item.id)) { shown.add(item.id); hidden.push(item) }
  }
  // A group header with nothing under it is not drawn.
  const kept = main.filter((i, n) => !i.group || (n + 1 < main.length && !main[n + 1].group))
  const more: ShellNavItem[] = []
  for (const [id, item] of Object.entries(SHELL_MORE) as [HubShowItem, ShellNavItem][]) {
    if (view?.show[id] && !shown.has(item.id) && !IN_AGENT_LIST.has(item.id)) more.push(item)
  }
  return { main: kept, more, hidden, foot: owner ? [SHELL_SETTINGS] : [] }
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
