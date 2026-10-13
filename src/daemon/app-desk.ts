import type { IncomingMessage, ServerResponse } from "http"
import { buildDesk, type DeskNode, type DeskSource, type DeskTask } from "@/desk/card"
import { parseDeskAct, type DeskActInput } from "@/desk/act"
import { readJson, summarizeActivity, type NodeReply, type SnapshotNode } from "./app-fleet"

// --- Phone app: the Desk tab (/api/app/desk, #959) ---
//
// Runs behind the device-token check in app-routes.ts, so only a paired
// phone reads it. One desk over every machine the dashboard reads
// approvals from: each machine's sources (desk-panel.ts) joined with the
// running turns of the fleet snapshot. A machine that cannot be read keeps
// its last known cards, marked as not read since then, and none of them
// shows as running.
//
//   GET  /api/app/desk          { ts, cards, figures, errors, quietHours }
//   POST /api/app/desk/act      { node, key, action, option?, text?, agent? }

export interface DeskNodeRead {
  node: string
  nodeName: string
  source?: DeskSource
  error?: string
}

export interface AppDeskDeps {
  snapshot(): Promise<{ ts: string; nodes: SnapshotNode[] }>
  /** Every machine's desk sources: this one read directly, others through
   *  their dashboard. */
  sources(): Promise<DeskNodeRead[]>
  /** Act on the machine the card lives on. `by` names the phone. */
  act(node: string, input: DeskActInput, by: string): Promise<NodeReply>
  quietHours(): number
  now?: () => number
}

/** How long a machine's last good read stands in for it. */
export const LAST_GOOD_MS = 24 * 3_600_000

const lastGood = new Map<string, { source: DeskSource; at: number }>()

export function resetDeskCache(): void {
  lastGood.clear()
}

/** A failed read falls back to the last good one, marked with its time. */
export function withLastGood(read: DeskNodeRead, now: number): DeskNode {
  const key = read.node.replace(/\/+$/, "")
  if (read.source && !read.error) {
    lastGood.set(key, { source: read.source, at: now })
    return { node: read.node, nodeName: read.nodeName, source: read.source }
  }
  const prev = lastGood.get(key)
  if (prev && now - prev.at < LAST_GOOD_MS) {
    return { node: read.node, nodeName: read.nodeName, source: prev.source, error: read.error, staleSince: new Date(prev.at).toISOString() }
  }
  return { node: read.node, nodeName: read.nodeName, source: null, error: read.error ?? "not read" }
}

/** Running turns from machines whose data is live, never a stale copy. */
export function deskTasks(nodes: SnapshotNode[]): DeskTask[] {
  const live = nodes.filter((n) => n.reachable && !n.stale)
  return summarizeActivity(live).map((t) => ({
    node: t.node, nodeName: t.nodeName, taskId: t.taskId, agentId: t.agentId, agentName: t.agentName,
    ...(t.preview ? { preview: t.preview } : {}), startedAt: t.startedAt,
  }))
}

export async function handleAppDesk(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: string,
  deps: AppDeskDeps,
): Promise<boolean> {
  if (method === "GET" && path === "/api/app/desk") {
    const now = deps.now?.() ?? Date.now()
    const [snap, reads] = await Promise.all([
      deps.snapshot().catch(() => ({ ts: new Date(now).toISOString(), nodes: [] as SnapshotNode[] })),
      deps.sources(),
    ])
    const quietHours = deps.quietHours()
    const desk = buildDesk(reads.map((r) => withLastGood(r, now)), deskTasks(snap.nodes), { now, quietHours })
    return json(res, 200, { ts: new Date(now).toISOString(), quietHours, ...desk })
  }

  if (method === "POST" && path === "/api/app/desk/act") {
    let body: Record<string, unknown>
    try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
    const node = typeof body.node === "string" ? body.node.trim() : ""
    if (!node) return json(res, 400, { error: "node is required" })
    const input = parseDeskAct(body)
    if (typeof input === "string") return json(res, 400, { error: input })
    const r = await deps.act(node, input, `operator (phone: ${device})`)
    return json(res, r.status, r.body)
  }
  return false
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
