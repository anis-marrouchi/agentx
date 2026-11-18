import type { IncomingMessage, ServerResponse } from "http"

// --- Situations on the dashboard (#1892 phase 2) ---
//
//   GET  /api/admin/situations?agent=<id>     → daemon GET /situations
//   POST /api/admin/situations/override       → daemon POST /situations/override
//
// The dashboard runs beside the daemon and calls it over loopback with the
// node's own token, so only the owner may use these routes: the caller must
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

/** True when the path was one of these routes (answered here). */
export async function handleSituationsPanel(
  req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, ctx: SituationsPanelCtx,
): Promise<boolean> {
  const method = req.method || "GET"
  const list = method === "GET" && path === "/api/admin/situations"
  const override = method === "POST" && path === "/api/admin/situations/override"
  if (!list && !override) return false
  if (!ctx.owner) { send(res, 401, { error: "unauthorized" }); return true }
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
