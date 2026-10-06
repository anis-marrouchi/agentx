// --- The AX symbol ---
//
// The one source for every AgentX icon (#686): the mark in the README,
// docs/public/agentx-symbol.png, traced into four straight-edged shapes on
// that file's 1254×1254 canvas (y down). The daemon draws its PNGs from
// these points at runtime (app-icon.ts), and scripts/gen-icons.ts writes
// the Android, iOS, Mac and Raycast icons from them. Change the mark here
// and rerun the script; don't edit a generated icon by hand.

export type Point = readonly [number, number]

export const AX_SYMBOL_SHAPES: readonly (readonly Point[])[] = [
  // The long stroke of the X, top left to bottom right, rounded at both ends.
  [[441, 393], [600, 393], [614, 396], [625, 401], [634, 410], [1028, 940], [846, 940], [833, 937], [823, 931], [818, 925], [440, 414], [435, 406], [436, 398]],
  // The X's upper right arm.
  [[893, 393], [1079, 393], [861, 653], [771, 535]],
  // The A's left leg.
  [[413, 439], [510, 574], [282, 874], [100, 874]],
  // The A's crossbar, pointing down into the X.
  [[451, 709], [610, 709], [615, 712], [698, 824], [599, 939], [447, 719], [446, 713]],
]

/** The symbol's bounding box on the source canvas. */
export const AX_SYMBOL_BOX = { x: 100, y: 393, width: 979, height: 547 }

export const AX_INK = "#1a1a18"
export const AX_PAPER = "#ffffff"

/**
 * How wide the symbol sits on an icon, as a fraction of the icon's side.
 * `full` fills a square that is shown whole (favicon, iOS, Raycast).
 * `safe` keeps every corner of the symbol inside a circle of radius 0.37,
 * so it survives a maskable or launcher crop to a circle. `android` fits the
 * adaptive icon's 66dp safe zone on its 108dp canvas, with a margin. `mac`
 * fits the 824px rounded square Apple's template puts on a 1024px canvas.
 */
const HALF_DIAGONAL = Math.hypot(AX_SYMBOL_BOX.width, AX_SYMBOL_BOX.height) / 2 / AX_SYMBOL_BOX.width
export const AX_LAYOUT = {
  full: 0.74,
  safe: 0.37 / HALF_DIAGONAL,
  android: 0.29 / HALF_DIAGONAL,
  mac: 0.6,
} as const

/** The shapes moved onto a `size`-wide square, centred, `width` of it wide. */
export function axSymbolShapes(size: number, width: number): Point[][] {
  const k = (size * width) / AX_SYMBOL_BOX.width
  const dx = size / 2 - (AX_SYMBOL_BOX.x + AX_SYMBOL_BOX.width / 2) * k
  const dy = size / 2 - (AX_SYMBOL_BOX.y + AX_SYMBOL_BOX.height / 2) * k
  return AX_SYMBOL_SHAPES.map((shape) => shape.map(([x, y]) => [x * k + dx, y * k + dy] as Point))
}

/** SVG path data (also valid Android pathData) for the placed symbol. */
export function axSymbolPathData(size: number, width: number): string {
  const n = (v: number) => String(Math.round(v * 100) / 100)
  return axSymbolShapes(size, width)
    .map((shape) => "M" + shape.map(([x, y]) => `${n(x)},${n(y)}`).join("L") + "Z")
    .join("")
}

/** A square SVG icon: dark symbol on a white square, rounded like the PNGs. */
export function axIconSvg(size = 64, width: number = AX_LAYOUT.full): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${size * 0.18}" fill="${AX_PAPER}"/>` +
    `<path fill="${AX_INK}" d="${axSymbolPathData(size, width)}"/></svg>`
}
