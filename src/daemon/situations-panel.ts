import type { IncomingMessage, ServerResponse } from "http"

// --- Situations on the dashboard (#1892 phase 2) ---
//
//   GET  /api/admin/situations?agent=<id>     → daemon GET /situations
//   POST /api/admin/situations/override       → daemon POST /situations/override
//
// The dashboard runs beside the daemon and calls it over loopback (the
// daemon's mesh gate lets this machine in; dashboard.daemonUrl must be
// loopback, else a clear 503), so only the owner may use these routes: the caller must
// pass the dashboard's owner check (token, signed-in session, or a caller
// on this machine). The override is labelled as the owner's from the
// dashboard; a label the browser sends is ignored.

export interface SituationsPanelCtx {
  daemonUrl: string
  token: string
  /** The caller passed the dashboard's owner check. */
  owner: boolean
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>
  fetch?: typeof fetch
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

/** The daemon URL names this machine (127.0.0.0/8, ::1, localhost). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "")
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h)
  } catch {
    return false
  }
}

/** True when the path was one of these routes (answered here). */
export async function handleSituationsPanel(
  req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, ctx: SituationsPanelCtx,
): Promise<boolean> {
  const method = req.method || "GET"
  const list = method === "GET" && path === "/api/admin/situations"
  const override = method === "POST" && path === "/api/admin/situations/override"
  if (!list && !override) return false
  if (!ctx.owner) { send(res, 401, { error: "unauthorized" }); return true }
  // The daemon's /situations routes are mesh-gated: it lets this machine
  // in, and it does not take dashboard.token as a mesh token. So these
  // routes work only when dashboard.daemonUrl is this machine; say so
  // instead of failing with a 401, and send no token off the box.
  if (!isLoopbackUrl(ctx.daemonUrl)) {
    send(res, 503, { error: `situations need the daemon on the same machine as the dashboard; dashboard.daemonUrl is ${ctx.daemonUrl}` })
    return true
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`
  const base = ctx.daemonUrl.replace(/\/+$/, "")
  const doFetch = ctx.fetch ?? fetch
  try {
    let r: Response
    if (list) {
      const q = new URLSearchParams()
      for (const k of ["agent", "phase", "limit"]) { const v = query.get(k); if (v) q.set(k, v) }
      r = await doFetch(`${base}/situations${q.size ? `?${q}` : ""}`, { headers, signal: AbortSignal.timeout(10_000) })
    } else {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))
      r = await doFetch(`${base}/situations/override`, {
        method: "POST", headers, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ id: body.id, action: body.action, by: "owner (dashboard)" }),
      })
    }
    send(res, r.status, await r.json().catch(() => ({ error: `HTTP ${r.status}` })))
  } catch (e: any) {
    send(res, 502, { error: "daemon unreachable", message: e?.message || String(e) })
  }
  return true
}
