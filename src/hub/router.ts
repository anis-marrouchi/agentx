// --- The Hub's hash router (#2218 part 1) ---
//
// The Hub's addresses stay what they are: `/hub#page=jobledger`,
// `#status=open&view=decide`, `#page=workflows&w-open=<id>`. A hash is a
// key=value list, not a path, so no library hash router fits; this one file
// reads and writes that list. Pure functions first (tested in
// test/hub-router.test.ts), then the React hook.

import { useEffect, useState } from "react"

/** The hash as key=value pairs. A leading `#` is fine. */
export function parseHash(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""))
}

/** The `#page=` id; the feed (no page) is "wall", as in the old Hub. */
export function hashPage(params: URLSearchParams): string {
  return params.get("page") || "wall"
}

/** A hash from key=value pairs, empty values dropped, order kept. */
export function buildHash(params: Record<string, string | null | undefined> | URLSearchParams): string {
  const q = new URLSearchParams()
  const entries = params instanceof URLSearchParams ? Array.from(params.entries()) : Object.entries(params)
  for (const [k, v] of entries) if (v != null && v !== "") q.set(k, v)
  const s = q.toString()
  return s ? "#" + s : ""
}

/** The page React draws for this hash, or null when the old Hub draws it. */
export function reactPageFor(params: URLSearchParams, reactPages: readonly string[]): string | null {
  const page = hashPage(params)
  return reactPages.includes(page) ? page : null
}

/** Opens a hash. The old Hub listens to the same `hashchange`. */
export function navigate(params: Record<string, string | null | undefined>): void {
  location.hash = buildHash(params)
}

/** The current hash, kept up to date. */
export function useHashParams(): URLSearchParams {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return parseHash(hash)
}
