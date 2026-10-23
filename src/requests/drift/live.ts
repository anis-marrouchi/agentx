import { readFileSync } from "fs"
import type { DaemonConfig } from "@/daemon/config"
import type { ForgeConnectors } from "../checkers/issue"
import type { LiveCommit } from "./check"

// --- Where status drift reads (#1138 step F) ---
//
// The running commit of a `live` source, and the forge connectors, set up
// the same way as the issue checker's (requests.checkers.github/gitlab,
// else the channels').

const TIMEOUT_MS = 10_000
const COMMIT_RE = /^[0-9a-f]{7,64}$/i

/** Reads a `live` source: "self" is `self`'s answer, a URL is fetched
 *  and its JSON `field` ("commit", or a dotted path) read. */
export function liveReader(opts: { field: string; self: () => string | null; fetch?: typeof fetch }): (source: string) => Promise<LiveCommit> {
  const doFetch = opts.fetch ?? fetch
  return async (source) => {
    if (source === "self") {
      const commit = opts.self()
      return commit && COMMIT_RE.test(commit) ? { source, commit } : { source, commit: null, error: "this build does not carry its commit (run from source?)" }
    }
    let res: Response
    try {
      res = await doFetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { source, commit: null, error: `could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
    }
    if (!res.ok) return { source, commit: null, error: `HTTP ${res.status}` }
    const body: any = await res.json().catch(() => null)
    const value = opts.field.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), body)
    return typeof value === "string" && COMMIT_RE.test(value.trim())
      ? { source, commit: value.trim() }
      : { source, commit: null, error: `no commit under "${opts.field}"` }
  }
}

/** The connectors the requests checks use, from the daemon's config. */
export function forgeConnectorsOf(config: Pick<DaemonConfig, "channels" | "requests">): ForgeConnectors {
  const settings = config.requests.checkers
  const gh = config.channels.github
  let ghToken = settings?.github?.token ?? gh?.token
  if (!ghToken && gh?.tokenFile) {
    try { ghToken = readFileSync(gh.tokenFile, "utf-8").trim().split("\n")[0].trim() || undefined } catch { /* no token: public reads only */ }
  }
  const gl = config.channels.gitlab
  return {
    github: { apiUrl: settings?.github?.apiUrl ?? "https://api.github.com", token: ghToken },
    gitlab: { url: settings?.gitlab?.url ?? gl?.host ?? "https://gitlab.com", token: settings?.gitlab?.token ?? gl?.token },
  }
}
