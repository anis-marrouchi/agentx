// --- Cache-busted URLs for the browser bundles ----------------------------
//
// /assets/* is served with `max-age=60`, which is right for the file but
// wrong for a deploy: a browser that fetched the bundle a minute ago is
// entitled to keep it, and in practice people sat on a stale editor across
// several deploys without knowing it. Appending a content hash gives the
// bundle a new URL whenever its bytes change, so a deploy invalidates itself
// and an unchanged bundle still caches.
//
// The hash is read once per process and cached: this runs on every page
// render, and the file cannot change under a running daemon without a
// restart bringing a fresh process anyway.

import { createHash } from "crypto"
import { readFileSync, statSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const cache = new Map<string, string>()

/** `/assets/<name>?v=<hash>` — falls back to the bare path when the bundle
 *  is missing, so a page still renders (and 404s the script) rather than
 *  throwing during SSR. */
export function assetUrl(name: string): string {
  const hit = cache.get(name)
  if (hit) return hit
  let url = `/assets/${name}`
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist layout is flat: this module and web/ share a parent.
    const file = resolve(here, "web", name)
    const stat = statSync(file)
    // Hash the bytes for files small enough to read cheaply; fall back to
    // size+mtime for anything unexpectedly large.
    const tag = stat.size < 8_000_000
      ? createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 10)
      : `${stat.size}-${Math.floor(stat.mtimeMs)}`
    url = `/assets/${name}?v=${tag}`
  } catch { /* bundle not built here — serve the bare path */ }
  cache.set(name, url)
  return url
}
