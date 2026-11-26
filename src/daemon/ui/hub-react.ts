// --- The React Hub's tags in the /hub document (#2218) ---
//
// The daemon still answers /hub: theme boot, pageAllowed(), AX_LOCAL_TOKEN.
// With the React switch on, this adds what the app needs: `window.AX_HUB`
// (the React page ids for this viewer) and the entry's <link> and
// <script type="module">, read from the Vite manifest the build writes to
// dist/web/hub/manifest.json (vite.hub.config.ts). Switch off, or the app
// not built here: nothing is added and the old Hub runs as before.

import { readFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { hubReactPageIds } from "../../hub/pages"
import { hubLayoutSetting, type HubLayoutView } from "../../hub/layout"

export const HUB_ASSET_BASE = "/assets/hub/"
const ENTRY = "main.tsx"

export interface HubSwitch {
  react?: boolean
  legacyPages?: readonly string[]
}

/** Is the React app on for this page load? `?legacy=1` turns it off and
 *  `?react=1` turns it on, for this load only; otherwise the setting, on
 *  unless it is `false` (#2226: no setting at all, as on a fresh install
 *  with no `dashboard` block, opens the React shell too). */
export function hubReactOn(setting: HubSwitch | undefined, search: URLSearchParams): boolean {
  if (search.get("legacy") === "1") return false
  if (search.get("react") === "1") return true
  return setting?.react !== false
}

interface ManifestChunk {
  file: string
  isEntry?: boolean
  css?: string[]
  imports?: string[]
}
export type HubManifest = Record<string, ManifestChunk>

let cached: HubManifest | null | undefined

/** The build's manifest, read once per process; null when not built. */
export function readHubManifest(): HubManifest | null {
  if (cached !== undefined) return cached
  try {
    // dist layout is flat: this module and web/ share a parent (asset-url.ts).
    const here = dirname(fileURLToPath(import.meta.url))
    cached = JSON.parse(readFileSync(resolve(here, "web", "hub", "manifest.json"), "utf8")) as HubManifest
  } catch {
    cached = null
  }
  return cached
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
/** JSON safe inside a <script>: no `</script>` or `<!--` can close it. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")

/** The tags for the /hub document's <head>, or "" when the app is not built. */
export function hubReactHead(opts: { owner: boolean; legacyPages?: readonly string[]; layout?: HubLayoutView }, manifest: HubManifest | null = readHubManifest()): string {
  const entry = manifest?.[ENTRY]
  if (!manifest || !entry?.file) return ""
  const css = new Set<string>()
  const preload = new Set<string>()
  const walk = (key: string, seen: Set<string>) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) return
    for (const c of chunk.css ?? []) css.add(c)
    for (const imp of chunk.imports ?? []) {
      const dep = manifest[imp]
      if (dep?.file) preload.add(dep.file)
      walk(imp, seen)
    }
  }
  walk(ENTRY, new Set())
  const boot = { pages: hubReactPageIds(opts.owner, opts.legacyPages ?? []), owner: opts.owner, ...(opts.layout ? { layout: hubLayoutSetting(opts.layout) } : {}) }
  return [
    // AX_HUB_HASH: the address as it came, before the old script changes
    // it (bare /hub becomes #page=chat), so the app knows where /hub opened.
    `<script>window.AX_HUB = ${scriptJson(boot)};window.AX_HUB_HASH = location.hash;</script>`,
    ...Array.from(css, (f) => `<link rel="stylesheet" href="${attr(HUB_ASSET_BASE + f)}">`),
    ...Array.from(preload, (f) => `<link rel="modulepreload" href="${attr(HUB_ASSET_BASE + f)}">`),
    `<script type="module" src="${attr(HUB_ASSET_BASE + entry.file)}"></script>`,
  ].join("\n")
}

/** The React root, placed first in the Hub's main area. */
export const HUB_REACT_ROOT = `<div id="ax-hub-root"></div>`
