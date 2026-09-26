import type { IncomingHttpHeaders } from "http"

// --- Browser-origin guard for the daemon and dashboard HTTP servers ---
//
// Both servers trust loopback callers, and a browser on the same machine is
// a loopback caller. So any web page open in that browser could make it call
// these servers: send an agent a task, write agent memory, post to a channel.
// Neither server has a cross-origin browser client (dashboard pages call the
// dashboard; daemon pages call the daemon; everything else is curl, the CLI,
// native apps or server-to-server, none of which send Origin), so a request
// the browser marks as coming from another origin is not trusted.
//
// Pure functions, unit tested; the servers add the 403 and the logging.

export type BrowserOrigin =
  /** No browser origin marker: curl, CLI, native apps, servers. */
  | "none"
  /** A page served by this same server. */
  | "same-origin"
  /** A page from any other origin, including another port on this host. */
  | "foreign"

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? ""
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    // Opaque origins ("null": sandboxed iframes, file://) never match.
    return null
  }
}

/** Extra trusted origins, for a dashboard served through a reverse proxy
 *  under another host name. Comma-separated full origins. */
export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.AGENTX_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  )
}

export function classifyBrowserRequest(
  headers: IncomingHttpHeaders,
  extraAllowed: ReadonlySet<string> = allowedOriginsFromEnv(),
): BrowserOrigin {
  const origin = first(headers.origin)
  if (origin) {
    if (extraAllowed.has(origin.replace(/\/+$/, "").toLowerCase())) return "same-origin"
    const from = originHost(origin)
    const hosts = [first(headers.host), first(headers["x-forwarded-host"])]
      .filter(Boolean)
      .map((h) => h.toLowerCase())
    return from && hosts.includes(from) ? "same-origin" : "foreign"
  }
  // Browsers omit Origin on plain GET navigations and image loads, but
  // modern ones still say where the request came from. localhost on
  // another port is "same-site", and it is still someone else's page.
  const site = first(headers["sec-fetch-site"]).toLowerCase()
  if (site === "cross-site" || site === "same-site") return "foreign"
  return "none"
}

/** Methods that change state, plus the CORS preflight that precedes a
 *  cross-origin write. A foreign page gets none of these. */
export function isStateChangingOrPreflight(method: string | undefined): boolean {
  const m = (method || "GET").toUpperCase()
  return m !== "GET" && m !== "HEAD"
}
