// --- The simple shell's side menu, as data (#2101, the approved orca mock) ---
//
// The React side menu (SideMenu.tsx) draws the same agent rows as the old
// Hub's side menu (#2388): GET /api/admin/hub/agents sends hubAgentRows'
// model, and the groups, their order, their words and the state icons come
// from hub-agents.ts itself, so the two menus cannot drift apart.
//
// Plain data and pure functions, so the tests check them without a browser.

import { haAskWords, haFace, haGroups, type HaModel, type HaOpen, type HaRow, type HaState } from "../../daemon/ui/pages/hub-agents"

import { shortAgo } from "../tasks"

export { haStateWord, type HaAsk, type HaModel, type HaOpen, type HaRow, type HaState } from "../../daemon/ui/pages/hub-agents"

/** The agent rows, grouped by state (board-dashboard.ts). */
export const HUB_AGENTS_URL = "/api/admin/hub/agents"

/** The rows asked for today: `dayStart` is the viewer's local midnight. */
export function hubAgentsUrl(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return HUB_AGENTS_URL + "?dayStart=" + d.getTime()
}

/** Each state's lucide icon (orca-design recipes §9, haStateIcon). */
export const STATE_ICON: Record<HaState, string> = {
  needs: "circle-alert", failed: "circle-x", working: "loader-circle", done: "circle-check", idle: "circle",
}

/** Rows a live group shows before "Show all (N)". */
export const MENU_CAP = 3

export interface MenuGroup {
  id: string
  label: string
  /** The key its fold is kept under (HaOpen). */
  fold: keyof HaOpen
  /** The key of its "Show all" / "Show fewer", or null when it has none
   *  (3 rows or fewer, a group that is never capped, or a search). */
  more: keyof HaOpen | null
  /** The rows drawn now (the first 3 while capped). */
  rows: HaRow[]
  /** Every row of the group that matches the search. */
  total: number
  open: boolean
  capped: boolean
}

const matches = (r: HaRow, needle: string) =>
  !needle || r.name.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle)

/** The groups to draw, in the order of hub-agents.ts haGroups (Needs you,
 *  Working, Done today, Not working today), empty ones left out. Needs you
 *  and Working start open, the others folded. While searching, every group
 *  with a match is open and shows every match, and the counts are the
 *  matches (orca-design principle 8: counts follow the filter). */
export function menuGroups(m: HaModel, open: HaOpen, needle = ""): MenuGroup[] {
  const q = needle.trim().toLowerCase()
  const out: MenuGroup[] = []
  for (const g of haGroups()) {
    const all = m.rows.filter((r) => g.states.includes(r.state) && matches(r, q))
    if (!all.length) continue
    const fold = g.fold as keyof HaOpen
    const more = (g.more || null) as keyof HaOpen | null
    const isOpen = q ? true : g.id === "needs" || g.id === "working" ? open[fold] !== false : !!open[fold]
    const capped = !q && !!more && !open[more] && all.length > MENU_CAP
    out.push({ id: g.id, label: g.label, fold, more: !q && all.length > MENU_CAP ? more : null, rows: capped ? all.slice(0, MENU_CAP) : all, total: all.length, open: isOpen, capped })
  }
  return out
}

/** Every row in menu order (the rail lists them all, unfolded). */
export function menuRows(m: HaModel): HaRow[] {
  return haGroups().flatMap((g) => m.rows.filter((r) => g.states.includes(r.state)))
}

/** The rows of the agents this Hub knows when the grouped rows cannot be
 *  read: each listed once, as not working today. */
export function idleModel(agents: { id: string; name: string }[]): HaModel {
  const rows: HaRow[] = agents.map((a) => ({
    id: a.id, name: a.name, node: "", nodeUrl: "", color: null, face: haFace(a.name || a.id), state: "idle",
    line: "", ageMs: -1, at: 0, unread: 0, taskId: "", runs: 0, today: 0,
  }))
  return { rows, counts: { all: 0, working: 0, needs: 0, failed: 0, done: 0, idle: rows.length } }
}

/** The machines that do not answer, said once above the list (haDownHtml). */
export function downWords(down: string[] | undefined): string {
  const d = down ?? []
  if (!d.length) return ""
  const who = d.length === 1 ? d[0] : d.slice(0, -1).join(", ") + " and " + d[d.length - 1]
  return who + (d.length === 1 ? " is" : " are") + " not answering, so " + (d.length === 1 ? "its" : "their") + " agents are not listed."
}

/** A row's second line: what it is doing, or its state in words. */
export function rowLine(r: HaRow, word: string): string {
  return r.line || (r.state === "idle" ? "Nothing going" : word)
}

/** Its numbers in words: runs going now and runs today, zeros left out. */
export function rowStats(r: HaRow): string {
  const going = r.runs || 0, today = r.today || 0
  return [going ? going + " running now" : "", today ? today + (today === 1 ? " run" : " runs") + " today" : ""].filter(Boolean).join(", ")
}

/** A Needs you row's words (#2505), as the old Hub's row says them
 *  (hub-agents.ts haAskWords): "4 for you" and "Waiting on you · asked 40m". */
export function askWords(r: HaRow): { count: string; since: string } {
  return haAskWords(r, (ms) => shortAgo(0, ms))
}

// --- The search box: ⌘K and Enter ---

/** What a key press asks of the shell: ⌘K / Ctrl K opens the search,
 *  ⌘B / Ctrl B folds the menu (as in the old Hub, hub-nav.client.ts). */
export function shellShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): "search" | "fold" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null
  const k = String(e.key || "").toLowerCase()
  return k === "k" ? "search" : k === "b" ? "fold" : null
}

/** What Enter in the search box opens: the first agent row drawn, else the
 *  first page link that matches. Null when nothing matches. */
export function firstHit(groups: MenuGroup[], links: { href?: string }[]): { agent: string } | { href: string } | null {
  const row = groups.find((g) => g.open && g.rows.length)?.rows[0]
  if (row) return { agent: row.id }
  const link = links.find((l) => l.href)
  return link?.href ? { href: link.href } : null
}

// --- Folds and the folded menu, kept in this browser ---

/** The old Hub's key (hub-nav.client.ts): both menus keep one fold state. */
export const MENU_FOLDS_KEY = "ax.hub.agentOpen"
export const MENU_RAIL_KEY = "agentx.hub.shell.rail"

type Store = Pick<Storage, "getItem" | "setItem">
const browserStore = (): Store | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage } catch { return null }
}

export function readMenuFolds(store: Store | null = browserStore()): HaOpen {
  try {
    const v = JSON.parse(store?.getItem(MENU_FOLDS_KEY) || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? v as HaOpen : {}
  } catch { return {} }
}

export function saveMenuFolds(open: HaOpen, store: Store | null = browserStore()): void {
  try { store?.setItem(MENU_FOLDS_KEY, JSON.stringify(open)) } catch { /* private mode: kept for this visit */ }
}

export function readMenuRail(store: Store | null = browserStore()): boolean {
  try { return store?.getItem(MENU_RAIL_KEY) === "1" } catch { return false }
}

export function saveMenuRail(rail: boolean, store: Store | null = browserStore()): void {
  try { store?.setItem(MENU_RAIL_KEY, rail ? "1" : "0") } catch { /* private mode */ }
}
