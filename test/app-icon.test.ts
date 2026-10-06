import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { inflateSync } from "zlib"
import { appIconPng, dashboardIcon, renderIconPng, FAVICON_SVG } from "../src/daemon/app-icon"
import { AX_LAYOUT, AX_SYMBOL_BOX, axSymbolShapes } from "../src/brand/ax-symbol"
import { TOPBAR_HEAD } from "../src/daemon/topbar"

// Decode one of our own PNGs (filter 0 on every row, RGBA) to pixels.
function pixels(png: Buffer): { size: number; at: (x: number, y: number) => number[] } {
  const size = png.readUInt32BE(16)
  const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
  const row = 1 + size * 4
  return { size, at: (x, y) => [...raw.subarray(y * row + 1 + x * 4, y * row + 5 + x * 4)] }
}

describe("AX symbol icons (#686)", () => {
  it("draws the symbol: ink inside a stroke, paper in the corners and the A's gap", () => {
    const { at } = pixels(appIconPng(512))
    // A point on the source canvas, as placed on the 512px icon.
    const k = (512 * AX_LAYOUT.safe) / AX_SYMBOL_BOX.width
    const place = (x: number, y: number) =>
      [Math.round(256 + (x - AX_SYMBOL_BOX.x - AX_SYMBOL_BOX.width / 2) * k), Math.round(256 + (y - AX_SYMBOL_BOX.y - AX_SYMBOL_BOX.height / 2) * k)] as const
    expect(at(...place(730, 666)).slice(0, 3)).toEqual([0x1a, 0x1a, 0x18]) // the X's long stroke
    expect(at(...place(535, 600))[0]).toBe(255) // between the A's leg and the X
    expect(at(2, 2)).toEqual([255, 255, 255, 255])
  })

  it("keeps every corner of the symbol inside a maskable crop's circle", () => {
    for (const [size, width, radius] of [[512, AX_LAYOUT.safe, 0.4], [108, AX_LAYOUT.android, 33 / 108]] as const) {
      for (const shape of axSymbolShapes(size, width)) {
        for (const [x, y] of shape) expect(Math.hypot(x - size / 2, y - size / 2)).toBeLessThan(radius * size)
      }
    }
    expect(AX_SYMBOL_BOX.width).toBeGreaterThan(AX_SYMBOL_BOX.height)
  })

  it("gives Mac icons a transparent margin around the rounded square", () => {
    const { at } = pixels(renderIconPng({ size: 256, width: AX_LAYOUT.mac, background: "mac" }))
    expect(at(4, 4)[3]).toBe(0)
    expect(at(128, 40)[3]).toBe(255)
  })

  it("serves the dashboard favicon and touch icon, and every page links them", () => {
    expect(dashboardIcon("/favicon.svg")?.body).toBe(FAVICON_SVG)
    expect(FAVICON_SVG).toMatch(/^<svg[^>]+viewBox="0 0 64 64"/)
    for (const [path, size] of [["/favicon.ico", 32], ["/apple-touch-icon.png", 180]] as const) {
      const icon = dashboardIcon(path)
      expect(icon?.type).toBe("image/png")
      expect((icon?.body as Buffer).readUInt32BE(16)).toBe(size)
    }
    expect(dashboardIcon("/favicon.png")).toBeNull()
    expect(TOPBAR_HEAD).toContain('href="/favicon.svg"')
  })

  it("the generated native icons match the source", () => {
    expect(() => execFileSync("npx", ["tsx", "scripts/gen-icons.ts", "--check"], { stdio: "pipe" })).not.toThrow()
  }, 60_000)
})
