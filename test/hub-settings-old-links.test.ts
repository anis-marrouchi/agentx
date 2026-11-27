// Every way into Settings opens the new Settings, with one menu (#2101,
// Anis 2026-11-27: "we shall be having only one menu on the settings page").
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { OLD_SETTINGS_SECTIONS, SETTINGS_PAGE, newSettingsHref } from "../src/hub/settings/old-sections"
import { SETTINGS_PANES } from "../src/hub/settings/panes"
import { oldSettingsHash, settingsHash } from "../src/hub/settings/address"
import { WALL_SETTINGS_SCRIPT } from "../src/daemon/ui/pages/wall-settings.client"
import { renderWallPage, wallSettingsHref } from "../src/daemon/ui/pages/wall"
import { openWall } from "./wall-settings-harness"

/** The old Settings' section keys, read from its own menu (ST_GROUPS). */
function oldSectionKeys(): string[] {
  const block = WALL_SETTINGS_SCRIPT.slice(WALL_SETTINGS_SCRIPT.indexOf("var ST_GROUPS"), WALL_SETTINGS_SCRIPT.indexOf("var ST_SECTIONS"))
  return [...block.matchAll(/\['(\w+)', '[^']*', '([^']*)'/g)].filter((m) => !m[2]).map((m) => m[1])
}

describe("old Settings sections map to new panes (#2101)", () => {
  it("knows every old section that lives on Settings", () => {
    const keys = oldSectionKeys()
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) expect(OLD_SETTINGS_SECTIONS, k).toHaveProperty(k)
  })

  it("sends each to a built pane and a row that pane draws", () => {
    for (const [old, to] of Object.entries(OLD_SETTINGS_SECTIONS)) {
      const pane = SETTINGS_PANES.find((p) => p.id === to.section)
      expect(pane?.built, old).toBe(true)
      if (to.row) expect(pane!.rows.map((r) => r.id), old).toContain(to.row)
    }
  })

  it("writes the new address", () => {
    expect(newSettingsHref()).toBe(settingsHash())
    expect(newSettingsHref({ section: "diagnostics" })).toBe(`#page=${SETTINGS_PAGE}&section=diagnostics`)
    expect(newSettingsHref({ section: "webhooks" })).toBe(`#page=${SETTINGS_PAGE}&section=jobs&row=webhooks`)
    expect(newSettingsHref({ section: "agents", agent: "dev-session" })).toBe(`#page=${SETTINGS_PAGE}&section=agent&agent=dev-session`)
    expect(newSettingsHref({ section: "agents", under: "coo" })).toBe(`#page=${SETTINGS_PAGE}&section=general&row=add-agent`)
    expect(newSettingsHref({ section: "nope" })).toBe(`#page=${SETTINGS_PAGE}`)
    // Not tricked by Object's own keys.
    expect(newSettingsHref({ section: "toString" })).toBe(`#page=${SETTINGS_PAGE}`)
  })

  it("the new Settings' link to the old page says old=1", () => {
    expect(oldSettingsHash("mesh")).toBe("#page=settings&section=mesh&old=1")
  })
})

describe("the side menu's Settings (#2101)", () => {
  it("opens the new Settings when React draws it, else the old page", () => {
    expect(wallSettingsHref(true)).toBe(`#page=${SETTINGS_PAGE}`)
    expect(wallSettingsHref(false)).toBe("#page=settings")
  })

  it("keeps the old page when the React app is not there", () => {
    // No React build in the test run: hubReactHead is "", so legacy.
    const html = renderWallPage({ owner: true, hub: { react: true } })
    expect(html).toContain('data-nav="settings" href="#page=settings"')
  })
})

describe("#page=settings opens the new Settings (#2101)", () => {
  const PAGES = [SETTINGS_PAGE]

  it("on load, with its section", async () => {
    const w = openWall({ hash: "#page=settings&section=channels", hubPages: PAGES })
    await w.settle()
    expect(w.hash()).toBe(`#page=${SETTINGS_PAGE}&section=channels`)
    expect(w.wall.classList.contains("is-hub")).toBe(true)
    expect(w.wall.classList.contains("is-hub-own-menu")).toBe(true)
    expect(w.wall.classList.contains("is-settings")).toBe(false)
  })

  it("from a link in the page, with the agent", async () => {
    const w = openWall({ hash: "", hubPages: PAGES })
    await w.settle()
    expect(w.wall.classList.contains("is-hub-own-menu")).toBe(false)
    await w.go("#page=settings&section=agents&agent=coo")
    expect(w.hash()).toBe(`#page=${SETTINGS_PAGE}&section=agent&agent=coo`)
    expect(w.wall.classList.contains("is-hub-own-menu")).toBe(true)
  })

  it("not the new Settings' own link to a pane it does not draw", async () => {
    const w = openWall({ hash: "#page=settings&section=mesh&old=1", hubPages: PAGES })
    await w.settle()
    expect(w.hash()).toContain("page=settings&")
    expect(w.wall.classList.contains("is-settings")).toBe(true)
  })

  it("not when React does not draw Settings (legacyPages, ?legacy=1, not the owner)", async () => {
    const w = openWall({ hash: "#page=settings&section=channels", hubPages: [] })
    await w.settle()
    expect(w.hash()).toBe("#page=settings&section=channels")
    expect(w.wall.classList.contains("is-settings")).toBe(true)
    expect(w.wall.classList.contains("is-hub-own-menu")).toBe(false)
  })
})

describe("one menu on the new Settings (#2101)", () => {
  it("the old side menu, its grip and scrim step aside", () => {
    const css = readFileSync(join(__dirname, "../src/hub/styles.css"), "utf8")
    expect(css).toContain('.ax-wall.is-hub-own-menu :is(#wall-nav, [data-panel-grip="nav"], .hub-scrim) { display: none !important; }')
  })
})
