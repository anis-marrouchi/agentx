import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { renderActivityGraphPage } from "./ui/pages/activity-graph"
import type { TopbarPeer } from "./topbar"

// --- /admin/activity-graph — Activity perspective lens ---
//
// A live graph over the intent ledger that re-roots from any node's
// perspective. The same data graph (clients, projects, subjects,
// agents, channels, initiators) is re-projected depending on what
// you click — the operator picks the lens, not the layout.
//
// Snapshot-driven for Phase 1 (refresh button); SSE live updates can
// come in Phase 2 once we know the layout works.

interface OpenedDb { db: Database.Database; close: () => void }

function openLedger(): OpenedDb | null {
  const path = resolve(process.cwd(), ".agentx/intent/ledger.sqlite")
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    return { db, close: () => db.close() }
  } catch { return null }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export function handleActivityGraphGet(_req: IncomingMessage, res: ServerResponse, peers: TopbarPeer[] = []): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderActivityGraphPage({ peers }))
}

// ---------------------------------------------------------------------------

export type NodeType = "client" | "project" | "subject" | "agent" | "channel" | "initiator"

export interface GraphNode {
  id: string                    // typed key, e.g. "client:mtgl"
  type: NodeType
  label: string
  sub?: string                  // secondary line (e.g. "12 active")
  count?: number                // active edge count
  data?: Record<string, unknown>
}
export interface GraphEdge {
  id: string
  from: string
  to: string
  kind: "contains" | "arrives" | "starts" | "dispatches" | "a2a" | "resolves"
  active: boolean               // pulsing if true
  startedAt?: number
  resolvedAt?: number
  preview?: string              // shown on hover
  outcome?: string              // dispatched | halted | deduped | error
}
export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
  root: string | null            // typed key of selected root, or null for "All"
  rootMeta?: { type: NodeType; label: string }
  windowMs: number
  ts: number
}

interface LedgerEvent {
  id: string
  ts: number
  source: string
  project: string | null
  subject: string | null
  intent: string | null
  raw_json: string
}
interface LedgerDecision {
  event_id: string
  decided_at: number
  decided_by: string
  agent_id: string | null
  outcome: string
  reason: string | null
}
interface LedgerResolution {
  decision_event_id: string
  decision_decided_by: string
  resolved_at: number
  status: string
  duration_ms: number | null
  result_summary: string | null
}

// Heuristic: derive a "client" from a project path. Format "<group>/<repo>"
// → client = group. Falls back to "internal" for events with no project.
function clientFromProject(project: string | null | undefined): string {
  if (!project) return "internal"
  const slash = project.indexOf("/")
  return slash > 0 ? project.slice(0, slash) : project
}

// Pull a sender / initiator name out of the source-specific raw payload.
// Best-effort: GitLab uses user.name, Telegram uses from.username,
// generic webhooks fall through to source-event-id. Returns null when
// no human is implicated (mesh, cron, workflow).
function initiatorFrom(source: string, raw: any): { username: string; label: string } | null {
  if (!raw || typeof raw !== "object") return null
  if (source === "gitlab") {
    const u = raw.payload?.user || raw.user
    if (u?.username || u?.name) return { username: u.username || u.name, label: u.name || u.username }
  }
  if (source === "github") {
    const u = raw.payload?.sender || raw.sender || raw.payload?.user
    if (u?.login) return { username: u.login, label: u.login }
  }
  if (source === "telegram") {
    const f = raw.from || raw.payload?.from
    if (f?.username) return { username: f.username, label: f.first_name || f.username }
    if (f?.id) return { username: String(f.id), label: f.first_name || `tg:${f.id}` }
  }
  if (source === "whatsapp") {
    const j = raw.from || raw.payload?.from
    if (j) return { username: String(j), label: String(j).replace(/@.*$/, "") }
  }
  return null
}

interface Aggregated {
  events: Map<string, LedgerEvent>
  decisionsByEvent: Map<string, LedgerDecision[]>
  resolutionsByDecision: Map<string, LedgerResolution>      // key = event_id|decided_by
}

function loadAggregated(db: Database.Database, sinceMs: number): Aggregated {
  const events = new Map<string, LedgerEvent>()
  const decisionsByEvent = new Map<string, LedgerDecision[]>()
  const resolutionsByDecision = new Map<string, LedgerResolution>()

  const eventRows = db.prepare(`
    SELECT id, ts, source, project, subject, intent, raw_json
    FROM intent_events WHERE ts >= ? ORDER BY ts ASC
  `).all(sinceMs) as LedgerEvent[]
  for (const e of eventRows) events.set(e.id, e)

  if (events.size === 0) return { events, decisionsByEvent, resolutionsByDecision }

  const ids = [...events.keys()]
  const placeholders = ids.map((_, i) => `@id${i}`).join(",")
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]))

  const decisionRows = db.prepare(`
    SELECT event_id, decided_at, decided_by, agent_id, outcome, reason
    FROM intent_decisions WHERE event_id IN (${placeholders}) ORDER BY decided_at ASC
  `).all(params) as LedgerDecision[]
  for (const d of decisionRows) {
    if (!decisionsByEvent.has(d.event_id)) decisionsByEvent.set(d.event_id, [])
    decisionsByEvent.get(d.event_id)!.push(d)
  }

  const resolutionRows = db.prepare(`
    SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary
    FROM intent_resolutions WHERE decision_event_id IN (${placeholders})
  `).all(params) as LedgerResolution[]
  for (const r of resolutionRows) {
    resolutionsByDecision.set(`${r.decision_event_id}|${r.decision_decided_by}`, r)
  }

  return { events, decisionsByEvent, resolutionsByDecision }
}

function buildSnapshot(db: Database.Database, root: string | null, windowMs: number): GraphSnapshot {
  const sinceMs = Date.now() - windowMs
  const { events, decisionsByEvent, resolutionsByDecision } = loadAggregated(db, sinceMs)

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const ensure = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n) }

  for (const ev of events.values()) {
    let raw: any = null
    try { raw = JSON.parse(ev.raw_json) } catch { /* drop */ }

    const projectKey = ev.project ? `project:${ev.project}` : null
    if (projectKey) {
      const clientName = clientFromProject(ev.project)
      const clientKey = `client:${clientName}`
      ensure({ id: clientKey, type: "client", label: clientName })
      ensure({ id: projectKey, type: "project", label: ev.project!, sub: clientName })
      edges.push({ id: `${clientKey}>>${projectKey}`, from: clientKey, to: projectKey, kind: "contains", active: false })
    }

    const subjectKey = ev.subject ? `subject:${ev.source}:${ev.project ?? "_"}:${ev.subject}` : null
    if (subjectKey) {
      ensure({ id: subjectKey, type: "subject", label: ev.subject!, sub: ev.intent || ev.source })
      if (projectKey) {
        edges.push({ id: `${projectKey}>>${subjectKey}`, from: projectKey, to: subjectKey, kind: "contains", active: false })
      }
    }

    const channelKey = `channel:${ev.source}`
    ensure({ id: channelKey, type: "channel", label: ev.source })

    if (subjectKey) {
      edges.push({
        id: `${channelKey}>>${subjectKey}|${ev.id}`,
        from: channelKey,
        to: subjectKey,
        kind: "arrives",
        active: false,
        startedAt: ev.ts,
      })
    }

    const init = initiatorFrom(ev.source, raw)
    if (init && subjectKey) {
      const initiatorKey = `initiator:${init.username}`
      ensure({ id: initiatorKey, type: "initiator", label: init.label, sub: ev.source })
      edges.push({
        id: `${initiatorKey}>>${subjectKey}|${ev.id}`,
        from: initiatorKey,
        to: subjectKey,
        kind: "starts",
        active: false,
        startedAt: ev.ts,
      })
    }

    // dispatch + resolve edges per decision
    for (const d of decisionsByEvent.get(ev.id) ?? []) {
      if (!d.agent_id) continue
      const agentKey = `agent:${d.agent_id}`
      ensure({ id: agentKey, type: "agent", label: d.agent_id })
      const resKey = `${ev.id}|${d.decided_by}`
      const res = resolutionsByDecision.get(resKey)
      const isActive = !res && d.outcome === "dispatched"
      if (subjectKey) {
        edges.push({
          id: `dispatch:${ev.id}:${d.decided_by}`,
          from: subjectKey,
          to: agentKey,
          kind: "dispatches",
          active: isActive,
          startedAt: d.decided_at,
          resolvedAt: res?.resolved_at,
          outcome: d.outcome,
          preview: d.reason ?? undefined,
        })
        if (res) {
          edges.push({
            id: `resolve:${ev.id}:${d.decided_by}`,
            from: agentKey,
            to: subjectKey,
            kind: "resolves",
            active: false,
            resolvedAt: res.resolved_at,
            outcome: res.status,
            preview: res.result_summary ?? undefined,
          })
        }
      }

      // a2a: when source is mesh, the calling agent's id sits in raw.fromAgent
      if (ev.source === "mesh" && raw && typeof raw === "object") {
        const fromAgentId = raw.fromAgent || raw.payload?.fromAgent || raw.callerAgent
        if (typeof fromAgentId === "string" && fromAgentId !== d.agent_id) {
          const fromKey = `agent:${fromAgentId}`
          ensure({ id: fromKey, type: "agent", label: fromAgentId })
          edges.push({
            id: `a2a:${ev.id}:${d.decided_by}`,
            from: fromKey,
            to: agentKey,
            kind: "a2a",
            active: isActive,
            startedAt: d.decided_at,
            resolvedAt: res?.resolved_at,
            preview: typeof raw.message === "string" ? String(raw.message).slice(0, 200) : undefined,
          })
        }
      }
    }
  }

  // Annotate node count = active edge count incident
  const activeIncident = new Map<string, number>()
  for (const e of edges) {
    if (!e.active) continue
    activeIncident.set(e.from, (activeIncident.get(e.from) || 0) + 1)
    activeIncident.set(e.to, (activeIncident.get(e.to) || 0) + 1)
  }
  for (const n of nodes.values()) n.count = activeIncident.get(n.id) || 0

  // Filter to neighbors of root if requested
  let rootMeta: { type: NodeType; label: string } | undefined
  let outNodes = [...nodes.values()]
  let outEdges = edges
  if (root && nodes.has(root)) {
    const rNode = nodes.get(root)!
    rootMeta = { type: rNode.type, label: rNode.label }
    const keep = new Set<string>([root])
    // BFS to depth 2
    let frontier = new Set<string>([root])
    for (let depth = 0; depth < 2; depth++) {
      const next = new Set<string>()
      for (const e of edges) {
        if (frontier.has(e.from) && !keep.has(e.to)) { keep.add(e.to); next.add(e.to) }
        if (frontier.has(e.to) && !keep.has(e.from)) { keep.add(e.from); next.add(e.from) }
      }
      frontier = next
      if (frontier.size === 0) break
    }
    outNodes = outNodes.filter((n) => keep.has(n.id))
    outEdges = outEdges.filter((e) => keep.has(e.from) && keep.has(e.to))
  }

  return {
    nodes: outNodes,
    edges: outEdges,
    root: root && rootMeta ? root : null,
    rootMeta,
    windowMs,
    ts: Date.now(),
  }
}

export async function handleActivityGraphApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== "/api/admin/activity-graph") return false
  const opened = openLedger()
  if (!opened) {
    sendJson(res, 503, { error: "intent ledger not available", nodes: [], edges: [] })
    return true
  }
  try {
    const url = new URL(req.url || "/", "http://_")
    const root = url.searchParams.get("root")
    const windowH = parseInt(url.searchParams.get("hours") || "24", 10)
    const windowMs = Math.max(1, Math.min(168, Number.isFinite(windowH) ? windowH : 24)) * 60 * 60 * 1000
    sendJson(res, 200, buildSnapshot(opened.db, root, windowMs))
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e), nodes: [], edges: [] })
  } finally {
    opened.close()
  }
  return true
}
