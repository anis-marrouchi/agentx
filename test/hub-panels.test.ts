import { describe, expect, it } from "vitest"
import {
  HUB_CX_MIN, HUB_MAIN_MIN, HUB_NAV_MAX, HUB_NAV_MIN, HUB_PANEL_LIMITS, HUB_PANELS_CSS, HUB_PANELS_FNS, HUB_PANELS_SCRIPT,
  hubCxOpened, hubHistStep, hubHistoryHtml, hubNavFoldHtml, hubPanelClamp, hubPanelDrag, hubPanelGripHtml, hubPanelKey,
  hubPanelReopenHtml, hubPanelResetHtml, hubPanelsApply, hubPanelsFit, hubPanelsRead,
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
      vars: { "--axp-nav-w": "320px" },
      classes: { "nav-folded": false, "cx-folded": true },
    })
  })

  it("gives a folded menu the rail's width and keeps its saved width for later", () => {
    const p = { nav: { w: 360, folded: true }, cx: { w: 600, folded: false } }
    expect(hubPanelsApply(p).vars).toEqual({ "--axp-cx-w": "600px" })
    expect(hubPanelsApply({ ...p, nav: { w: 360, folded: false } }).vars["--axp-nav-w"]).toBe("360px")
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
    expect(WALL_CONTEXT_CSS).toContain("var(--axp-nav-w, 280px) minmax(0, 1fr) var(--axp-cx-w, minmax(380px, 42vw))")
    expect(HUB_PANELS_CSS).toContain(".ax-wall.nav-folded { --axp-nav-w: 56px; }")
    expect(HUB_PANELS_CSS).toContain(".ax-wall.cx-folded .wcx { display: none; }")
  })

  it("names its controls with tooltips, not title (Hub review batch 6, C14)", () => {
    const html = hubNavFoldHtml() + hubPanelGripHtml("nav") + hubPanelGripHtml("cx") + hubHistoryHtml() + hubPanelReopenHtml() + hubPanelResetHtml()
    expect(html).not.toContain("title=")
    expect(hubPanelGripHtml("cx")).toContain('data-tip="Drag to resize. Double-click to reset."')
    expect(hubHistoryHtml()).toContain('aria-label="Back to the previous page" data-tip="Back"')
    // The ⌘B / ⌘J chips go on a Mac only: Windows and Linux have no shortcut.
    expect(HUB_PANELS_SCRIPT).toContain("if (MAC) b.setAttribute('data-tip-key', '⌘B');")
    expect(HUB_PANELS_SCRIPT).toContain("if (MAC) re.setAttribute('data-tip-key', '⌘J');")
    expect(HUB_PANELS_SCRIPT).not.toContain(".title =")
  })

  it("resets a width on double-click, and both panels with Reset layout (C21, C23)", () => {
    // Double-click gives the panel its default width back; it no longer folds it.
    const dbl = HUB_PANELS_SCRIPT.slice(HUB_PANELS_SCRIPT.indexOf("addEventListener('dblclick'"), HUB_PANELS_SCRIPT.indexOf("addEventListener('keydown'"))
    expect(dbl).toContain("P[id].w = null; P[id].folded = false; save(); apply();")
    expect(dbl).not.toContain("toggle(")
    // Reset layout: one click, shown only while a panel moved, gone under 1180 px.
    expect(hubPanelResetHtml()).toContain('data-panel-reset hidden>')
    expect(hubPanelResetHtml()).toContain("lucide-rotate-ccw")
    expect(HUB_PANELS_SCRIPT).toContain("if (t.hasAttribute('data-panel-reset')) { reset(); return; }")
    expect(HUB_PANELS_SCRIPT).toContain("var moved = P.nav.w != null || P.nav.folded || P.cx.w != null || P.cx.folded;")
    expect(HUB_PANELS_CSS).toContain(".axp-grip, .axp-navfold, .axp-reopen, .axp-reset { display: none !important; }")
  })

  it("collapses the right panel on Esc, or closes its tab where it is a sheet (C16)", () => {
    const esc = HUB_PANELS_SCRIPT.slice(HUB_PANELS_SCRIPT.indexOf("if (ev.key === 'Escape'"))
    // Never while typing a line comment, nor after something in the panel used the Esc.
    expect(esc).toMatch(/^if \(ev\.key === 'Escape' && !typing && !ev\.defaultPrevented && cxOpen\(\) && tg\.closest && tg\.closest\('#wall-ctx'\)\)/)
    expect(esc).toContain("if (innerWidth > 1180) { if (!P.cx.folded) { ev.preventDefault(); toggle('cx'); } return; }")
    expect(esc).toContain("#wcx-tabs .wcx__tab.is-on [data-cx=\"close\"]")
  })

  it("uses the one focus ring and gates hover (S1, C20)", () => {
    expect(HUB_PANELS_CSS).not.toContain("var(--ax-accent)")
    expect(HUB_PANELS_CSS).toContain("@media (hover: hover) { .axp-btn:hover:not(:disabled)")
    expect(HUB_PANELS_CSS).toContain(".axp-grip:focus-visible::after { left: 2px; width: 3px; background: color-mix(in srgb, var(--ax-ring) 50%, transparent); }")
  })

  it("ships a script that parses with its helpers", () => {
    const src = injectFns(HUB_PANELS_FNS) + "\n" + HUB_PANELS_SCRIPT
    expect(() => new Function(src)).not.toThrow()
    expect(HUB_PANELS_SCRIPT).toContain("ax.hub.panels")
  })

  it("passes the bounds to the shipped helpers, which cannot see module constants", () => {
    expect(HUB_PANELS_SCRIPT).toContain(`LIM = ${JSON.stringify(HUB_PANEL_LIMITS)}`)
    // The page script never calls a helper without them.
    expect(HUB_PANELS_SCRIPT).not.toMatch(/hubPanelsRead\([^)]*innerWidth\)/)
  })

  it("re-fits the widths when the window changes size", () => {
    expect(HUB_PANELS_SCRIPT).toContain("addEventListener('resize'")
    expect(HUB_PANELS_SCRIPT).toContain("hubPanelsFit(P, innerWidth, cxOpen(), LIM)")
  })

  it("gives each edge its value range (aria-valuenow, min, max)", () => {
    expect(hubPanelGripHtml("nav")).toContain(`aria-valuemin="${HUB_NAV_MIN}" aria-valuemax="${HUB_NAV_MAX}" aria-valuenow="280"`)
    expect(hubPanelGripHtml("cx")).toContain(`aria-valuemin="${HUB_CX_MIN}"`)
    expect(HUB_PANELS_SCRIPT).toContain("setAttribute('aria-valuenow'")
  })

  it("hides the post's own Back only where Back and Forward show (not on a phone)", () => {
    expect(HUB_PANELS_CSS).toContain("@media (min-width: 641px) { .ax-wall__back { display: none !important; } }")
    expect(HUB_PANELS_CSS).not.toMatch(/^\.ax-wall__back \{ display: none/m)
    expect(HUB_PANELS_CSS).toContain("@media (max-width: 640px) { .axp-hist { display: none; } }")
  })
})

describe("Hub panels: the page keeps 480 px (#2101 P review)", () => {
  it("uses the exported bounds", () => {
    expect(hubPanelClamp("nav", 0, 1600)).toBe(HUB_NAV_MIN)
    expect(hubPanelClamp("nav", 1e6, 1600)).toBe(HUB_NAV_MAX)
    expect(hubPanelClamp("cx", 0, 1600)).toBe(HUB_CX_MIN)
    const lim = { ...HUB_PANEL_LIMITS, navMax: 500 }
    expect(hubPanelClamp("nav", 1e6, 1600, undefined, lim)).toBe(500)
  })

  it("fits saved widths too big for the window: 420 + 840 at 1200 px", () => {
    const p = { nav: { w: 420, folded: false }, cx: { w: 840, folded: false } }
    const f = hubPanelsFit(p, 1200, true)
    expect(f.cx.w).toBe(HUB_CX_MIN)
    expect(f.nav.w).toBe(1200 - HUB_CX_MIN - HUB_MAIN_MIN)
    expect(1200 - f.nav.w! - f.cx.w!).toBeGreaterThanOrEqual(HUB_MAIN_MIN)
    // The saved preference is not changed.
    expect(p).toEqual({ nav: { w: 420, folded: false }, cx: { w: 840, folded: false } })
  })

  it("gives the widths back on a wide window", () => {
    const p = { nav: { w: 420, folded: false }, cx: { w: 840, folded: false } }
    expect(hubPanelsFit(p, 2000, true)).toEqual(p)
  })

  it("lets the menu take its width when the right panel is closed or folded", () => {
    const p = { nav: { w: 420, folded: false }, cx: { w: 840, folded: false } }
    expect(hubPanelsFit(p, 1200, false).nav.w).toBe(420)
    expect(hubPanelsFit({ ...p, cx: { w: 840, folded: true } }, 1200, true).nav.w).toBe(420)
  })

  it("counts a folded menu as the icon rail and the default menu as 280 px", () => {
    expect(hubPanelsFit({ nav: { w: 420, folded: true }, cx: { w: 840, folded: false } }, 1200, true).cx.w).toBe(1200 - 56 - HUB_MAIN_MIN)
    expect(hubPanelsFit({ nav: { w: null, folded: false }, cx: { w: 840, folded: false } }, 1200, true).cx.w).toBe(1200 - 280 - HUB_MAIN_MIN)
  })

  it("narrows the menu next to the default right panel (42% of the window)", () => {
    // 1300 px: the default panel is 546 px, so the menu gets 1300 - 546 - 480 = 274.
    expect(hubPanelsFit({ nav: { w: 420, folded: false }, cx: { w: null, folded: false } }, 1300, true).nav.w).toBe(274)
  })

  it("leaves the menu its room when the panel is dragged", () => {
    expect(hubPanelDrag("nav", 300, 300, 900, 1200, 600)).toBe(HUB_NAV_MIN)
    expect(hubPanelDrag("nav", 300, 300, 900, 1400, 600)).toBe(320)
  })
})

describe("Hub panels: ⌘B and ⌘J (#2101 P review)", () => {
  const ctx = { mac: true, typing: false, viewport: 1600, cxOpen: true }

  it("toggles the menu and the panel with ⌘ on a Mac", () => {
    expect(hubPanelKey({ key: "b", metaKey: true }, ctx)).toBe("nav")
    expect(hubPanelKey({ key: "J", metaKey: true }, ctx)).toBe("cx")
  })

  it("leaves Ctrl+B and Ctrl+J to the browser on Windows and Linux", () => {
    const pc = { ...ctx, mac: false }
    expect(hubPanelKey({ key: "b", ctrlKey: true }, pc)).toBeNull()
    expect(hubPanelKey({ key: "j", ctrlKey: true }, pc)).toBeNull()
    expect(hubPanelKey({ key: "j", metaKey: true }, pc)).toBeNull()
    expect(hubPanelKey({ key: "b", ctrlKey: true }, ctx)).toBeNull()
  })

  it("does not fold a right panel that is not open", () => {
    expect(hubPanelKey({ key: "j", metaKey: true }, { ...ctx, cxOpen: false })).toBeNull()
    expect(hubPanelKey({ key: "b", metaKey: true }, { ...ctx, cxOpen: false })).toBe("nav")
  })

  it("ignores the keys while typing, with other modifiers, and under 1180 px", () => {
    expect(hubPanelKey({ key: "b", metaKey: true }, { ...ctx, typing: true })).toBeNull()
    expect(hubPanelKey({ key: "b", metaKey: true, shiftKey: true }, ctx)).toBeNull()
    expect(hubPanelKey({ key: "j", metaKey: true, altKey: true }, ctx)).toBeNull()
    expect(hubPanelKey({ key: "b", metaKey: true }, { ...ctx, viewport: 1180 })).toBeNull()
    expect(hubPanelKey({ key: "k", metaKey: true }, ctx)).toBeNull()
  })

  it("expands a folded panel when something is opened in it, not when a tab closes", () => {
    expect(hubCxOpened({ n: 0, on: null }, { n: 1, on: "0" })).toBe(true)
    expect(hubCxOpened({ n: 2, on: "0" }, { n: 3, on: "2" })).toBe(true)
    // An open tab opened again from the page becomes the open one.
    expect(hubCxOpened({ n: 3, on: "2" }, { n: 3, on: "0" })).toBe(true)
    // The same tabs drawn again (a reload of the data).
    expect(hubCxOpened({ n: 3, on: "2" }, { n: 3, on: "2" })).toBe(false)
    expect(hubCxOpened({ n: 3, on: "2" }, { n: 2, on: "1" })).toBe(false)
    expect(hubCxOpened({ n: 1, on: "0" }, { n: 0, on: null })).toBe(false)
  })
})

describe("Hub panels: Back and Forward without the Navigation API (#2101 P review)", () => {
  it("counts a new page up and drops what was ahead", () => {
    let h = { idx: 0, top: 0 }
    h = hubHistStep(h, undefined)
    h = hubHistStep(h, null)
    expect(h).toEqual({ idx: 2, top: 2 })
  })

  it("counts a browser Back or swipe down, not up, and Forward up again", () => {
    let h = { idx: 3, top: 3 }
    h = hubHistStep(h, 2)
    expect(h).toEqual({ idx: 2, top: 3 })
    h = hubHistStep(h, 1)
    expect(h).toEqual({ idx: 1, top: 3 })
    h = hubHistStep(h, 2)
    expect(h).toEqual({ idx: 2, top: 3 })
    // A new page from there drops entries 3.
    expect(hubHistStep(h, undefined)).toEqual({ idx: 3, top: 3 })
  })

  it("reads a reload's place from the entry, not from a running count", () => {
    expect(HUB_PANELS_SCRIPT).not.toContain("ax.hub.depth")
    expect(HUB_PANELS_SCRIPT).toContain("if (typeof s0 === 'number') H = { idx: s0, top: Math.max(s0, t0) }")
  })

  it("ignores a broken index", () => {
    expect(hubHistStep({ idx: 1, top: 1 }, -1)).toEqual({ idx: 2, top: 2 })
    expect(hubHistStep({ idx: 1, top: 1 }, "1")).toEqual({ idx: 2, top: 2 })
  })
})
