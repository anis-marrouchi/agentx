import { existsSync, readFileSync } from "fs"
import { planStoreFor, requestStoreFor, type InboxContext } from "@/approvals/inbox"
import { requestCard } from "@/requests/card-view"
import { readRequestSettings, updateRequestSettings, type RequestSettingsPatch } from "@/requests/settings"
import { findConfigPath } from "./config-mutator"

// --- Dashboard API for open requests (#356) ---
//
// Lives under the Approvals admin prefix, so it sits behind the same token
// gate and the same X-Requested-With check (approvals-panel.ts):
//   GET  /api/admin/approvals/requests           open requests as cards, oldest first, this node's agents, and the settings
//   POST /api/admin/approvals/requests/close     { id, action: done | drop, evidence?, reason? }
//   POST /api/admin/approvals/requests/reply     { id, text }: the agent that has it gets the reply and goes on
//   POST /api/admin/approvals/requests/handoff   { id, agentId, note? }: that agent has it from now on
//   POST /api/admin/approvals/requests/settings  the settings form, plans included (#788)
// An owner surface: it can drop a request, which agents cannot.

export const REQUESTS_PANEL_PREFIX = "/api/admin/approvals/requests"

/** This node's agents, for the hand-off choice. */
function agentsOf(configPath?: string): Array<{ id: string; name: string }> {
  const path = findConfigPath(configPath)
  if (!existsSync(path)) return []
  try {
    const agents = JSON.parse(readFileSync(path, "utf-8"))?.agents ?? {}
    return Object.entries<any>(agents).map(([id, a]) => ({ id, name: typeof a?.name === "string" && a.name ? a.name : id }))
  } catch {
    return []
  }
}

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
    return {
      status: 200,
      body: {
        items: store ? store.listOpen().map((r) => requestCard(r, store, planStoreFor(ctx))) : [],
        agents: agentsOf(ctx.configPath),
        settings: readRequestSettings(ctx.configPath),
      },
    }
  }

  const act = path === `${REQUESTS_PANEL_PREFIX}/reply` ? "reply" : path === `${REQUESTS_PANEL_PREFIX}/handoff` ? "handoff" : null
  if (method === "POST" && act) {
    const id = typeof body.id === "string" ? body.id : ""
    const note = (act === "reply" ? body.text : body.note)
    const text = typeof note === "string" ? note.trim() : ""
    if (!id || (act === "reply" && !text)) return { status: 400, body: { error: act === "reply" ? "send { id, text }" : "send { id, agentId, note? }" } }
    const store = requestStoreFor(ctx)
    const r = store?.get(id)
    if (!store || !r || r.state === "candidate") return { status: 404, body: { error: `no request "${id}"` } }
    const agentId = act === "reply" ? r.agentId : typeof body.agentId === "string" ? body.agentId : ""
    const agent = agentsOf(ctx.configPath).find((a) => a.id === agentId)
    if (act === "handoff" && !agent) return { status: 400, body: { error: `"${agentId}" is not an agent on this node` } }
    // The agent is told by the daemon's requests check, which is off with the feature.
    if (!readRequestSettings(ctx.configPath).enabled) {
      return { status: 409, body: { error: "Requests are off, so nothing would tell the agent. Turn them on in the settings below." } }
    }
    if (!store.handOff(id, agentId, text, ctx.now ?? Date.now())) return { status: 409, body: { error: `${id} is already closed` } }
    const who = agent?.name ?? agentId
    return { status: 200, body: { ok: true, message: act === "reply" ? `Reply sent: ${who} will go on with ${id}` : `${who} has ${id} now and will be told within a minute` } }
  }

  if (method === "POST" && path === `${REQUESTS_PANEL_PREFIX}/close`) {
    const id = typeof body.id === "string" ? body.id : ""
    const action = body.action
    if (!id || (action !== "done" && action !== "drop")) return { status: 400, body: { error: "send { id, action: done | drop }" } }
    const store = requestStoreFor(ctx)
    const r = store?.get(id)
    if (!store || !r || r.state === "candidate") return { status: 404, body: { error: `no request "${id}"` } }
    // The owner's own word closes it: a link to the evidence is welcome, not required (agents must give one).
    const detail = action === "done"
      ? (typeof body.evidence === "string" && body.evidence.trim() ? body.evidence : "closed by the owner (dashboard)")
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
    const plans: NonNullable<RequestSettingsPatch["plans"]> = {}
    if (typeof body.plansEnabled === "boolean") plans.enabled = body.plansEnabled
    plans.stallMinutes = num("stallMinutes")
    if (body.maxNudges !== undefined) {
      if (typeof body.maxNudges !== "number" || !Number.isInteger(body.maxNudges) || body.maxNudges < 0) throw new Error("maxNudges must be a whole number, 0 or more")
      plans.maxNudges = body.maxNudges
    }
    plans.approveKinds = list(body.approveKinds)
    plans.disabledAgents = list(body.plansOffFor)
    if (Object.values(plans).some((v) => v !== undefined)) patch.plans = plans
    const r = await updateRequestSettings(patch, { configPath: ctx.configPath, reload: ctx.reload })
    if (!r.success) return { status: 400, body: { error: r.error } }
    return { status: 200, body: { ok: true, settings: readRequestSettings(ctx.configPath) } }
  }

  return { status: 404, body: { error: "Not found" } }
}
