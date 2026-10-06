import { axSymbolPng, axSymbolSvg, MASKABLE, TILE } from "@/brand/ax-symbol"

// --- Phone app, member page and dashboard icons ---
//
// Home screens need PNGs (iOS ignores SVG touch icons, and Chrome wants a
// 192 and a 512 for installability). Drawn here from the AX symbol rather
// than shipped as binary files so the zero-build dashboard stays text-only:
// a full-bleed white square (safe for "maskable" crops) with the mark
// inside the central safe zone. Browser tabs get the mark as an SVG tile.

export function appIconPng(size: number): Buffer {
  return axSymbolPng(size, MASKABLE)
}

export const FAVICON_SVG = axSymbolSvg(TILE)
