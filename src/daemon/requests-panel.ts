import { requestStoreFor, type InboxContext } from "@/approvals/inbox"
import { readRequestSettings, updateRequestSettings, type RequestSettingsPatch } from "@/requests/settings"

// --- Dashboard API for open requests (#356) ---
//
// Lives under the Approvals admin prefix, so it sits behind the same token
// gate and the same X-Requested-With check (approvals-panel.ts):
//   GET  /api/admin/approvals/requests           open requests, oldest first, and the settings
//   POST /api/admin/approvals/requests/close     { id, action: done | drop, evidence?, reason? }
//   POST /api/admin/approvals/requests/settings  the settings form
// An owner surface: it can drop a request, which agents cannot.

export const REQUESTS_PANEL_PREFIX = "/api/admin/approvals/requests"

const list = (v: unknown): string[] | undefined =>
  typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined

export async function handleRequestsPanel(
  method: string,
  path: string,
  body: Record<string, unknown>,
  ctx: InboxContext,
): Promise<{ status: number; body: unknown }> {
  try {
    return await route(method, path, body, ctx)
  } catch (e: any) {
    return { status: 400, body: { error: String(e?.message ?? e).slice(0, 300) } }
  }
}

async function route(
  method: string,
  path: string,
  body: Record<string, unknown>,
  ctx: InboxContext,
): Promise<{ status: number; body: unknown }> {
  if (method === "GET" && path === REQUESTS_PANEL_PREFIX) {
    const store = requestStoreFor(ctx)
    return { status: 200, body: { items: store ? store.listOpen() : [], settings: readRequestSettings(ctx.configPath) } }
  }

  if (method === "POST" && path === `${REQUESTS_PANEL_PREFIX}/close`) {
    const id = typeof body.id === "string" ? body.id : ""
    const action = body.action
    if (!id || (action !== "done" && action !== "drop")) return { status: 400, body: { error: "send { id, action: done | drop }" } }
    const store = requestStoreFor(ctx)
    const r = store?.get(id)
    if (!store || !r || r.state === "candidate") return { status: 404, body: { error: `no request "${id}"` } }
    const detail = action === "done"
      ? (typeof body.evidence === "string" ? body.evidence : "")
      : (typeof body.reason === "string" && body.reason.trim() ? body.reason : "dropped by the owner (dashboard)")
    if (!store.close(id, action === "done" ? "done" : "dropped", detail, ctx.now ?? Date.now())) {
      return { status: 409, body: { error: `${id} is already closed` } }
    }
    return { status: 200, body: { ok: true, message: action === "done" ? `${id} closed as done` : `${id} dropped` } }
  }

  if (method === "POST" && path === `${REQUESTS_PANEL_PREFIX}/settings`) {
    const patch: RequestSettingsPatch = {}
    const num = (k: string) => {
      const v = body[k]
      if (v === undefined) return undefined
      if (typeof v !== "number" || !(v > 0)) throw new Error(`${k} must be a positive number`)
      return v
    }
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled
    patch.from = list(body.from)
    patch.channels = list(body.channels)
    patch.staleAfterHours = num("staleAfterHours")
    patch.retentionDays = num("retentionDays")
    const r = await updateRequestSettings(patch, { configPath: ctx.configPath, reload: ctx.reload })
    if (!r.success) return { status: 400, body: { error: r.error } }
    return { status: 200, body: { ok: true, settings: readRequestSettings(ctx.configPath) } }
  }

  return { status: 404, body: { error: "Not found" } }
}
