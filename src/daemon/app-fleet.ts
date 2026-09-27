import type { IncomingMessage, ServerResponse } from "http"

// --- Phone app: fleet, activity and control (/api/app/fleet, …) ---
//
// Phase 3 of the mobile epic. Runs behind the device-token check in
// app-routes.ts, so every handler here may assume a paired phone.
//
// Reads reuse the dashboard's live snapshot (every node the dashboard can
// see, including peers found through /mesh) and trim it to what a phone
// shows: short previews, never full prompts, replies or errors. Writes go
// to a node daemon through the dashboard's allowlisted, token-carrying POST
// (AppFleetDeps.nodePost), the same path the desktop task and restart
// buttons use, so the phone gets no power the dashboard doesn't already have.

export const PREVIEW_CHARS = 160

export interface SnapshotNode {
  id: string
  name: string
  url: string
  reachable: boolean
  error?: string
  uptimeSec?: number
  inflight?: number
  restart?: { state: string; requestedAt?: string; deadline?: string }
  agents: Array<{
    id: string
    name: string
    tier?: string
    active: number
    errors: number
    lastActive?: string
    lastSummary?: { text: string; at: string; ok: boolean }
    runningTasks?: Array<{ id: string; messagePreview: string; channel: string; chatId?: string; sender?: string; startedAt: string }>
  }>
  crons?: Array<{ id: string; enabled: boolean; schedule: string; agent: string; kind?: string; nextRun?: string; consecutiveErrors: number }>
  cronRuns?: Array<{ jobId: string; startedAt: string; status: string; responseSummary?: string; errorSummary?: string; isRetry?: boolean }>
}

export interface ApprovalItem {
  key: string
  title: string
  ask?: string
  recommend?: string
  /** What yes and no do, in words. */
  yes?: string
  no?: string
  raisedBy?: string
  expires?: string
}

export interface NodeApprovals {
  node: string
  nodeName: string
  items: ApprovalItem[]
  error?: string
}

export interface NodeReply { status: number; body: any }

export interface AppFleetDeps {
  snapshot(day?: { date: string; timezone: string }): Promise<{ ts: string; nodes: SnapshotNode[] }>
  /** POST to a node daemon on the dashboard's allowlist, with its token. */
  nodePost(nodeUrl: string, path: string, body: unknown): Promise<NodeReply>
  approvals(): Promise<NodeApprovals[]>
  /** `by` names the phone, e.g. "operator (phone: My phone)". */
  decide(nodeUrl: string, key: string, action: "yes" | "no" | "later", by: string): Promise<NodeReply>
}

export function clip(text: string | undefined, max = PREVIEW_CHARS): string | undefined {
  if (!text) return text
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

/** One node, trimmed for the Fleet tab. Cron outcomes come from the node's
 *  persisted run files (cronRuns), never the scheduler's counters. */
export function summarizeNode(n: SnapshotNode) {
  const lastRun = new Map<string, NonNullable<SnapshotNode["cronRuns"]>[number]>()
  for (const r of n.cronRuns ?? []) {
    const prev = lastRun.get(r.jobId)
    if (!prev || prev.startedAt < r.startedAt) lastRun.set(r.jobId, r)
  }
  const today = { success: 0, failed: 0 }
  for (const r of n.cronRuns ?? []) {
    if (r.status === "success") today.success++
    else today.failed++
  }
  return {
    id: n.id,
    name: n.name,
    url: n.url,
    reachable: n.reachable,
    error: clip(n.error),
    uptimeSec: n.uptimeSec,
    inflight: n.inflight,
    restart: n.restart?.state && n.restart.state !== "none" ? n.restart : undefined,
    agents: n.agents.map((a) => ({
      id: a.id,
      name: a.name,
      tier: a.tier,
      active: a.active,
      errors: a.errors,
      lastActive: a.lastActive,
      last: a.lastSummary ? { text: clip(a.lastSummary.text), at: a.lastSummary.at, ok: a.lastSummary.ok } : undefined,
    })),
    crons: {
      today,
      items: (n.crons ?? []).map((c) => {
        const r = lastRun.get(c.id)
        return {
          id: c.id,
          enabled: c.enabled,
          schedule: c.schedule,
          agent: c.agent,
          nextRun: c.nextRun,
          consecutiveErrors: c.consecutiveErrors,
          last: r ? { status: r.status, at: r.startedAt, text: clip(r.status === "success" ? r.responseSummary : r.errorSummary) } : undefined,
        }
      }),
    },
  }
}

/** Every running task across the fleet, newest first. */
export function summarizeActivity(nodes: SnapshotNode[]) {
  const tasks = []
  for (const n of nodes) {
    for (const a of n.agents) {
      for (const t of a.runningTasks ?? []) {
        tasks.push({
          node: n.url,
          nodeName: n.name,
          agentId: a.id,
          agentName: a.name,
          taskId: t.id,
          preview: clip(t.messagePreview),
          channel: t.channel,
          startedAt: t.startedAt,
        })
      }
    }
  }
  return tasks.sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1))
}

const TASK_ACTION = /^\/api\/app\/tasks\/(cancel|followup)$/

/** Handles /api/app/{fleet,activity,tasks,nodes,crons,approvals}. Returns
 *  false for any other path so the caller can fall through. */
export async function handleAppFleet(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: string,
  deps: AppFleetDeps,
): Promise<boolean> {
  const url = new URL(req.url || path, "http://localhost")

  if (method === "GET" && (path === "/api/app/fleet" || path === "/api/app/activity")) {
    const timezone = validTimezone(url.searchParams.get("timezone"))
    const snap = await deps.snapshot({ date: dateIn(timezone), timezone })
    if (path === "/api/app/activity") return json(res, 200, { ts: snap.ts, tasks: summarizeActivity(snap.nodes) })
    return json(res, 200, { ts: snap.ts, nodes: snap.nodes.map(summarizeNode) })
  }

  if (method === "GET" && path === "/api/app/approvals") {
    return json(res, 200, { nodes: await deps.approvals() })
  }

  if (method !== "POST") return false
  const taskAction = path.match(TASK_ACTION)
  const known = taskAction || [
    "/api/app/nodes/restart", "/api/app/nodes/reload", "/api/app/crons/toggle", "/api/app/approvals/decide",
  ].includes(path)
  if (!known) return false

  let body: Record<string, unknown>
  try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const node = str(body.node)
  if (!node) return json(res, 400, { error: "node is required" })
  const by = `operator (phone: ${device})`

  let reply: NodeReply
  if (taskAction) {
    const taskId = str(body.taskId)
    if (!taskId) return json(res, 400, { error: "taskId is required" })
    const upstream = `/api/tasks/${encodeURIComponent(taskId)}/${taskAction[1]}`
    if (taskAction[1] === "cancel") {
      reply = await deps.nodePost(node, upstream, { reason: `cancelled by ${by}` })
    } else {
      const message = str(body.message)
      if (!message) return json(res, 400, { error: "message is required" })
      reply = await deps.nodePost(node, upstream, { message, sender: by })
    }
  } else if (path === "/api/app/nodes/restart") {
    reply = await deps.nodePost(node, body.cancel === true ? "/daemon/restart/cancel" : "/daemon/restart", {})
  } else if (path === "/api/app/nodes/reload") {
    reply = await deps.nodePost(node, "/reload", {})
  } else if (path === "/api/app/crons/toggle") {
    const cronId = str(body.cronId)
    if (!cronId || typeof body.enabled !== "boolean") return json(res, 400, { error: "cronId and enabled (true or false) are required" })
    reply = await deps.nodePost(node, `/crons/${encodeURIComponent(cronId)}/enabled`, { enabled: body.enabled })
  } else {
    const key = str(body.key)
    const action = body.action
    if (!key || (action !== "yes" && action !== "no" && action !== "later")) {
      return json(res, 400, { error: "key and action (yes, no or later) are required" })
    }
    reply = await deps.decide(node, key, action, by)
  }
  return json(res, reply.status, reply.body)
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function validTimezone(tz: string | null): string {
  if (!tz) return "UTC"
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz } catch { return "UTC" }
}

/** YYYY-MM-DD for "today" in the phone's time zone. */
export function dateIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object")
  return parsed
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
