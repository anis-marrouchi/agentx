import { afterAll, describe, expect, it } from "vitest"
import { createServer } from "http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PinStore, configPins } from "../src/daemon/app-pins"
import { MenuStore, parseMenuInput, presetItems, readMenuFile, type MenuCatalog, type MenuItem } from "../src/daemon/hub-menu"
import { handleHubMenu, type HubMenuDeps } from "../src/daemon/hub-menu-routes"
import { hubMenuCatalog } from "../src/daemon/ui/pages/wall"

const root = mkdtempSync(join(tmpdir(), "agentx-menu-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const catalog: MenuCatalog = hubMenuCatalog()

/** A fresh pins file and menu file, the way the daemon builds them. */
function setup(opts: { pins?: unknown; fixed?: { label: string; url: string }[]; max?: number } = {}) {
  const dir = join(root, `case-${n++}`)
  const pinsPath = join(dir, "app-pins.json")
  const menuPath = join(dir, "menu.json")
  if (opts.pins !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(pinsPath, typeof opts.pins === "string" ? opts.pins : JSON.stringify(opts.pins))
  }
  const pins = new PinStore(pinsPath, Date.now, configPins(opts.fixed ?? []), menuPath)
  const menu = new MenuStore(menuPath, catalog, pins, opts.max ?? 12, () => Date.parse("2026-11-26T10:00:00Z"))
  return { dir, pinsPath, menuPath, pins, menu }
}

const pages = (items: MenuItem[]) => items.flatMap((i) => i.kind === "page" ? [i.page] : [])
const PIN_A = { id: "pin_aaaaaa", label: "Grafana", url: "https://grafana.example/d/x", createdAt: "2026-11-01T00:00:00Z" }
const PIN_B = { id: "pin_bbbbbb", label: "Remote", url: "https://host.example.ts.net/r/key", createdAt: "2026-11-02T00:00:00Z" }

describe("the catalog and presets", () => {
  it("leaves Settings out of the catalog", () => {
    expect(catalog.flatMap((g) => g.items.map((i) => i.key))).not.toContain("settings")
  })
  it("builds Everything as today's nav, groups included", () => {
    const items = presetItems("everything", catalog)
    expect(pages(items)).toEqual(catalog.flatMap((g) => g.items.map((i) => i.key)))
    expect(items.filter((i) => i.kind === "group").map((i) => (i as any).label)).toEqual(["Work", "Automation", "Fleet"])
  })
  it("builds each preset from pages this version has", () => {
    expect(pages(presetItems("solo", catalog))).toEqual(["wall", "needs", "projects", "live", "agents"])
    expect(pages(presetItems("team", catalog))).toHaveLength(10)
    expect(pages(presetItems("automation", catalog))).toEqual(["needs", "live", "jobs", "workflows", "events", "failures", "numbers", "activity"])
    expect(presetItems("blank", catalog)).toEqual([])
    // A page a later version drops is skipped, never an error.
    const small: MenuCatalog = [{ label: "", items: [{ key: "wall", label: "Hub" }] }]
    expect(pages(presetItems("solo", small))).toEqual(["wall"])
  })
})

describe("parseMenuInput", () => {
  const ok = (items: unknown[], bar: unknown = []) => parseMenuInput({ items, bar }, catalog, 12)
  it("takes pages, renamed pages with icons, groups, views and links, and gives ids", () => {
    const r = ok([
      { kind: "group", label: "Work" },
      { kind: "page", page: "needs", label: "To decide", icon: "needs" },
      { kind: "view", page: "wall", label: "Client site", filter: { project: "site", status: "open" } },
      { kind: "link", label: "Grafana", url: "https://grafana.example" },
    ])
    if (!r.ok) throw new Error(r.error)
    expect(r.value.items.map((i) => i.id.split("_")[0])).toEqual(["m", "m", "m", "pin"])
    expect(r.value.items[1]).toMatchObject({ label: "To decide", icon: "needs" })
  })
  it("refuses Settings, unknown pages and a page twice", () => {
    expect(ok([{ kind: "page", page: "settings" }])).toMatchObject({ ok: false, error: expect.stringContaining("Settings") })
    expect(ok([{ kind: "page", page: "nope" }]).ok).toBe(false)
    expect(ok([{ kind: "page", page: "live" }, { kind: "page", page: "live" }]).ok).toBe(false)
  })
  it("refuses links that are not https or carry a user name, and a view with other keys", () => {
    for (const url of ["http://a.example", "javascript:alert(1)", "https://u:p@a.example"]) {
      expect(ok([{ kind: "link", label: "X", url }]).ok).toBe(false)
    }
    expect(ok([{ kind: "view", page: "wall", label: "V", filter: { evil: "1" } }]).ok).toBe(false)
    expect(ok([{ kind: "page", page: "live", label: "A‮B" }]).ok).toBe(false)
  })
  it("caps the items, the links and the phone bar, and keeps links out of it", () => {
    expect(ok(Array.from({ length: 41 }, (_, i) => ({ kind: "group", label: `G${i}` }))).ok).toBe(false)
    expect(parseMenuInput({ items: [{ kind: "link", label: "A", url: "https://a.example" }, { kind: "link", label: "B", url: "https://b.example" }] }, catalog, 1).ok).toBe(false)
    const five = ["wall", "needs", "live", "projects", "agents"].map((p, i) => ({ id: `m_00000${i}`, kind: "page", page: p }))
    expect(ok(five, five.map((i) => i.id)).ok).toBe(false)
    expect(ok(five, five.slice(0, 4).map((i) => i.id)).ok).toBe(true)
    expect(ok([{ id: "pin_cccccc", kind: "link", label: "L", url: "https://l.example" }], ["pin_cccccc"]).ok).toBe(false)
  })
})

describe("MenuStore", () => {
  it("shows Everything plus the pins while nothing is saved, and writes nothing", () => {
    const s = setup({ pins: { pins: [PIN_A, PIN_B] } })
    const r = s.menu.read()
    expect(r).toMatchObject({ saved: false, damaged: false, menu: { preset: "everything", revision: 0 } })
    expect(r.menu.items.filter((i) => i.kind === "link").map((i) => i.id)).toEqual([PIN_A.id, PIN_B.id])
    expect(existsSync(s.menuPath)).toBe(false)
  })

  it("saves with the revision it read and refuses an older one (409)", () => {
    const s = setup()
    const { menu } = s.menu.read()
    const first = s.menu.save({ revision: 0, items: menu.items.slice(0, 3), bar: [] })
    if (!first.ok) throw new Error(first.error)
    expect(first.menu.revision).toBe(1)
    expect(s.menu.save({ revision: 0, items: menu.items, bar: [] })).toMatchObject({ ok: false, status: 409 })
    expect(s.menu.save({ items: menu.items })).toMatchObject({ ok: false, status: 400 })
    expect(statSync(s.menuPath).mode & 0o777).toBe(0o600)
  })

  it("moves the pins in on the first save; `agentx app pins` lists the same before and after", () => {
    const s = setup({ pins: { pins: [PIN_A, PIN_B] } })
    const before = s.pins.list()
    const pinsText = readFileSync(s.pinsPath, "utf-8")
    const { menu } = s.menu.read()
    expect(s.menu.save({ revision: 0, items: menu.items, bar: [] }).ok).toBe(true)
    expect(s.pins.list()).toEqual(before)
    // The pins file is left on disk as it was.
    expect(readFileSync(s.pinsPath, "utf-8")).toBe(pinsText)
  })

  it("refuses the first save while the pins file is damaged, and writes nothing", () => {
    const s = setup({ pins: "{ not json" })
    const { menu } = s.menu.read()
    expect(s.menu.save({ revision: 0, items: menu.items, bar: [] })).toMatchObject({ ok: false, status: 409 })
    expect(existsSync(s.menuPath)).toBe(false)
  })

  it("keeps agentx.json pins out of the file and a shadowed file pin out of the menu", () => {
    const shadow = { ...PIN_B, id: "pin_cccccc", url: "https://grafana.example/d/x", label: "Dash" }
    const s = setup({ pins: { pins: [shadow, PIN_B] }, fixed: [{ label: "Grafana", url: "https://grafana.example/d/x" }] })
    const before = s.pins.list()
    expect(before.map((p) => p.label)).toEqual(["Grafana", "Remote"])
    const { menu } = s.menu.read()
    expect(menu.items.filter((i) => i.kind === "link").map((i) => i.id)).toEqual([PIN_B.id])
    expect(s.menu.save({ revision: 0, items: menu.items, bar: [] }).ok).toBe(true)
    expect(s.pins.list()).toEqual(before)
  })

  it("keeps a pin added with the CLI while Settings was open, and 409s once the menu is saved", () => {
    const s = setup({ pins: { pins: [PIN_A] } })
    const seen = s.menu.read().menu
    const added = s.pins.add({ label: "Late", url: "https://late.example" }, 12)
    if (!added.ok) throw new Error(added.error)
    const saved = s.menu.save({ revision: 0, items: seen.items, bar: [] })
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.menu.items.filter((i) => i.kind === "link").map((i) => (i as any).label)).toEqual(["Grafana", "Late"])

    const open = s.menu.read().menu
    expect(s.pins.add({ label: "Later", url: "https://later.example" }, 12).ok).toBe(true)
    expect(s.menu.save({ revision: open.revision, items: open.items, bar: [] })).toMatchObject({ ok: false, status: 409 })
  })

  it("lets PinStore add, rename and remove link items in place, leaving the rest", () => {
    const s = setup({ pins: { pins: [PIN_A, PIN_B] } })
    const { menu } = s.menu.read()
    const items = [{ id: "m_aaaaaa", kind: "page", page: "live" }, ...menu.items.filter((i) => i.kind === "link"), { id: "m_bbbbbb", kind: "page", page: "agents" }]
    expect(s.menu.save({ revision: 0, items, bar: ["m_aaaaaa"] }).ok).toBe(true)
    expect(s.pins.rename(PIN_A.id, "Graphs")).toMatchObject({ ok: true })
    expect(s.pins.remove(PIN_B.id)).toEqual({ ok: true })
    expect(s.pins.add({ label: "New", url: "https://new.example" }, 12).ok).toBe(true)
    const after = s.menu.read().menu
    expect(after.items.map((i) => i.kind === "page" ? i.page : (i as any).label)).toEqual(["live", "Graphs", "agents", "New"])
    expect(after.bar).toEqual(["m_aaaaaa"])
    expect(after.revision).toBe(4)
  })

  it("resets to a preset and keeps the links", () => {
    const s = setup({ pins: { pins: [PIN_A] } })
    const r = s.menu.reset({ revision: 0, preset: "solo" })
    if (!r.ok) throw new Error(r.error)
    expect(r.menu.preset).toBe("solo")
    expect(r.menu.items.map((i) => i.kind === "page" ? i.page : i.id)).toEqual(["wall", "needs", "projects", "live", "agents", PIN_A.id])
    expect(s.menu.reset({ revision: 1, preset: "nope" })).toMatchObject({ ok: false, status: 400 })
    expect(s.menu.reset({ revision: 1, preset: "blank" }).ok).toBe(true)
  })

  it("notes use once a day without changing the revision", () => {
    const s = setup()
    expect(s.menu.used("m_aaaaaa")).toMatchObject({ ok: true })
    expect(existsSync(s.menuPath)).toBe(false)
    const r = s.menu.reset({ revision: 0, preset: "solo" })
    if (!r.ok) throw new Error(r.error)
    const id = r.menu.items[0].id
    expect(s.menu.used(id)).toMatchObject({ ok: true, menu: { lastUsed: { [id]: "2026-11-26" }, revision: 1 } })
    const mtime = statSync(s.menuPath).mtimeMs
    expect(s.menu.used(id).ok).toBe(true)
    expect(statSync(s.menuPath).mtimeMs).toBe(mtime)
    expect(s.menu.used("m_zzzzzz")).toMatchObject({ ok: false, status: 404 })
  })

  it("keeps a page this version doesn't know in the file without showing it", () => {
    const s = setup()
    mkdirSync(s.dir, { recursive: true })
    writeFileSync(s.menuPath, JSON.stringify({ version: 1, revision: 3, preset: "solo", items: [
      { id: "m_aaaaaa", kind: "page", page: "live" }, { id: "m_future", kind: "page", page: "ideas" },
    ], bar: ["m_future", "m_aaaaaa"], lastUsed: {} }))
    const r = s.menu.read()
    expect(r).toMatchObject({ damaged: false, menu: { bar: ["m_aaaaaa"] } })
    expect(pages(r.menu.items)).toEqual(["live"])
    expect(s.menu.save({ revision: 3, items: r.menu.items, bar: [] }).ok).toBe(true)
    expect(JSON.parse(readFileSync(s.menuPath, "utf-8")).items.map((i: any) => i.page)).toEqual(["live", "ideas"])
  })

  it("refuses every change to a damaged menu file, the pins included", () => {
    const s = setup()
    mkdirSync(s.dir, { recursive: true })
    writeFileSync(s.menuPath, "{ oops")
    expect(s.menu.read()).toMatchObject({ damaged: true, saved: true })
    expect(s.menu.save({ revision: 0, items: [], bar: [] })).toMatchObject({ ok: false, status: 409 })
    expect(s.pins.add({ label: "X", url: "https://x.example" }, 12)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("menu file") })
    expect(readFileSync(s.menuPath, "utf-8")).toBe("{ oops")
  })

  it("reads a file with a bad item as damaged", () => {
    const r = readMenuFile(JSON.stringify({ version: 1, revision: 0, preset: "solo", items: [{ id: "m_aaaaaa", kind: "link", label: "x", url: "http://x" }] }), catalog)
    expect(r?.damaged).toBe(true)
  })
})

describe("the menu routes", () => {
  it("serves the menu and saves it", async () => {
    const s = setup({ pins: { pins: [PIN_A] } })
    const deps: HubMenuDeps = { store: s.menu, catalog, fixedLinks: [], pinsMax: 12 }
    const server = createServer((req, res) => { void handleHubMenu(req, res, req.url!, req.method!, deps) })
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
    const base = `http://127.0.0.1:${(server.address() as any).port}`
    try {
      const got = await (await fetch(`${base}/api/admin/wall/menu`)).json()
      expect(got).toMatchObject({ saved: false, menu: { revision: 0 }, limits: { bar: 4 } })
      expect(got.presets.map((p: any) => p.id)).toEqual(["solo", "team", "automation", "everything", "blank"])
      const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      expect((await post("/api/admin/wall/menu/reset", { revision: 0, preset: "team" })).status).toBe(200)
      expect((await post("/api/admin/wall/menu/reset", { revision: 0, preset: "team" })).status).toBe(409)
      expect((await post("/api/admin/wall/menu", { revision: 1, items: [{ kind: "page", page: "settings" }] })).status).toBe(400)
    } finally {
      server.close()
    }
  })
})
