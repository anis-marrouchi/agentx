import { describe, expect, it } from "vitest"
import { HUB_ICON_NAMES, hubIcon, hubIconMap } from "../src/daemon/ui/pages/hub-lucide"

describe("hubIcon (#2101, orca-design C9)", () => {
  it("draws a lucide icon as one line, hidden from screen readers, 16 px by default", () => {
    const svg = hubIcon("circle-alert")
    expect(svg).toMatch(/^<svg class="lucide lucide-circle-alert" aria-hidden="true" focusable="false"/)
    expect(svg).toContain('width="16" height="16"')
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).not.toMatch(/\n/)
    expect(svg.endsWith("</svg>")).toBe(true)
  })
  it("adds a class and takes a size", () => {
    const svg = hubIcon("loader-circle", "is-spin", 14)
    expect(svg).toContain('class="lucide lucide-loader-circle is-spin"')
    expect(svg).toContain('width="14" height="14"')
  })
  it("is empty for a name it does not carry", () => {
    expect(hubIcon("no-such-icon")).toBe("")
  })
  it("carries every listed name, and a map of them for browser scripts", () => {
    for (const n of HUB_ICON_NAMES) expect(hubIcon(n), n).toContain("<svg")
    const m = hubIconMap(["x", "check"], 14)
    expect(Object.keys(m)).toEqual(["x", "check"])
    expect(m.x).toContain('width="14"')
  })
})
