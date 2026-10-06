import { deflateSync } from "zlib"

// --- The AX symbol ---
//
// The one source for every AgentX icon (#686): the mark from the README and
// docs (docs/public/agentx-symbol.png), traced into its four straight-edged
// strokes. The daemon draws the phone app, member page and dashboard icons
// from it at runtime, and `pnpm icons` writes every static copy (Android,
// iOS, Mac helper, Raycast, docs) from it too, so no copy can drift.
//
// Coordinates are pixels of the 1254 px source PNG, shifted so the mark's
// top-left corner is 0,0. Every stroke is convex.

export const AX_INK = "#161615"
export const AX_PAPER = "#FFFFFF"

const MARK_W = 979
const MARK_H = 547

type Pt = readonly [number, number]

export const AX_STROKES: readonly (readonly Pt[])[] = [
  // The long stroke from top left to bottom right, rounded at both ends.
  [[333, 6], [339, 0], [506, 0], [528, 10], [927, 547], [743, 547], [724, 539], [337, 19]],
  // The short arm at top right.
  [[671, 141], [793, 0], [979, 0], [762, 260]],
  // The left leg of the A.
  [[0, 481], [314, 46], [409, 180], [182, 481]],
  // The crossbar of the A.
  [[346, 319], [350, 316], [513, 316], [598, 431], [498, 546], [346, 327]],
]

export interface IconStyle {
  /** Mark width as a share of the icon's side. */
  mark: number
  /** Paper behind the mark; none leaves it transparent. */
  paper?: {
    color?: string
    /** Margin on each side, as a share of the icon's side (macOS-style tiles). */
    inset?: number
    /** Corner radius as a share of the paper's side. */
    radius?: number
  }
  ink?: string
}

/** Full-bleed white square: safe under every circle and squircle mask, the
 *  mark inside the central 80% a maskable icon must keep. */
export const MASKABLE: IconStyle = { mark: 0.6, paper: {} }

/** A rounded white tile, legible on a dark tab bar or in the Dock. */
export const TILE: IconStyle = { mark: 0.56, paper: { inset: 0.1, radius: 0.225 } }

/** The bare mark, framed as in the source PNG. */
export const BARE: IconStyle = { mark: MARK_W / 1254 }

function place(size: number, style: IconStyle) {
  const k = (style.mark * size) / MARK_W
  return { k, x: (size - MARK_W * k) / 2, y: (size - MARK_H * k) / 2 }
}

function paperRect(size: number, style: IconStyle) {
  if (!style.paper) return null
  const inset = (style.paper.inset ?? 0) * size
  const side = size - 2 * inset
  return { x: inset, y: inset, side, r: (style.paper.radius ?? 0) * side }
}

function strokesAt(size: number, style: IconStyle): Pt[][] {
  const { k, x, y } = place(size, style)
  return AX_STROKES.map((s) => s.map(([px, py]) => [x + px * k, y + py * k] as Pt))
}

const n = (v: number) => String(Math.round(v * 100) / 100)

function pathData(strokes: Pt[][]): string {
  return strokes.map((s) => "M" + s.map(([x, y]) => `${n(x)} ${n(y)}`).join("L") + "Z").join("")
}

// --- SVG ---

export function axSymbolSvg(style: IconStyle, size = 100): string {
  const ink = style.ink ?? AX_INK
  const p = paperRect(size, style)
  const rect = p
    ? `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.side)}" height="${n(p.side)}"${p.r ? ` rx="${n(p.r)}"` : ""} fill="${style.paper?.color ?? AX_PAPER}"/>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${rect}<path fill="${ink}" d="${pathData(strokesAt(size, style))}"/></svg>\n`
}

/** The adaptive-icon foreground for Android: the mark on a 108 dp canvas,
 *  inside the 66 dp circle every launcher mask keeps. The background layer
 *  is the white `ic_launcher_background` colour. */
export function axSymbolAndroidVector(): string {
  const d = pathData(strokesAt(108, { mark: 0.5 }))
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from src/brand/ax-symbol.ts by \`pnpm icons\`. Do not edit. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="${AX_INK}"
        android:pathData="${d}" />
</vector>
`
}

// --- PNG ---

const SUB = 8 // sub-rows per pixel row; columns get exact span coverage

const pngCache = new Map<string, Buffer>()

/** The icon as a PNG: RGB when it is opaque (iOS refuses alpha in app
 *  icons), RGBA when it has transparent corners or no paper. */
export function axSymbolPng(size: number, style: IconStyle): Buffer {
  const key = `${size}:${JSON.stringify(style)}`
  let png = pngCache.get(key)
  if (!png) {
    png = encodePng(size, rasterize(size, style))
    pngCache.set(key, png)
  }
  return png
}

/** Per-pixel coverage of the paper and of the ink, each 0..1. */
function coverage(size: number, style: IconStyle) {
  const paper = new Float32Array(size * size)
  const ink = new Float32Array(size * size)
  const p = paperRect(size, style)
  const strokes = strokesAt(size, style)
  for (let row = 0; row < size; row++) {
    for (let j = 0; j < SUB; j++) {
      const y = row + (j + 0.5) / SUB
      if (p) {
        const span = roundedSpan(p, y)
        if (span) addSpan(paper, row * size, size, span[0], span[1])
      }
      for (const s of strokes) {
        const span = convexSpan(s, y)
        if (span) addSpan(ink, row * size, size, span[0], span[1])
      }
    }
  }
  return { paper, ink }
}

function addSpan(buf: Float32Array, base: number, size: number, x0: number, x1: number) {
  const a = Math.max(0, x0)
  const b = Math.min(size, x1)
  for (let x = Math.floor(a); x < b; x++) {
    const cover = Math.min(b, x + 1) - Math.max(a, x)
    if (cover > 0) buf[base + x] += cover / SUB
  }
}

function convexSpan(poly: Pt[], y: number): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    if ((ay <= y && y < by) || (by <= y && y < ay)) {
      const x = ax + ((y - ay) / (by - ay)) * (bx - ax)
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
  }
  return lo < hi ? [lo, hi] : null
}

function roundedSpan(p: { x: number; y: number; side: number; r: number }, y: number): [number, number] | null {
  if (y < p.y || y >= p.y + p.side) return null
  const dy = Math.max(0, p.y + p.r - y, y - (p.y + p.side - p.r))
  const dx = p.r - Math.sqrt(Math.max(0, p.r * p.r - dy * dy))
  return [p.x + dx, p.x + p.side - dx]
}

function hex(c: string): number[] {
  const v = parseInt(c.slice(1), 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function rasterize(size: number, style: IconStyle): { raw: Buffer; channels: 3 | 4 } {
  const { paper, ink } = coverage(size, style)
  const inkRgb = hex(style.ink ?? AX_INK)
  const paperRgb = hex(style.paper?.color ?? AX_PAPER)
  const opaque = paper.every((c) => c >= 1)
  const channels = opaque ? 3 : 4
  // One filter byte (0 = none) per row, then the pixels.
  const row = 1 + size * channels
  const raw = Buffer.alloc(row * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const ci = Math.min(1, ink[i])
      const cp = Math.min(1, paper[i]) * (1 - ci)
      const alpha = ci + cp
      const o = y * row + 1 + x * channels
      for (let c = 0; c < 3; c++) {
        raw[o + c] = alpha > 0 ? Math.round((inkRgb[c] * ci + paperRgb[c] * cp) / alpha) : 0
      }
      if (channels === 4) raw[o + 3] = Math.round(alpha * 255)
    }
  }
  return { raw, channels }
}

function encodePng(size: number, { raw, channels }: { raw: Buffer; channels: 3 | 4 }): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = channels === 4 ? 6 : 2 // colour type: RGBA or RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
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
