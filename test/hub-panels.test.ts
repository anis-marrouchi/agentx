import { describe, expect, it } from "vitest"
import {
  HUB_PANELS_CSS, HUB_PANELS_SCRIPT, hubHistoryHtml, hubNavFoldHtml, hubPanelClamp, hubPanelDrag,
  hubPanelGripHtml, hubPanelReopenHtml, hubPanelsApply, hubPanelsRead,
} from "../src/daemon/ui/pages/hub-panels"
import { injectFns } from "../src/daemon/ui/inject"
import { wallContextHtml, WALL_CONTEXT_CSS } from "../src/daemon/ui/pages/wall-context.client"

// #2101 P (Anis 2026-11-26): every Hub panel can be resized, collapsed and
// expanded like Orca, the state is remembered, and Back returns to the
// previous page.

describe("Hub panels: widths (#2101 P)", () => {
  it("keeps the side menu between 200 and 420 px", () => {
    expect(hubPanelClamp("nav", 150, 1600)).toBe(200)
    expect(hubPanelClamp("nav", 300.4, 1600)).toBe(300)
    expect(hubPanelClamp("nav", 900, 1600)).toBe(420)
  })

  it("keeps the right panel between 320 px and 70% of the window", () => {
    expect(hubPanelClamp("cx", 100, 1600)).toBe(320)
    expect(hubPanelClamp("cx", 2000, 1600)).toBe(1120)
    expect(hubPanelClamp("cx", 500, 1600)).toBe(500)
    // A narrow window never gives a maximum under the minimum.
    expect(hubPanelClamp("cx", 900, 300)).toBe(320)
  })

  it("never squeezes the page under 480 px when the right panel grows", () => {
    // 1440 window, 280 px menu: the panel stops at 1440 - 280 - 480 = 680.
    expect(hubPanelClamp("cx", 900, 1440, 280)).toBe(680)
    expect(hubPanelDrag("cx", 600, 1000, 700, 1440, 280)).toBe(680)
    // Too little room for both: the panel keeps its own minimum.
    expect(hubPanelClamp("cx", 900, 1000, 360)).toBe(320)
  })

  it("leaves no width (the default) alone", () => {
    expect(hubPanelClamp("nav", null, 1600)).toBeNull()
    expect(hubPanelClamp("nav", "300", 1600)).toBeNull()
    expect(hubPanelClamp("cx", NaN, 1600)).toBeNull()
  })

  it("grows the menu to the right and the panel to the left when dragged", () => {
    expect(hubPanelDrag("nav", 280, 280, 340, 1600)).toBe(340)
    expect(hubPanelDrag("cx", 500, 1000, 900, 1600)).toBe(600)
    expect(hubPanelDrag("cx", 500, 1000, 1400, 1600)).toBe(320)
  })
})

describe("Hub panels: what is remembered (#2101 P)", () => {
  it("reads the saved widths and folds", () => {
    const p = hubPanelsRead(JSON.stringify({ nav: { w: 320, folded: true }, cx: { w: 560, folded: false } }), 1600)
    expect(p).toEqual({ nav: { w: 320, folded: true }, cx: { w: 560, folded: false } })
  })

  it("gives the defaults for nothing saved or anything broken", () => {
    const d = { nav: { w: null, folded: false }, cx: { w: null, folded: false } }
    expect(hubPanelsRead(null, 1600)).toEqual(d)
    expect(hubPanelsRead("{not json", 1600)).toEqual(d)
    expect(hubPanelsRead("[1,2]", 1600)).toEqual(d)
    expect(hubPanelsRead(JSON.stringify({ nav: "x", cx: { folded: "yes" } }), 1600)).toEqual(d)
  })

  it("clamps a saved width to this window", () => {
    expect(hubPanelsRead(JSON.stringify({ cx: { w: 1500 } }), 1000).cx.w).toBe(700)
  })

  it("turns the state into the grid's variables and classes", () => {
    expect(hubPanelsApply({ nav: { w: 320, folded: false }, cx: { w: null, folded: true } })).toEqual({
      vars: { "--ax-nav-w": "320px" },
      classes: { "nav-folded": false, "cx-folded": true },
    })
  })

  it("gives a folded menu the rail's width and keeps its saved width for later", () => {
    const p = { nav: { w: 360, folded: true }, cx: { w: 600, folded: false } }
    expect(hubPanelsApply(p).vars).toEqual({ "--ax-cx-w": "600px" })
    expect(hubPanelsApply({ ...p, nav: { w: 360, folded: false } }).vars["--ax-nav-w"]).toBe("360px")
  })
})

describe("Hub panels: the page (#2101 P)", () => {
  it("gives each edge a separator you can focus", () => {
    for (const id of ["nav", "cx"] as const) {
      const html = hubPanelGripHtml(id)
      expect(html).toContain(`data-panel-grip="${id}"`)
      expect(html).toContain('role="separator"')
      expect(html).toContain('tabindex="0"')
    }
  })

  it("puts the right panel's edge inside the panel", () => {
    expect(wallContextHtml()).toContain('data-panel-grip="cx"')
  })

  it("has a fold button, Back and Forward, and a Panel button", () => {
    expect(hubNavFoldHtml()).toContain('data-panel-toggle="nav"')
    expect(hubHistoryHtml()).toContain('data-hist="back"')
    expect(hubHistoryHtml()).toContain('data-hist="fwd"')
    expect(hubPanelReopenHtml()).toContain('data-panel-toggle="cx"')
    expect(hubPanelReopenHtml()).toContain("hidden")
  })

  it("lets the grids read the widths", () => {
    expect(WALL_CONTEXT_CSS).toContain("var(--ax-nav-w, 280px) minmax(0, 1fr) var(--ax-cx-w, minmax(380px, 42vw))")
    expect(HUB_PANELS_CSS).toContain(".ax-wall.nav-folded { --ax-nav-w: 72px; }")
    expect(HUB_PANELS_CSS).toContain(".ax-wall.cx-folded .wcx { display: none; }")
  })

  it("ships a script that parses with its helpers", () => {
    const src = injectFns({ hubPanelClamp, hubPanelsRead, hubPanelsApply, hubPanelDrag }) + "\n" + HUB_PANELS_SCRIPT
    expect(() => new Function(src)).not.toThrow()
    expect(HUB_PANELS_SCRIPT).toContain("ax.hub.panels")
  })
})
