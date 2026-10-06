import { deflateSync } from "zlib"
import { AX_INK, AX_LAYOUT, AX_PAPER, axIconSvg, axSymbolShapes, type Point } from "../brand/ax-symbol"

// --- App icons ---
//
// Home screens need PNGs (iOS ignores SVG touch icons, and Chrome wants a
// 192 and a 512 for installability). Drawn here from the AX symbol's points
// (src/brand/ax-symbol.ts) rather than shipped as binary files, so the
// zero-build dashboard stays text-only. The phone and member icons are a
// full-bleed white square with the symbol inside the circle a maskable crop
// keeps; scripts/gen-icons.ts uses the same renderer for the native apps.

export type IconBackground = "square" | "mac"

export interface IconSpec {
  size: number
  /** Symbol width as a fraction of `size` (see AX_LAYOUT). */
  width: number
  background: IconBackground
}

const INK = hexRgb(AX_INK)
const PAPER = hexRgb(AX_PAPER)

const cache = new Map<number, Buffer>()

/** The phone app / member page icon, safe under a maskable crop. */
export function appIconPng(size: number): Buffer {
  let png = cache.get(size)
  if (!png) {
    png = renderIconPng({ size, width: AX_LAYOUT.safe, background: "square" })
    cache.set(size, png)
  }
  return png
}

/** The dashboard favicon, served at /favicon.svg. */
export const FAVICON_SVG = axIconSvg()

/**
 * The dashboard's own icons, public like the phone app's: /favicon.svg,
 * /favicon.ico (a PNG, which every browser takes at that path) for clients
 * that ask for it unprompted, and /apple-touch-icon.png. Null for any other
 * path.
 */
export function dashboardIcon(path: string): { type: string; body: string | Buffer } | null {
  if (path === "/favicon.svg") return { type: "image/svg+xml", body: FAVICON_SVG }
  if (path === "/favicon.ico") return { type: "image/png", body: squareIcon(32) }
  if (path === "/apple-touch-icon.png") return { type: "image/png", body: squareIcon(180) }
  return null
}

const squares = new Map<number, Buffer>()
function squareIcon(size: number): Buffer {
  let png = squares.get(size)
  if (!png) {
    png = renderIconPng({ size, width: AX_LAYOUT.full, background: "square" })
    squares.set(size, png)
  }
  return png
}

export function renderIconPng(spec: IconSpec): Buffer {
  const { size } = spec
  const paper = spec.background === "mac" ? coverage(size, [macSquircle(size)]) : null
  const ink = coverage(size, axSymbolShapes(size, spec.width))
  // One filter byte (0 = none) per row, then RGBA pixels.
  const row = 1 + size * 4
  const raw = Buffer.alloc(row * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const a = ink[i]
      const o = y * row + 1 + x * 4
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(PAPER[c] + (INK[c] - PAPER[c]) * a)
      raw[o + 3] = Math.round(255 * (paper ? paper[i] : 1))
    }
  }
  return encodePng(size, raw)
}

// The 824px rounded square of Apple's 1024px icon template, scaled.
function macSquircle(size: number): Point[] {
  const s = size / 1024
  const lo = 100 * s
  const hi = 924 * s
  const r = 185 * s
  const pts: Point[] = []
  const corners: [number, number, number][] = [[hi - r, lo + r, -90], [hi - r, hi - r, 0], [lo + r, hi - r, 90], [lo + r, lo + r, 180]]
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= 12; k++) {
      const t = ((start + (90 * k) / 12) * Math.PI) / 180
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)])
    }
  }
  return pts
}

// Anti-aliased area coverage (0..1 per pixel) of the shapes, even-odd.
// Each pixel row is sampled on SUB scanlines; along a scanline a span's
// coverage is exact, fractional at both ends.
const SUB = 8
function coverage(size: number, shapes: readonly (readonly Point[])[]): Float32Array {
  const out = new Float32Array(size * size)
  const edges: [number, number, number, number][] = []
  for (const shape of shapes) {
    for (let i = 0; i < shape.length; i++) {
      const [x0, y0] = shape[i]
      const [x1, y1] = shape[(i + 1) % shape.length]
      if (y0 !== y1) edges.push([x0, y0, x1, y1])
    }
  }
  const xs: number[] = []
  for (let y = 0; y < size; y++) {
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB
      xs.length = 0
      for (const [x0, y0, x1, y1] of edges) {
        if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) xs.push(x0 + ((sy - y0) * (x1 - x0)) / (y1 - y0))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k])
        const b = Math.min(size, xs[k + 1])
        for (let px = Math.floor(a); px < b; px++) {
          const w = Math.min(px + 1, b) - Math.max(px, a)
          if (w > 0) out[y * size + px] += w / SUB
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] > 1) out[i] = 1
  return out
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function encodePng(size: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
