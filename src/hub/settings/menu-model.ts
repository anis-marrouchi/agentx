// --- Settings › Menu: the #2149 menu as the pane reads it (#2101 ST5) ---
//
// The model is the daemon's (src/daemon/hub-menu.ts, #2149 M1), imported
// as types only, so the store stays the one source: GET /api/admin/wall/menu
// gives the menu with its revision, the catalog of built-in pages, the
// presets and the limits; a change POSTs the whole list back with the
// revision it read. These are the pure steps the pane takes on that list,
// kept here so the test runs them without a browser.
import type { Pin } from "../../daemon/app-pins"
import type { Menu, MenuCatalog, MenuItem, MenuPresetId } from "../../daemon/hub-menu"

export type { Menu, MenuItem, MenuPresetId }

export const MENU_API = "/api/admin/wall/menu"

export interface MenuReply {
  menu: Menu
  /** False until the menu is first saved: it is the "everything" preset. */
  saved: boolean
  /** The file could not be read whole; every change is refused. */
  damaged: boolean
  catalog: MenuCatalog
  presets: Array<{ id: MenuPresetId; label: string }>
  /** Links set in agentx.json (app.pins.pages): shown first, read only. */
  fixedLinks: Pin[]
  limits: { items: number; bar: number; links: number }
}

/** The list a save sends: the store checks it again. */
export interface MenuDraft { items: MenuItem[]; bar: string[] }

/** The catalog keys the old Hub draws with its own icons; the Settings pane
 *  draws the lucide icon of the same meaning (orca-design C9). */
export const PAGE_ICONS: Record<string, string> = {
  wall: "layout-list", needs: "bell-dot", jobledger: "list-checks", live: "radio", running: "activity", projects: "folder",
  activity: "history", numbers: "chart-line", jobs: "clock", workflows: "workflow", reviews: "message-square", events: "megaphone",
  failures: "triangle-alert", agents: "bot", people: "users", org: "network", operations: "layout-dashboard", cost: "circle-dollar-sign",
}

/** Icons a saved view or a link may take (lucide names the kit has). */
export const ICON_CHOICES = ["bookmark", "link", "folder", "star", "briefcase", "globe", "users", "zap"] as const

/** The Wall's status filter, as a saved view keeps it. */
export const VIEW_STATUS = [
  { id: "open", label: "Open" }, { id: "closed", label: "Closed" }, { id: "blocked", label: "Blocked" }, { id: "", label: "Any" },
] as const

/** A new item's id, in the store's shape (hub-menu.ts): links are pins. */
export function newItemId(kind: MenuItem["kind"]): string {
  const b = new Uint8Array(6)
  globalThis.crypto.getRandomValues(b)
  return (kind === "link" ? "pin_" : "m_") + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
}

export type PageNames = Map<string, string>

export function pageNames(catalog: MenuCatalog): PageNames {
  return new Map(catalog.flatMap((g) => g.items.map((i) => [i.key, i.label] as const)))
}

export function itemLabel(it: MenuItem, names: PageNames): string {
  if (it.kind === "page") return it.label || names.get(it.page) || it.page
  return it.label
}

export function itemIcon(it: MenuItem): string {
  if (it.kind === "group") return ""
  if (it.icon) return it.icon
  if (it.kind === "page") return PAGE_ICONS[it.page] || "file"
  return it.kind === "link" ? "link" : "bookmark"
}

/** "project: site · status: open": a saved view's filters, in words. */
export function filterText(filter: Record<string, string>): string {
  return Object.entries(filter).filter(([k]) => k !== "view").map(([k, v]) => `${k}: ${v}`).join(" · ")
}

/** The line under an item's name. */
export function itemMeta(it: MenuItem, names: PageNames): string {
  switch (it.kind) {
    case "group": return "Group"
    case "page": return it.label && it.label !== names.get(it.page) ? `Page · was ${names.get(it.page) ?? it.page}` : "Page"
    case "view": return ["Saved view", names.get(it.page) ?? it.page, filterText(it.filter)].filter(Boolean).join(" · ")
    case "link": return "Link · " + it.url.replace(/^https:\/\//, "").replace(/\/$/, "")
  }
}

/** The phone bar as the phone draws it: the ids saved, or while none are,
 *  the first pages and views (hub-menu.ts, Menu.bar). */
export function barIds(menu: Pick<Menu, "items" | "bar">, max: number): string[] {
  if (menu.bar.length) return menu.bar
  return menu.items.filter((i) => i.kind === "page" || i.kind === "view").slice(0, max).map((i) => i.id)
}

/** In the phone bar or out of it. Once one is chosen the bar is saved as a
 *  list, so the first-four default does not shift under the owner. Null when
 *  the bar is full. */
export function toggleBar(menu: Pick<Menu, "items" | "bar">, id: string, max: number): string[] | null {
  const now = barIds(menu, max)
  if (now.includes(id)) return now.filter((b) => b !== id)
  if (now.length >= max) return null
  return [...now, id]
}

/** The built-in pages not in the menu: they are in More. */
export function inMore(items: MenuItem[], catalog: MenuCatalog): string[] {
  const shown = new Set(items.flatMap((i) => (i.kind === "page" ? [i.page] : [])))
  return catalog.flatMap((g) => g.items.map((i) => i.key)).filter((k) => k !== "settings" && !shown.has(k))
}

/** Is the item under a group header? (It is drawn indented.) */
export function inGroup(items: MenuItem[], index: number): boolean {
  return items[index]?.kind !== "group" && items.slice(0, index).some((i) => i.kind === "group")
}

/** The list with one item moved to `to` (clamped). Same list when it does
 *  not move, so the caller saves nothing. */
export function moveItem(items: MenuItem[], id: string, to: number): MenuItem[] {
  const from = items.findIndex((i) => i.id === id)
  const end = Math.max(0, Math.min(items.length - 1, to))
  if (from < 0 || from === end) return items
  const out = items.filter((i) => i.id !== id)
  out.splice(end, 0, items[from])
  return out
}

/** Where a page added from More goes: before the first link, so links stay
 *  at the end as the store keeps them. */
export function addAt(items: MenuItem[], it: MenuItem): MenuItem[] {
  const links = items.findIndex((i) => i.kind === "link")
  const at = it.kind === "link" || links < 0 ? items.length : links
  return [...items.slice(0, at), it, ...items.slice(at)]
}

/** The list without an item, and the bar without it. */
export function removeItem(draft: MenuDraft, id: string): MenuDraft {
  return { items: draft.items.filter((i) => i.id !== id), bar: draft.bar.filter((b) => b !== id) }
}

/** A renamed item; a page given back its catalog name loses its label. */
export function renameItem(it: MenuItem, name: string, names: PageNames): MenuItem {
  const v = name.trim().replace(/\s+/g, " ")
  if (!v) return it
  if (it.kind === "page") {
    const { label: _old, ...rest } = it
    return v === names.get(it.page) ? rest : { ...rest, label: v }
  }
  return { ...it, label: v }
}
