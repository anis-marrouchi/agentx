// --- GET /api/app/requests?agent=<id> (#2101 phone C1) ---
//
// What the phone Chat's Plan and Proofs tabs read: the open requests of
// the agent in view, the ones it has or has a step in, with their steps.
// The same cards the Hub chat header reads (wall-chat-head.client.ts, from
// GET /api/admin/approvals/requests), behind the device-token check in
// app-routes.ts. Read only: a step's name, state and proof link, the
// request's summary and state; nothing the phone could act on.

import type { IncomingMessage, ServerResponse } from "http"

export const APP_REQUESTS_PATH = "/api/app/requests"

/** One step, as the phone shows it. */
export interface AppReqStep { idx: number; name: string; agentId?: string; state?: string; evidence?: string | null }

/** One request, as the phone shows it. */
export interface AppReq { id: string; agentId?: string; summary?: string; state?: string; steps: AppReqStep[] }

export interface AppRequestsDeps {
  /** The open request cards of this node (requests-panel.ts GET items). */
  cards(): Promise<unknown[]>
}

const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/

/** The requests the agent has, or has a step in, cut down to what the phone shows. */
export function appRequestsFor(cards: unknown[], agent: string): AppReq[] {
  const out: AppReq[] = []
  for (const c of cards || []) {
    const r = c as { id?: unknown; agentId?: unknown; summary?: unknown; state?: unknown; plan?: { steps?: unknown[] } | null }
    if (!r || typeof r.id !== "string") continue
    const steps: AppReqStep[] = []
    for (const s of (r.plan && Array.isArray(r.plan.steps) ? r.plan.steps : []) as Array<Record<string, unknown>>) {
      if (!s || typeof s.name !== "string") continue
      steps.push({
        idx: Number(s.idx) || steps.length + 1,
        name: s.name,
        ...(typeof s.agentId === "string" ? { agentId: s.agentId } : {}),
        ...(typeof s.state === "string" ? { state: s.state } : {}),
        evidence: typeof s.evidence === "string" ? s.evidence : null,
      })
    }
    if (r.agentId !== agent && !steps.some((s) => s.agentId === agent)) continue
    out.push({
      id: r.id,
      ...(typeof r.agentId === "string" ? { agentId: r.agentId } : {}),
      ...(typeof r.summary === "string" ? { summary: r.summary.slice(0, 300) } : {}),
      ...(typeof r.state === "string" ? { state: r.state } : {}),
      steps,
    })
  }
  return out
}

/** Handles GET /api/app/requests. Returns false for any other path. */
export async function handleAppRequests(req: IncomingMessage, res: ServerResponse, path: string, method: string, deps: AppRequestsDeps): Promise<boolean> {
  if (path !== APP_REQUESTS_PATH) return false
  if (method !== "GET") return reply(res, 405, { error: "GET" })
  const agent = new URL(req.url ?? "", "http://x").searchParams.get("agent") || ""
  if (!AGENT_RE.test(agent)) return reply(res, 400, { error: "send ?agent=<agent id>" })
  try {
    return reply(res, 200, { items: appRequestsFor(await deps.cards(), agent) })
  } catch (e: any) {
    return reply(res, 503, { error: `The requests could not be read: ${String(e?.message ?? e).slice(0, 200)}` })
  }
}

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
