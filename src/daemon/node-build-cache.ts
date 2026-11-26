// --- The daemon's build, kept by the dashboard (#2101, Hub bar version) ---
//
// GET /api/node/build feeds the version on every page (top bar, Wall build
// line, Hub status bar). The dashboard asks the daemon's /health for it with
// a short timeout. While a Hub page loads, the dashboard's event loop can be
// busy for several seconds, so that one ask timed out on every try and the
// bar never showed a version (Anis, 2026-11-26).
//
// So the dashboard keeps the last good answer: it asks once at start, serves
// a recent answer without asking again, and when an ask fails it serves the
// last good one marked with the time it was read (asOf). Only when it has
// never had an answer does the route fail.

import { headerBuild } from "./topbar"

export type HeaderBuild = ReturnType<typeof headerBuild>
export type BuildAnswer = { status: 200; body: HeaderBuild & { asOf?: string } } | { status: 502; body: { error: string } }

/** A recent answer is served as it is, without asking the daemon. */
export const BUILD_FRESH_MS = 30_000
/** How long one ask of the daemon's /health may take. */
export const BUILD_ASK_TIMEOUT_MS = 3_000

export class NodeBuildCache {
  private last: { build: HeaderBuild; at: number } | null = null
  private asking: Promise<BuildAnswer> | null = null

  constructor(
    private readonly askHealth: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The answer for GET /api/node/build. Asks at most once at a time. */
  get(): Promise<BuildAnswer> {
    const last = this.last
    if (last && this.now() - last.at < BUILD_FRESH_MS) return Promise.resolve({ status: 200, body: last.build })
    if (!this.asking) this.asking = this.ask().finally(() => { this.asking = null })
    return this.asking
  }

  private async ask(): Promise<BuildAnswer> {
    try {
      const build = headerBuild(await this.askHealth())
      if (!build.version) throw new Error("no version in /health")
      this.last = { build, at: this.now() }
      return { status: 200, body: build }
    } catch (e: unknown) {
      if (this.last) return { status: 200, body: { ...this.last.build, asOf: new Date(this.last.at).toISOString() } }
      return { status: 502, body: { error: e instanceof Error && e.message ? e.message : "daemon not reachable" } }
    }
  }
}

/** Ask the daemon's GET /health, with the dashboard's own credential. */
export function daemonHealthAsker(daemonUrl: string, token: string | undefined): () => Promise<unknown> {
  return async () => {
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    const r = await fetch(daemonUrl.replace(/\/+$/, "") + "/health", { headers, signal: AbortSignal.timeout(BUILD_ASK_TIMEOUT_MS) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }
}

// One cache per dashboard config: the running dashboard has one, and each
// test that builds its own config starts empty.
const caches = new WeakMap<object, NodeBuildCache>()

export function nodeBuildCacheFor(config: { dashboard: { daemonUrl: string; token?: string } }): NodeBuildCache {
  let c = caches.get(config)
  if (!c) {
    c = new NodeBuildCache(daemonHealthAsker(config.dashboard.daemonUrl, config.dashboard.token))
    caches.set(config, c)
  }
  return c
}
