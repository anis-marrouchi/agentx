// The Hub's simple and full layouts (#2226 S1): the keys, their defaults,
// the hide logic of the current Hub, and Settings › Layout.
import { describe, expect, it } from "vitest"
import { dashboardConfigSchema } from "../src/boards/config"
import {
  HUB_SHOW_IDS, applyHubLayoutPatch, hubHiddenItems, hubLayoutSetting, parseHubLayoutPatch, resolveHubLayout,
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
  it("an install with no key (new or existing) is simple: every item hidden", () => {
    for (const setting of [undefined, null, {}, dashboardConfigSchema.parse({}).hub]) {
      const v = resolveHubLayout(setting as any)
      expect(v.layout).toBe("simple")
      expect(hubHiddenItems(v)).toEqual(ALL)
      expect(v.overrides).toEqual([])
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
  it("an unknown layout falls back to simple", () => {
    expect(resolveHubLayout({ layout: "fancy" }).layout).toBe("simple")
  })
  it("hubLayoutSetting gives the same view back", () => {
    const v = resolveHubLayout({ layout: "full", show: { org: false } })
    expect(hubLayoutSetting(v)).toEqual({ layout: "full", show: { org: false } })
    expect(resolveHubLayout(hubLayoutSetting(v))).toEqual(v)
  })
})

describe("schema", () => {
  it("defaults dashboard.hub to the simple layout, no item switches", () => {
    expect(dashboardConfigSchema.parse({}).hub).toMatchObject({ layout: "simple", show: {} })
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
    expect(hubHideSelectors("gates")).toEqual([".wtk__prog", '.wtk__sec[aria-label="Plan"]', ".wtk .wc"])
    // No selector reaches Waiting on you (#wall-decide) or the needs nav.
    for (const id of HUB_SHOW_IDS) for (const s of hubHideSelectors(id)) expect(s).not.toMatch(/decide|needs/)
    expect(Object.values(HUB_NAV_ITEM).every((i) => (HUB_SHOW_IDS as readonly string[]).includes(i))).toBe(true)
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
  it("the page boots simple when no setting is given, and full when asked", () => {
    const simple = renderWallPage({ owner: true })
    expect(simple).toContain(`document.documentElement.setAttribute("data-hub-hide", "${ALL.join(" ")}")`)
    const full = renderWallPage({ owner: true, hub: { react: false, layout: resolveHubLayout({ layout: "full" }) } })
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
    expect(html).toContain('data-hl-layout="simple" checked')
    expect(html).not.toContain('data-hl-layout="full" checked')
    for (const id of ALL) expect(html).toContain(`data-hl-item="${id}"`)
    expect(html).toContain('data-hl-item="gates" checked')
    expect(html).not.toContain('data-hl-item="workflows" checked')
    // Gates has its own switch set: it can go back to the layout's default.
    expect(html).toContain('data-st-act="hl-reset" data-hl-item="gates"')
    expect(html).toContain("Hidden items keep running")
    expect(w.writes()).toEqual([])
  })

  it("Full is one switch away, and applies at once with no reload", async () => {
    const w = open()
    await w.settle()
    await w.change({ "data-hl-layout": "full" }, true)
    expect(w.writes().map((c) => [c.url, c.body])).toEqual([["/api/admin/wall/settings/hub-layout", { layout: "full" }]])
    expect(w.win.AX_HUB_LAYOUT.layout).toBe("full")
    expect(settingsHtml(w)).toContain('data-hl-layout="full" checked')
    expect(settingsHtml(w)).toContain("no restart needed")
  })

  it("one item's switch saves that item only; As the layout clears it", async () => {
    const w = open({ summary: "ok", layout: resolveHubLayout({ show: { workflows: true } }) })
    await w.settle()
    await w.change({ "data-hl-item": "workflows" }, true)
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
    await w.change({ "data-hl-layout": "full" }, true)
    expect(w.el("st-n-hl").textContent).toContain("Not saved:")
    expect(w.win.AX_HUB_LAYOUT).toBeUndefined()
  })

  it("is listed in Settings for the owner", async () => {
    const w = open()
    await w.settle()
    expect(settingsHtml(w)).toContain("Simple or full, and what the Hub shows")
  })
})
