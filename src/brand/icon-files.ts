import { readFileSync } from "fs"
import { join } from "path"
import { inflateSync } from "zlib"
import { axSymbolAndroidVector, axSymbolPng, axSymbolSvg, BARE, MASKABLE, TILE, type IconStyle } from "./ax-symbol"

// Every icon file checked into the repo, drawn from the AX symbol
// (ax-symbol.ts). `pnpm icons` writes them; test/brand-icons.test.ts fails
// when one no longer matches. The daemon draws its own at runtime.

export interface IconFile {
  path: string
  render: () => Buffer
}

const svg = (path: string, style: IconStyle): IconFile => ({ path, render: () => Buffer.from(axSymbolSvg(style)) })
const png = (path: string, size: number, style: IconStyle): IconFile => ({ path, render: () => axSymbolPng(size, style) })

/** iOS: one opaque full-bleed square per entry in the Flutter app's icon set
 *  (iOS rounds the corners itself and rejects transparency). */
function iosIcons(root: string): IconFile[] {
  const dir = "apps/phone/ios/Runner/Assets.xcassets/AppIcon.appiconset"
  const { images } = JSON.parse(readFileSync(join(root, dir, "Contents.json"), "utf8")) as {
    images: { size: string; scale: string; filename: string }[]
  }
  const seen = new Set<string>()
  return images.filter((i) => !seen.has(i.filename) && seen.add(i.filename)).map((i) => {
    const px = Math.round(parseFloat(i.size) * parseFloat(i.scale))
    return png(`${dir}/${i.filename}`, px, { ...MASKABLE, mark: 0.62 })
  })
}

export function iconFiles(root: string): IconFile[] {
  const androidForeground = (path: string): IconFile => ({ path, render: () => Buffer.from(axSymbolAndroidVector()) })
  return [
    svg("docs/public/agentx-symbol.svg", BARE),
    svg("docs/public/favicon.svg", TILE),
    androidForeground("apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml"),
    androidForeground("apps/phone/android/app/src/main/res/drawable/ic_launcher_foreground.xml"),
    ...iosIcons(root),
    png("apps/mac-helper/Resources/AppIcon.png", 1024, TILE),
    png("integrations/raycast/assets/icon.png", 512, TILE),
  ]
}

/** Same icon: equal bytes, or for PNGs equal size and pixels, so a
 *  different zlib build compressing them differently is not a change. */
export function sameIcon(have: Buffer, want: Buffer): boolean {
  if (have.equals(want)) return true
  const a = pngPixels(have)
  const b = pngPixels(want)
  return !!a && !!b && a.equals(b)
}

function pngPixels(buf: Buffer): Buffer | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let header: Buffer | null = null
  const data: Buffer[] = []
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString("ascii", o + 4, o + 8)
    const body = buf.subarray(o + 8, o + 8 + len)
    if (type === "IHDR") header = body
    if (type === "IDAT") data.push(body)
    o += 12 + len
  }
  return header ? Buffer.concat([header, inflateSync(Buffer.concat(data))]) : null
}
