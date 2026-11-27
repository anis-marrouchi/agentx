// The Hub's simple and full layouts (#2226 S1): the keys, their defaults,
// the hide logic of the current Hub, and Settings › Layout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { handleAdminApi } from "../src/daemon/admin-panel"
import { dashboardConfigSchema } from "../src/boards/config"
import {
  HUB_SHOW_IDS, applyHubLayoutPatch, freshHubSetting, hubHiddenItems, hubLayoutSetting, parseHubLayoutPatch, resolveHubLayout,
} from "../src/hub/layout"
import { HUB_LAYOUT_CSS, HUB_NAV_ITEM, hubHideSelectors, hubLayoutBoot } from "../src/daemon/ui/pages/hub-layout"
import { hubReactHead } from "../src/daemon/ui/hub-react"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { wallSettingsTarget } from "../src/daemon/wall-actions"
import { STATE, openWall, settingsHtml } from "./wall-settings-harness"

const ALL = ["mobile", "workflows", "wiki", "rules", "gates", "hosts", "activity", "org", "sessions", "usage"]

describe("the keys and their defaults", () => {
  it("lists every item Hakim named, each with its own switch", () => {
    expect([...HUB_SHOW_IDS]).toEqual(ALL)
  })
  it("a Hub with no layout key (from before #2313, or upgraded since) opens full: nothing hidden (#2466)", () => {
    for (const setting of [undefined, null, {}, { react: true }, dashboardConfigSchema.parse({}).hub]) {
      const v = resolveHubLayout(setting as any)
      expect(v.layout).toBe("full")
      expect(hubHiddenItems(v)).toEqual([])
      expect(v.overrides).toEqual([])
    }
  })
  it("a fresh install's setting opens simple: every item hidden (#2466)", () => {
    expect(freshHubSetting()).toEqual({ layout: "simple" })
    const v = resolveHubLayout(dashboardConfigSchema.parse({ hub: freshHubSetting() }).hub)
    expect(v.layout).toBe("simple")
    expect(hubHiddenItems(v)).toEqual(ALL)
  })
  it("a layout the owner chose is kept, simple or full (#2466)", () => {
    for (const layout of ["simple", "full"] as const) {
      const cfg: any = { dashboard: { hub: {} } }
      applyHubLayoutPatch(cfg, parseHubLayoutPatch({ layout }))
      expect(resolveHubLayout(cfg.dashboard.hub).layout).toBe(layout)
      expect(resolveHubLayout(dashboardConfigSchema.parse(cfg.dashboard).hub).layout).toBe(layout)
    }
  })
  it("full shows every item; an item's own switch wins over the layout", () => {
    expect(hubHiddenItems(resolveHubLayout({ layout: "full" }))).toEqual([])
    const v = resolveHubLayout({ layout: "full", show: { workflows: false } })
    expect(hubHiddenItems(v)).toEqual(["workflows"])
    expect(v.overrides).toEqual(["workflows"])
    const s = resolveHubLayout({ layout: "simple", show: { gates: true, mobile: true } })
    expect(s.show.gates).toBe(true)
    expect(hubHiddenItems(s)).not.toContain("mobile")
  })
  it("an unknown layout falls back to full", () => {
    expect(resolveHubLayout({ layout: "fancy" }).layout).toBe("full")
  })
  it("hubLayoutSetting gives the same view back", () => {
    const v = resolveHubLayout({ layout: "full", show: { org: false } })
    expect(hubLayoutSetting(v)).toEqual({ layout: "full", show: { org: false } })
    expect(resolveHubLayout(hubLayoutSetting(v))).toEqual(v)
  })
})

describe("schema", () => {
  it("defaults dashboard.hub to the full layout, no item switches (#2466)", () => {
    expect(dashboardConfigSchema.parse({}).hub).toMatchObject({ layout: "full", show: {} })
  })
  it("takes full and item switches, refuses a bad layout or an unknown item", () => {
    expect(dashboardConfigSchema.parse({ hub: { layout: "full", show: { wiki: true } } }).hub).toMatchObject({ layout: "full", show: { wiki: true } })
    expect(() => dashboardConfigSchema.parse({ hub: { layout: "fancy" } })).toThrow()
    expect(() => dashboardConfigSchema.parse({ hub: { show: { wikki: true } } })).toThrow()
    expect(() => dashboardConfigSchema.parse({ hub: { show: { wiki: "yes" } } })).toThrow()
  })
})

describe("the Settings write", () => {
  it("is a Settings route under the owner guard", () => {
    expect(wallSettingsTarget("POST", "/api/admin/wall/settings/hub-layout")).toBe("/api/admin/hub-layout")
    expect(wallSettingsTarget("DELETE", "/api/admin/wall/settings/hub-layout")).toBeNull()
  })
  it("refuses a bad body with a plain reason", () => {
    expect(() => parseHubLayoutPatch(null)).toThrow(/nothing to change/)
    expect(() => parseHubLayoutPatch({})).toThrow(/send layout or show/)
    expect(() => parseHubLayoutPatch({ layout: "big" })).toThrow(/"simple" or "full"/)
    expect(() => parseHubLayoutPatch({ show: { nope: true } })).toThrow(/not a Hub item/)
    expect(() => parseHubLayoutPatch({ show: { wiki: 1 } })).toThrow(/true, false or null/)
  })
  it("a layout clears the item switches; an item switch is kept; null gives it back to the layout", () => {
    const cfg: any = { agents: {}, dashboard: { daemonUrl: "x", hub: { react: true, show: { org: true } } } }
    expect(applyHubLayoutPatch(cfg, parseHubLayoutPatch({ layout: "full" }))).toBe("Hub layout: full")
    expect(cfg.dashboard.hub).toEqual({ react: true, layout: "full" })
    applyHubLayoutPatch(cfg, parseHubLayoutPatch({ show: { workflows: false } }))
    expect(cfg.dashboard.hub.show).toEqual({ workflows: false })
    expect(applyHubLayoutPatch(cfg, parseHubLayoutPatch({ show: { workflows: null } }))).toBe("workflows: as the layout")
    expect(cfg.dashboard.hub).toEqual({ react: true, layout: "full" })
    // Other dashboard keys stay; a config with no dashboard gets one.
    expect(cfg.dashboard.daemonUrl).toBe("x")
    const bare: any = {}
    applyHubLayoutPatch(bare, { show: { mobile: true } })
    expect(bare).toEqual({ dashboard: { hub: { show: { mobile: true } } } })
    expect(dashboardConfigSchema.parse(bare.dashboard).hub.show).toEqual({ mobile: true })
  })
})

describe("hide, never disable: the current Hub", () => {
  it("each item hides its nav entries; gates and hosts hide their parts, the Desk is untouched", () => {
    expect(hubHideSelectors("workflows")).toEqual(['[data-nav="workflows"]', '[data-nav="dash-workflows"]'])
    expect(hubHideSelectors("sessions")).toEqual(['[data-nav="live"]'])
    expect(hubHideSelectors("usage")).toEqual(['[data-nav="cost"]'])
    expect(hubHideSelectors("hosts")).toEqual(["#hs-node"])
    expect(hubHideSelectors("gates")).toEqual(['[data-hub-item="gates"]'])
    // No selector reaches Waiting on you (#wall-decide) or the needs nav.
    for (const id of HUB_SHOW_IDS) for (const s of hubHideSelectors(id)) expect(s).not.toMatch(/decide|needs/)
    expect(Object.values(HUB_NAV_ITEM).every((i) => (HUB_SHOW_IDS as readonly string[]).includes(i))).toBe(true)
  })
  it("simple mode keeps the owner's decision card on a post, so it can be answered there", () => {
    const simple = hubHiddenItems(resolveHubLayout({ layout: "simple" }))
    expect(simple).toContain("gates")
    // No hiding rule of any hidden item reaches the card (.wc, wall.client.ts cardHtml).
    const rules = HUB_LAYOUT_CSS.split("\n").filter((l) => simple.some((id) => l.includes(`data-hub-hide~="${id}"`)))
    expect(rules.length).toBeGreaterThan(0)
    for (const l of rules) expect(l).not.toMatch(/\.wc\b/)
    for (const id of simple) for (const s of hubHideSelectors(id)) expect(s).not.toMatch(/\.wc\b/)
  })
  it("hides with CSS on <html data-hub-hide>, so nothing leaves the page and nothing stops", () => {
    expect(HUB_LAYOUT_CSS).toContain('html[data-hub-hide~="workflows"] [data-nav="workflows"]')
    expect(HUB_LAYOUT_CSS).toContain('html[data-hub-hide~="hosts"] #hs-node')
    // Wiki and Rules have no place in this Hub yet: no rule, only their switch.
    expect(HUB_LAYOUT_CSS).not.toContain('"wiki"')
    const page = renderWallPage({ owner: true })
    expect(page).toContain('id="wall-workflows"')
    expect(page).toContain('data-nav="workflows" href="#page=workflows"')
    expect(page).toContain('href="#page=mobile"')
    expect(page).toContain('id="hs-node"')
  })
  it("the page boots full when no setting is given (#2466), and simple when asked", () => {
    const simple = renderWallPage({ owner: true, hub: { react: false, layout: resolveHubLayout({ layout: "simple" }) } })
    expect(simple).toContain(`document.documentElement.setAttribute("data-hub-hide", "${ALL.join(" ")}")`)
    const full = renderWallPage({ owner: true })
    expect(full).toContain(`setAttribute("data-hub-hide", "")`)
    expect(full).toContain('"layout":"full"')
    // Before the body, so a hidden item never flashes in.
    expect(simple.indexOf("data-hub-hide")).toBeLessThan(simple.indexOf("<body"))
  })
  it("the boot script cannot be closed by a value", () => {
    expect(hubLayoutBoot(resolveHubLayout())).not.toMatch(/<\/script>.*<\/script>/)
  })
  it("the React app gets the same keys in window.AX_HUB", () => {
    const manifest = { "main.tsx": { file: "hub.js", isEntry: true } }
    const html = hubReactHead({ owner: true, layout: resolveHubLayout({ layout: "full", show: { org: false } }) }, manifest)
    expect(html).toContain(`"layout":{"layout":"full","show":{"org":false}}`)
  })
})

describe("Settings › Layout", () => {
  const VIEW = resolveHubLayout({ layout: "simple", show: { gates: true } })
  const open = (reply?: unknown) => openWall({
    hash: "#page=settings&section=layout",
    route: (u, i) => u === "/api/admin/state" ? { status: 200, body: { ...STATE, hubLayout: VIEW } }
      : u === "/api/admin/wall/settings/hub-layout" && i?.method === "POST" ? { status: 200, body: reply ?? { summary: "ok", layout: resolveHubLayout({ layout: "full" }) } }
      : undefined,
  })

  it("lists the layout and every item's switch, as saved", async () => {
    const w = open()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<h2>Layout</h2>")
    expect(html).toContain('aria-checked="true" data-hl-layout="simple"')
    expect(html).toContain('aria-checked="false" data-hl-layout="full"')
    for (const id of ALL.filter((i) => i !== "rules")) expect(html).toContain(`role="switch" aria-checked="${id === "gates"}" data-hl-item="${id}"`)
    // Rules has no page in either Hub yet: no switch that does nothing (#2313 E6).
    expect(html).not.toContain('data-hl-item="rules"')
    // One group of rows with switches: no native checkboxes, no cards in a card.
    expect(html).not.toMatch(/type="(checkbox|radio)"/)
    expect(html).not.toContain("whl__opt")
    // Gates has its own switch set: it can go back to the layout's default.
    expect(html).toContain('data-st-act="hl-reset" data-hl-item="gates"')
    expect(html).toContain("Hidden items keep running")
    expect(w.writes()).toEqual([])
  })

  it("Full is one switch away, and applies at once with no reload", async () => {
    const w = open()
    await w.settle()
    await w.click({ "data-hl-layout": "full" })
    expect(w.writes().map((c) => [c.url, c.body])).toEqual([["/api/admin/wall/settings/hub-layout", { layout: "full" }]])
    expect(w.win.AX_HUB_LAYOUT.layout).toBe("full")
    expect(settingsHtml(w)).toContain('aria-checked="true" data-hl-layout="full"')
    expect(settingsHtml(w)).toContain('id="st-n-hl" role="status">Saved.</p>')
  })

  it("one item's switch saves that item only; As the layout clears it", async () => {
    const w = open({ summary: "ok", layout: resolveHubLayout({ show: { workflows: true } }) })
    await w.settle()
    await w.click({ "data-hl-item": "workflows" })
    expect(w.writes().at(-1)!.body).toEqual({ show: { workflows: true } })
    expect(w.win.AX_HUB_LAYOUT.show.workflows).toBe(true)
    await w.click({ "data-st-act": "hl-reset", "data-hl-item": "workflows" })
    expect(w.writes().at(-1)!.body).toEqual({ show: { workflows: null } })
  })

  it("a refused save says why and changes nothing on screen", async () => {
    const w = openWall({
      hash: "#page=settings&section=layout",
      route: (u, i) => i?.method === "POST" ? { status: 400, body: { error: "layout must be \"simple\" or \"full\"" } } : undefined,
    })
    await w.settle()
    await w.click({ "data-hl-layout": "full" })
    expect(settingsHtml(w)).toContain("Not saved: layout must be")
    expect(w.win.AX_HUB_LAYOUT).toBeUndefined()
    // Retry sends the same change again.
    expect(settingsHtml(w)).toContain('data-st-act="hl-retry"')
    await w.click({ "data-st-act": "hl-retry" })
    expect(w.writes().map((c) => c.body)).toEqual([{ layout: "full" }, { layout: "full" }])
  })

  /** A Simple | Full button as the browser has it, in a group that finds its peers. */
  const radios = () => {
    const make = (id: string, on: boolean) => {
      const attrs: Record<string, string> = { role: "radio", "aria-checked": String(on), "data-hl-layout": id, tabindex: on ? "0" : "-1" }
      const b: any = {
        id: "", tagName: "BUTTON", attrs, focused: 0,
        get attributes() { return Object.entries(attrs).map(([name, value]) => ({ name, value })) },
        getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v }, hasAttribute: (k: string) => k in attrs,
        focus() { b.focused++ },
        closest: (sel: string) => (sel === '[role="radiogroup"]' ? group : null),
      }
      return b
    }
    const all: Record<string, any> = { simple: make("simple", true), full: make("full", false) }
    const group = { querySelector: (sel: string) => all[/data-hl-layout="(\w+)"/.exec(sel)?.[1] ?? ""] ?? null }
    return all
  }

  it("Simple | Full is a radio group with one tab stop", async () => {
    const w = open()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain('<div class="whl__seg" role="radiogroup" aria-label="Layout">')
    expect(html).toContain('role="radio" aria-checked="true" data-hl-layout="simple" tabindex="0"')
    expect(html).toContain('role="radio" aria-checked="false" data-hl-layout="full" tabindex="-1"')
  })

  it("arrow keys move the choice, take the focus and save it as a click does", async () => {
    const w = open()
    await w.settle()
    const r = radios()
    expect(await w.keyAt(r.simple, "ArrowRight")).toBe(true)
    expect(r.full.focused).toBe(1)
    expect(r.full.attrs.tabindex).toBe("0")
    expect(r.simple.attrs.tabindex).toBe("-1")
    expect(w.writes().map((c) => [c.url, c.body])).toEqual([["/api/admin/wall/settings/hub-layout", { layout: "full" }]])
    expect(w.win.AX_HUB_LAYOUT.layout).toBe("full")
    expect(settingsHtml(w)).toContain('aria-checked="true" data-hl-layout="full" tabindex="0"')
    // Left and Up go back (wrapping), Down goes on; each saves its layout.
    const r2 = radios()
    await w.keyAt(r2.simple, "ArrowLeft")
    await w.keyAt(r2.full, "ArrowUp")
    expect(w.writes().slice(1).map((c) => c.body)).toEqual([{ layout: "full" }, { layout: "simple" }])
    // Home on the chosen first one changes nothing; other keys are left alone.
    const r3 = radios()
    await w.keyAt(r3.simple, "Home")
    expect(await w.keyAt(r3.simple, "a")).toBe(false)
    expect(w.writes()).toHaveLength(3)
  })

  it("a repaint gives the keyboard back to the element that had it", async () => {
    const w = open()
    await w.settle()
    const r = radios()
    const box = w.el("wall-settings")
    box.contains = (e: unknown) => e === r.full
    box.querySelectorAll = (tag: string) => (tag === "BUTTON" ? [r.simple, r.full] : [])
    ;(w.doc as any).activeElement = r.full
    const before = w.paints()
    await w.click({ "data-hl-layout": "full" })
    expect(w.paints()).toBeGreaterThan(before)
    expect(r.full.focused).toBeGreaterThan(0)
    expect(r.simple.focused).toBe(0)
  })

  it("is listed in Settings for the owner", async () => {
    const w = open()
    await w.settle()
    expect(settingsHtml(w)).toContain("Simple or full, and what the Hub shows")
  })
})

describe("POST /api/admin/hub-layout is the owner's only", () => {
  let dir: string
  const prevCwd = process.cwd()
  const base = () => ({ node: { id: "n", name: "n" }, agents: { a: { name: "A" } } })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-hub-layout-"))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(base()))
    process.chdir(dir)
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  async function call(body: unknown, owner?: boolean): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST" }) as unknown as IncomingMessage
    let status = 200
    let out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, "/api/admin/hub-layout", owner === undefined ? undefined : { owner })
    return { status, json: JSON.parse(out) }
  }
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))

  it("refuses a token that is not the owner's, and writes nothing", async () => {
    for (const owner of [undefined, false]) {
      expect(await call({ layout: "full" }, owner)).toMatchObject({ status: 403, json: { error: "Only the owner can change the Hub's layout." } })
    }
    expect(saved()).toEqual(base())
  })
  it("saves for the owner and answers the new view", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      const r = await call({ layout: "full" }, true)
      expect(r.status).toBe(200)
      expect(r.json.layout.layout).toBe("full")
      expect(saved().dashboard.hub.layout).toBe("full")
    } finally { fetchMock.mockRestore() }
  })
})
