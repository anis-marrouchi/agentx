import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { inflateSync } from "zlib"
import { axSymbolPng, MASKABLE, TILE } from "../src/brand/ax-symbol"
import { iconFiles, sameIcon } from "../src/brand/icon-files"

const root = resolve(__dirname, "..")

/** RGB(A) of pixel x,y in a PNG written by axSymbolPng (filter 0 rows). */
function pixel(png: Buffer, x: number, y: number): number[] {
  const size = png.readUInt32BE(16)
  const channels = png[25] === 6 ? 4 : 3
  const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
  const o = y * (1 + size * channels) + 1 + x * channels
  return [...raw.subarray(o, o + channels)]
}

describe("AX symbol icons (#686)", () => {
  it("every checked-in icon matches the AX symbol source (run `pnpm icons` if not)", () => {
    const stale = iconFiles(root).filter((f) => {
      const abs = join(root, f.path)
      return !existsSync(abs) || !sameIcon(readFileSync(abs), f.render())
    })
    expect(stale.map((f) => f.path)).toEqual([])
  })

  it("draws the mark on an opaque white square for home screens", () => {
    const png = axSymbolPng(512, MASKABLE)
    expect(png[25]).toBe(2) // RGB: iOS rejects alpha
    expect(pixel(png, 0, 0)).toEqual([255, 255, 255])
    // Inside the long stroke, the mark's widest part.
    expect(pixel(png, 297, 256)).toEqual([0x16, 0x16, 0x15])
  })

  it("leaves the corners of a tile transparent", () => {
    const png = axSymbolPng(64, TILE)
    expect(png[25]).toBe(6)
    expect(pixel(png, 0, 0)[3]).toBe(0)
    expect(pixel(png, 32, 12)).toEqual([255, 255, 255, 255])
  })

  it("Android launchers use the white adaptive background", () => {
    for (const app of ["apps/android", "apps/phone/android"]) {
      const xml = readFileSync(join(root, app, "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8")
      expect(xml).toContain("@color/ic_launcher_background")
      expect(xml).toContain("@drawable/ic_launcher_foreground")
    }
  })
})
