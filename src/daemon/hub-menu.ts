import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { randomBytes } from "crypto"
import { z } from "zod"
import { LockBusyError, withLock } from "@/wiki/facts/ledger-file"
import { parsePinLabel, parsePinUrl, type Pin } from "./app-pins"

// --- The Hub's menu (#2149, M1) ---
//
// One menu per Hub, owned by the owner: which pages show in the Hub's nav
// and in what order, renamed pages, saved Wall views, links (the phone's
// pinned pages) and the phone's bottom bar. It lives in `.agentx/menu.json`,
// private like the pins file; its links and labels are never logged.
//
// The built-in pages stay a catalog (WALL_NAV_GROUPS, passed in): the menu
// names a page by its key only, and a key a later version drops is skipped
// on read. Nothing is ever removed from reach: a page left out of the menu
// is in More, and Settings is never a menu item.
//
// Until the menu is first saved there is no file: the menu is the
// "everything" preset (today's nav) plus one link per pin, so no install
// changes until its owner chooses. The first save moves the pins in; from
// then on the pins are the menu's link items (PinStore reads them there).

export const DEFAULT_MENU_FILE = ".agentx/menu.json"
export const MENU_ITEMS_MAX = 40
export const MENU_BAR_MAX = 4
export const MENU_VERSION = 1

/** The Wall's filter keys (wall.client.ts FILTERS) plus its view: the only
 *  keys a saved view may carry. */
export const MENU_VIEW_KEYS = ["view", "owner", "asker", "load", "status", "idle", "project", "goal", "node", "group", "by", "grp", "time", "conc", "qa", "q"] as const

/** One built-in page, as the catalog gives it. */
export interface MenuCatalogPage {
  key: string
  label: string
  icon?: string
  /** Where the old Hub opens it (a hash on /hub): the React shell links
   *  pages it has no item of its own for (#2149 M2). */
  href?: string
}
export type MenuCatalog = Array<{ label: string; items: MenuCatalogPage[] }>

export type MenuItem =
  | { id: string; kind: "group"; label: string }
  | { id: string; kind: "page"; page: string; label?: string; icon?: string }
  | { id: string; kind: "view"; page: "wall"; label: string; icon?: string; filter: Record<string, string> }
  | { id: string; kind: "link"; label: string; url: string; icon?: string; createdAt?: string }

export interface Menu {
  version: number
  /** Goes up by one on every save; a save that names an older one is
   *  refused (409), so two open Settings pages can't overwrite each other. */
  revision: number
  preset: MenuPresetId
  items: MenuItem[]
  /** The phone's bottom bar: up to four page or view item ids. Empty means
   *  the first four page or view items. */
  bar: string[]
  /** Item id → the day (YYYY-MM-DD) it was last opened. For suggestions. */
  lastUsed: Record<string, string>
}

// --- Presets ---

export const MENU_PRESETS = {
  solo: { label: "Solo builder", pages: ["wall", "needs", "projects", "running", "live", "agents"] },
  team: { label: "Team / agency", pages: ["wall", "needs", "projects", "running", "live", "agents", "jobledger", "workflows", "reviews", "people", "org"] },
  automation: { label: "Business automation", pages: ["needs", "running", "jobs", "workflows", "events", "failures", "numbers", "activity"] },
  everything: { label: "Everything", pages: [] as string[] },
  blank: { label: "Blank", pages: [] as string[] },
} as const
export type MenuPresetId = keyof typeof MENU_PRESETS
export const MENU_PRESET_IDS = Object.keys(MENU_PRESETS) as MenuPresetId[]

/** The pages the menu may name: every catalog page except Settings. */
export function catalogKeys(catalog: MenuCatalog): string[] {
  return catalog.flatMap((g) => g.items.map((i) => i.key)).filter((k) => k !== "settings")
}

function newId(prefix: "m" | "pin"): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`
}

/** The items a preset gives. "everything" is the catalog with its groups,
 *  in today's order; the others name pages only, kept if this version has
 *  them; "blank" is empty (every page in More). */
export function presetItems(preset: MenuPresetId, catalog: MenuCatalog): MenuItem[] {
  const keys = new Set(catalogKeys(catalog))
  if (preset === "everything") {
    const out: MenuItem[] = []
    for (const g of catalog) {
      const pages = g.items.filter((i) => keys.has(i.key))
      if (!pages.length) continue
      if (g.label) out.push({ id: newId("m"), kind: "group", label: g.label })
      for (const p of pages) out.push({ id: newId("m"), kind: "page", page: p.key })
    }
    return out
  }
  const pages: readonly string[] = MENU_PRESETS[preset].pages
  return pages.filter((k) => keys.has(k)).map((k) => ({ id: newId("m"), kind: "page" as const, page: k }))
}

// --- Validation ---

const ID = /^(m|pin)_[a-z0-9]{6,32}$/
const ICON = /^[a-z][a-z0-9-]{1,23}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

const label = z.string().transform((v, ctx) => {
  const p = parsePinLabel(v)
  if (!p.ok) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: p.error }); return z.NEVER }
  return p.value
})
const url = z.string().transform((v, ctx) => {
  const p = parsePinUrl(v)
  if (!p.ok) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: p.error }); return z.NEVER }
  return p.value
})
const id = z.string().regex(ID, "Not a menu item id.")
const icon = z.string().regex(ICON, "Not an icon name.").optional()
const filter = z.record(z.string().max(200)).refine(
  (f) => Object.keys(f).every((k) => (MENU_VIEW_KEYS as readonly string[]).includes(k)),
  "A saved view keeps only the Hub's own filters.",
)

const itemSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("group"), label }).strict(),
  z.object({ id, kind: z.literal("page"), page: z.string().min(1).max(40), label: label.optional(), icon }).strict(),
  z.object({ id, kind: z.literal("view"), page: z.literal("wall"), label, icon, filter }).strict(),
  z.object({ id, kind: z.literal("link"), label, url, icon, createdAt: z.string().max(40).optional() }).strict(),
])

const fileSchema = z.object({
  version: z.literal(MENU_VERSION),
  revision: z.number().int().min(0),
  preset: z.enum(MENU_PRESET_IDS as [MenuPresetId, ...MenuPresetId[]]),
  items: z.array(z.unknown()).max(MENU_ITEMS_MAX * 2),
  bar: z.array(z.string()).max(MENU_BAR_MAX * 2).default([]),
  lastUsed: z.record(z.string().regex(DAY)).default({}),
})

/** Checks a whole list of items and a bar against the catalog, as sent by
 *  Settings. An item without an id gets one. */
export function parseMenuInput(body: Record<string, unknown>, catalog: MenuCatalog, pinsMax: number):
  { ok: true; value: { items: MenuItem[]; bar: string[] } } | { ok: false; error: string } {
  if (!Array.isArray(body.items)) return { ok: false, error: "Send the menu's items as a list." }
  if (body.items.length > MENU_ITEMS_MAX) return { ok: false, error: `A menu holds at most ${MENU_ITEMS_MAX} items.` }
  const keys = new Set(catalogKeys(catalog))
  const items: MenuItem[] = []
  for (const raw of body.items) {
    const withId = raw && typeof raw === "object" && !(raw as any).id
      ? { ...(raw as object), id: newId((raw as any).kind === "link" ? "pin" : "m") } : raw
    const p = itemSchema.safeParse(withId)
    if (!p.success) return { ok: false, error: p.error.issues[0]?.message || "An item in the menu is not valid." }
    const it = p.data as MenuItem
    if (it.kind === "page" && !keys.has(it.page)) {
      return { ok: false, error: it.page === "settings" ? "Settings is always reached from the nav foot, not the menu." : `There is no page called ${it.page}.` }
    }
    if (items.some((o) => o.id === it.id)) return { ok: false, error: "Two menu items have the same id." }
    if (it.kind === "page" && items.some((o) => o.kind === "page" && o.page === it.page)) return { ok: false, error: "A page can be in the menu once." }
    if (it.kind === "link" && items.some((o) => o.kind === "link" && (o.url === it.url || o.label.toLowerCase() === it.label.toLowerCase()))) {
      return { ok: false, error: `You already have a link called ${it.label} or to that page.` }
    }
    items.push(it)
  }
  if (items.filter((i) => i.kind === "link").length > pinsMax) return { ok: false, error: `A menu holds at most ${pinsMax} links (app.pins.max).` }
  const bar = body.bar === undefined ? [] : body.bar
  if (!Array.isArray(bar) || bar.some((b) => typeof b !== "string")) return { ok: false, error: "Send the phone bar as a list of item ids." }
  if (bar.length > MENU_BAR_MAX) return { ok: false, error: `The phone bar holds at most ${MENU_BAR_MAX} items.` }
  if (new Set(bar).size !== bar.length) return { ok: false, error: "An item is in the phone bar twice." }
  for (const b of bar) {
    const it = items.find((i) => i.id === b)
    if (!it || (it.kind !== "page" && it.kind !== "view")) return { ok: false, error: "Only pages and saved views go in the phone bar." }
  }
  return { ok: true, value: { items, bar: bar as string[] } }
}

/** A read of a menu file: the items this version can show. Unknown pages,
 *  bad items and dangling bar ids are left out; `damaged` says some were. */
export function readMenuFile(text: string, catalog: MenuCatalog): { menu: Menu; damaged: boolean } | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const f = fileSchema.safeParse(raw)
  if (!f.success) return null
  const keys = new Set(catalogKeys(catalog))
  let damaged = false
  const items: MenuItem[] = []
  for (const r of f.data.items) {
    const p = itemSchema.safeParse(r)
    if (!p.success || items.some((o) => o.id === p.data.id)) { damaged = true; continue }
    // A page this version doesn't have: kept in the file, not shown.
    if (p.data.kind === "page" && !keys.has(p.data.page)) continue
    items.push(p.data as MenuItem)
  }
  const shown = new Set(items.filter((i) => i.kind === "page" || i.kind === "view").map((i) => i.id))
  const bar = f.data.bar.filter((b) => shown.has(b)).slice(0, MENU_BAR_MAX)
  return { menu: { ...f.data, items, bar, lastUsed: f.data.lastUsed }, damaged }
}

/** The link items of a menu file, as pins, for PinStore. Null when the
 *  file is missing; `damaged` when it can't be read whole. */
export function menuLinks(path: string): { pins: Pin[]; damaged: boolean } | null {
  let text: string
  try { text = readFileSync(path, "utf-8") } catch (e: any) {
    return e?.code === "ENOENT" ? null : { pins: [], damaged: true }
  }
  let raw: any
  try { raw = JSON.parse(text) } catch { return { pins: [], damaged: true } }
  const f = fileSchema.safeParse(raw)
  if (!f.success) return { pins: [], damaged: true }
  const pins: Pin[] = []
  let damaged = false
  for (const r of f.data.items) {
    const p = itemSchema.safeParse(r)
    if (!p.success) { damaged = true; continue }
    if (p.data.kind !== "link") continue
    pins.push({ id: p.data.id, label: p.data.label, url: p.data.url, ...(p.data.createdAt ? { createdAt: p.data.createdAt } : {}) })
  }
  return { pins, damaged }
}

/** Swaps the menu file's link items for `pins`, keeping every other item
 *  and the file's other fields as they are. Under the caller's lock. */
export function writeMenuLinks(path: string, pins: Pin[]): void {
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  const links = pins.map((p) => ({ id: p.id, kind: "link", label: p.label, url: p.url, ...(p.createdAt ? { createdAt: p.createdAt } : {}) }))
  // Links keep their place: new ones go at the end.
  const byId = new Map(links.map((l) => [l.id, l]))
  const kept = (raw.items as any[]).flatMap((i) => i?.kind === "link" ? (byId.has(i.id) ? [byId.get(i.id)!] : []) : [i])
  const seen = new Set(kept.filter((i) => i?.kind === "link").map((i) => i.id))
  const items = [...kept, ...links.filter((l) => !seen.has(l.id))]
  writeFile(path, { ...raw, revision: (raw.revision ?? 0) + 1, items })
}

export function menuFile(root: string, file = DEFAULT_MENU_FILE): string {
  return isAbsolute(file) ? file : resolve(root, file)
}

function writeFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

export type MenuChanged = { ok: true; menu: Menu } | { ok: false; status: 400 | 404 | 409; error: string }

/** The day, in UTC, for lastUsed. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The menu file. Every change runs under the file's lock, which PinStore
 * shares, so a pin added with `agentx app pin` while Settings saves can't
 * drop either change. A file that can't be read whole is shown as far as
 * it can be, and every change is refused until it is fixed by hand.
 */
export class MenuStore {
  constructor(
    private path: string,
    private catalog: MenuCatalog,
    /** The pins file as it is before the menu file exists (PinStore). */
    private pins: { ownPins(): Pin[]; ownDamaged(): boolean },
    private pinsMax: number,
    private now: () => number = Date.now,
  ) {}

  /** The menu, built from "everything" and the pins while no file exists. */
  read(): { menu: Menu; damaged: boolean; saved: boolean } {
    let text: string
    try { text = readFileSync(this.path, "utf-8") } catch (e: any) {
      if (e?.code === "ENOENT") return { menu: this.initial(), damaged: false, saved: false }
      return { menu: this.initial(), damaged: true, saved: true }
    }
    const r = readMenuFile(text, this.catalog)
    if (!r) return { menu: this.initial(), damaged: true, saved: true }
    return { ...r, saved: true }
  }

  private initial(): Menu {
    const links: MenuItem[] = this.pins.ownPins().map((p) => ({ id: p.id, kind: "link", label: p.label, url: p.url, ...(p.createdAt ? { createdAt: p.createdAt } : {}) }))
    return { version: MENU_VERSION, revision: 0, preset: "everything", items: [...presetItems("everything", this.catalog), ...links], bar: [], lastUsed: {} }
  }

  private locked(fn: () => MenuChanged): MenuChanged {
    try {
      return withLock(this.path, fn, { what: "The menu file" })
    } catch (e) {
      if (e instanceof LockBusyError) return { ok: false, status: 409, error: e.message }
      throw e
    }
  }

  /** The menu to change, or why it can't be changed now. */
  private editable(revision: unknown): { ok: true; menu: Menu; raw: any } | { ok: false; status: 409 | 400; error: string } {
    const r = this.read()
    if (r.damaged) return { ok: false, status: 409, error: `The menu file (${this.path}) can't be read. Fix or remove it on the computer, then try again.` }
    // The first save moves the pins in: not from a pins file it can't read
    // whole, or the pins it can't read would be left behind.
    if (!r.saved && this.pins.ownDamaged()) return { ok: false, status: 409, error: "The pinned pages file can't be read. Fix or remove it on the computer, then try again." }
    if (typeof revision !== "number") return { ok: false, status: 400, error: "Send the menu's revision with the change." }
    if (revision !== r.menu.revision) return { ok: false, status: 409, error: "The menu was changed somewhere else. Reload it and make the change again." }
    let raw: any = null
    if (r.saved) raw = JSON.parse(readFileSync(this.path, "utf-8"))
    return { ok: true, menu: r.menu, raw }
  }

  /** Pages the file names that this version doesn't show: kept on save, so
   *  going back to a newer version brings them back. */
  private hiddenPages(raw: any): unknown[] {
    if (!raw) return []
    const keys = new Set(catalogKeys(this.catalog))
    return (raw.items as unknown[]).filter((i: any) => i?.kind === "page" && typeof i.page === "string" && !keys.has(i.page) && i.page !== "settings")
  }

  private persist(menu: Menu, raw: any): Menu {
    const next = { ...menu, revision: menu.revision + 1 }
    writeFile(this.path, { ...next, items: [...next.items, ...this.hiddenPages(raw)] })
    return next
  }

  /** Saves the whole list (Settings → Menu). */
  save(body: Record<string, unknown>): MenuChanged {
    const input = parseMenuInput(body, this.catalog, this.pinsMax)
    if (!input.ok) return { ok: false, status: 400, error: input.error }
    return this.locked(() => {
      const e = this.editable(body.revision)
      if (!e.ok) return e
      // The first save moves the pins in. A pin added on the phone or with
      // `agentx app pin` after Settings read the menu is kept, at the end,
      // rather than lost.
      let items = input.value.items
      if (!e.raw) {
        const late = this.initial().items.filter((i) => i.kind === "link" && !items.some((o) => o.id === i.id))
        items = [...items, ...late]
      }
      const ids = new Set(items.map((i) => i.id))
      const lastUsed = Object.fromEntries(Object.entries(e.menu.lastUsed).filter(([k]) => ids.has(k)))
      return { ok: true, menu: this.persist({ ...e.menu, items, bar: input.value.bar, lastUsed }, e.raw) }
    })
  }

  /** Replaces the list with a preset's. Links are kept, at the end: they
   *  are the phone's pinned pages, and a reset must not lose them. */
  reset(body: Record<string, unknown>): MenuChanged {
    const preset = body.preset
    if (typeof preset !== "string" || !(MENU_PRESET_IDS as string[]).includes(preset)) {
      return { ok: false, status: 400, error: `Choose a preset: ${MENU_PRESET_IDS.join(", ")}.` }
    }
    return this.locked(() => {
      const e = this.editable(body.revision)
      if (!e.ok) return e
      const links = e.menu.items.filter((i) => i.kind === "link")
      const items = [...presetItems(preset as MenuPresetId, this.catalog), ...links]
      return { ok: true, menu: this.persist({ ...e.menu, preset: preset as MenuPresetId, items, bar: [], lastUsed: {} }, e.raw) }
    })
  }

  /** Notes that an item was opened today. At most one write per item per
   *  day; it doesn't change the revision, so an open Settings page can
   *  still save. Nothing is written while no menu was saved. */
  used(itemId: unknown): MenuChanged {
    if (typeof itemId !== "string" || !ID.test(itemId)) return { ok: false, status: 400, error: "Send the item's id." }
    return this.locked(() => {
      const r = this.read()
      if (!r.saved || r.damaged) return { ok: true, menu: r.menu }
      if (!r.menu.items.some((i) => i.id === itemId)) return { ok: false, status: 404, error: "No such menu item." }
      const today = day(this.now())
      if (r.menu.lastUsed[itemId] === today) return { ok: true, menu: r.menu }
      const raw = JSON.parse(readFileSync(this.path, "utf-8"))
      raw.lastUsed = { ...(raw.lastUsed || {}), [itemId]: today }
      writeFile(this.path, raw)
      return { ok: true, menu: { ...r.menu, lastUsed: raw.lastUsed } }
    })
  }
}

/** A menu item id, for callers that add items (tests, the move of pins). */
export const menuItemId = newId
