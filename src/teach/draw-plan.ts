// --- The plan for `agentx teach --live <goal> --mode draw` ---
//
// One model turn plans the whole picture, one element per line, and the
// drawer starts on the first line while the model is still writing the
// rest. Act mode spends a model round-trip per click (about 8 s a step);
// this spends one for the whole illustration.

export const CANVAS = { w: 1000, h: 640 }

export const COLORS = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"] as const
export const GEOS = ["rectangle", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "octagon", "star", "rhombus", "oval", "trapezoid", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "cloud", "heart"] as const
const FILLS = ["none", "semi", "solid", "fill", "pattern"] as const
export const MAX_ELEMENTS = 180
const MAX_POINTS = 48
const SIZES = ["s", "m", "l", "xl"] as const
const FONTS = ["draw", "sans", "serif", "mono"] as const

type Color = typeof COLORS[number]

type Fill = typeof FILLS[number]

export interface GeoEl { kind: "geo"; id: string; say: string; geo: typeof GEOS[number]; x: number; y: number; w: number; h: number; color: Color; fill: Fill; label: string; opacity: number }
/** A free outline: closed and filled, or an open stroke when fill is none. */
export interface PathEl { kind: "path"; id: string; say: string; pts: Array<[number, number]>; color: Color; fill: Fill; opacity: number }
export interface TextEl { kind: "text"; id: string; say: string; text: string; x: number; y: number; size: typeof SIZES[number]; color: Color; font: typeof FONTS[number] }
export interface ArrowEl { kind: "arrow"; id: string; say: string; from: string; to: string; label: string; color: Color }
/** Remaps colour names to hex values for this drawing's theme. */
export interface PaletteEl { kind: "palette"; id: string; say: string; colors: Partial<Record<Color, string>> }
export type DrawEl = GeoEl | PathEl | TextEl | ArrowEl | PaletteEl

export function drawSystemPrompt(): string {
  return [
    `You are an illustrator drawing on a tldraw canvas ${CANVAS.w} wide and ${CANVAS.h} tall (x right, y down, origin top-left).`,
    `Reply with JSON Lines only: one element per line, no prose, no code fences. Scale the number of elements to the brief: a quick sketch needs 10 to 20, a finished, ambitious piece up to ${MAX_ELEMENTS}. Draw back to front: background first, then midground, foreground, details, text last, arrows at the very end.`,
    `Palette (optional, first line): {"palette":{"blue":"#1f5fa6","white":"#f7f3ea"},"say":"Choosing a palette."} remaps any of the colour names to a hex value for this drawing; every later element uses the names.`,
    `Shape: {"id":"sea","say":"First, the sea.","geo":"rectangle","x":0,"y":420,"w":1000,"h":220,"color":"blue","fill":"fill","label":"","opacity":1}`,
    `Path: {"id":"dome","say":"","path":[[400,200],[410,170],[440,150],[470,170],[480,200],[400,200]],"color":"white","fill":"fill","opacity":1} is a free outline of 3 to ${MAX_POINTS} points, closed and filled, for any silhouette a box can't make: domes, arches, hills, foliage, stairs, shadows, reflections. Straight edges stay straight; give curves enough points. With fill none it is an open stroke: a railing, a grille bar, a crack, a horizon line.`,
    `Text: {"id":"title","say":"And a title.","text":"Sidi Bou Said","x":330,"y":40,"size":"xl","color":"black","font":"serif"}`,
    `Arrow: {"id":"a1","say":"That's the sun.","arrow":["sun-note","sun"],"label":"","color":"black"}`,
    "An arrow joins two DIFFERENT earlier elements. To label something, first add a small text element beside it, then an arrow from that text to the thing.",
    `geo is one of: ${GEOS.join(", ")}.`,
    `color is one of: ${COLORS.join(", ")}. fill is fill (strong colour), solid (pale tint), semi, none or pattern. opacity is 0.1 to 1: use it for shadows, haze and atmospheric depth. size is s, m, l or xl. font is draw (hand-lettered), sans, serif or mono.`,
    "Keep everything inside the canvas. Give text room: an xl word is about 40 px tall and 28 px wide per letter.",
    "say is a short caption, at most 8 words, in the voice of someone drawing it live. Caption only the steps worth narrating (about one in five) and leave say empty on the rest: captioned steps pause so they can be read, the others draw straight through.",
  ].join("\n")
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? v as T : fallback
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const opacity = (v: unknown) => clamp(num(v) ?? 1, 0.1, 1)
const HEX = /^#[0-9a-f]{6}$/i

function palette(v: unknown): Partial<Record<Color, string>> | null {
  if (!v || typeof v !== "object") return null
  const out: Partial<Record<Color, string>> = {}
  for (const [k, hex] of Object.entries(v)) {
    if ((COLORS as readonly string[]).includes(k) && typeof hex === "string" && HEX.test(hex)) out[k as Color] = hex
  }
  return Object.keys(out).length ? out : null
}

function points(v: unknown): Array<[number, number]> | null {
  if (!Array.isArray(v)) return null
  const pts: Array<[number, number]> = []
  for (const p of v.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p)) return null
    const x = num(p[0]), y = num(p[1])
    if (x === null || y === null) return null
    pts.push([clamp(x, 0, CANVAS.w), clamp(y, 0, CANVAS.h)])
  }
  return pts.length >= 2 ? pts : null
}

/**
 * One plan line → a drawable element, or null for anything that isn't one
 * (prose, a fence, a half-written line, an arrow to an unknown id). Unknown
 * enum values fall back to defaults rather than failing the drawing, and
 * geometry is clamped to the canvas.
 */
export function parseDrawLine(line: string, known: ReadonlySet<string>): DrawEl | null {
  const s = line.trim().replace(/,$/, "")
  if (!s.startsWith("{")) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(s) } catch { return null }
  if ("palette" in o) {
    const colors = palette(o.palette)
    if (!colors || known.has("palette")) return null
    return { kind: "palette", id: "palette", say: typeof o.say === "string" ? o.say.slice(0, 80) : "", colors }
  }
  const id = typeof o.id === "string" && o.id ? o.id.slice(0, 40) : null
  if (!id || known.has(id)) return null
  const say = typeof o.say === "string" ? o.say.slice(0, 80) : ""
  const color = pick(o.color, COLORS, "black")

  if (Array.isArray(o.arrow)) {
    const [from, to] = o.arrow
    if (typeof from !== "string" || typeof to !== "string" || !known.has(from) || !known.has(to) || from === to) return null
    return { kind: "arrow", id, say, from, to, label: typeof o.label === "string" ? o.label.slice(0, 40) : "", color }
  }

  if ("path" in o) {
    const pts = points(o.path)
    const fill = pick(o.fill, FILLS, "fill")
    if (!pts || (fill !== "none" && pts.length < 3)) return null
    return { kind: "path", id, say, pts, color, fill, opacity: opacity(o.opacity) }
  }

  const x = num(o.x), y = num(o.y)
  if (x === null || y === null) return null
  if (typeof o.text === "string" && o.text) {
    return {
      kind: "text", id, say, text: o.text.slice(0, 60),
      x: clamp(x, 0, CANVAS.w - 20), y: clamp(y, 0, CANVAS.h - 20),
      size: pick(o.size, SIZES, "l"), color, font: pick(o.font, FONTS, "draw"),
    }
  }
  if (typeof o.geo === "string") {
    const w = num(o.w), h = num(o.h)
    if (w === null || h === null || w < 4 || h < 4) return null
    const cx = clamp(x, 0, CANVAS.w - 4), cy = clamp(y, 0, CANVAS.h - 4)
    return {
      kind: "geo", id, say, geo: pick(o.geo, GEOS, "rectangle"),
      x: cx, y: cy, w: Math.min(w, CANVAS.w - cx), h: Math.min(h, CANVAS.h - cy),
      color, fill: pick(o.fill, FILLS, "solid"), label: typeof o.label === "string" ? o.label.slice(0, 40) : "",
      opacity: opacity(o.opacity),
    }
  }
  return null
}

/** Split streamed text into complete lines; the tail stays buffered. */
export class LineSplitter {
  private buf = ""
  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split("\n")
    this.buf = parts.pop() ?? ""
    return parts
  }
  flush(): string[] {
    const rest = this.buf
    this.buf = ""
    return rest.trim() ? [rest] : []
  }
}
