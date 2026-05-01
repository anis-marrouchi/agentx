import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { renderActivityGraphPage } from "./ui/pages/activity-graph"
import type { TopbarPeer } from "./topbar"
import type { DaemonConfig } from "./config"

// --- /admin/activity-graph — Fleet activity perspective view ---
//
// Server-side snapshot builder. Reads .agentx/intent/ledger.sqlite
// (read-only) and the daemon config; produces a "fleet snapshot"
// JSON the client React app consumes:
//
//   {
//     now:        epoch ms,
//     clients:    [{ id, name, color, projects: string[] }],
//     agents:     [{ id, name, tier, model, role }],
//     channels:   [{ id, label, color }],
//     initiators: [{ id, name, avatar }],
//     dispatches: [{ id, agentId, clientId, projectId, channelId,
//                    initiatorId, subject, intent, startedAt,
//                    resolvedAt, duration, active, outcome, tokens }]
//   }
//
// One row per dispatched decision in the ledger window. Active = no
// resolution row yet. Client/initiator extracted from the source-
// specific raw_json payload.

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
// Snapshot types

export interface FleetClient { id: string; name: string; color: string; projects: string[] }
export interface FleetAgent { id: string; name: string; tier: "lead" | "worker"; model: string; role: string }
export interface FleetChannel { id: string; label: string; color: string }
export interface FleetInitiator { id: string; name: string; avatar: string }
export interface FleetDispatch {
  id: string
  agentId: string
  clientId: string
  projectId: string
  channelId: string
  initiatorId: string
  subject: string
  intent: string
  startedAt: number
  resolvedAt: number | null
  duration: number
  active: boolean
  outcome: "completed" | "active" | "error"
  tokens: number
}
export interface FleetSnapshot {
  now: number
  windowH: number
  clients: FleetClient[]
  agents: FleetAgent[]
  channels: FleetChannel[]
  initiators: FleetInitiator[]
  dispatches: FleetDispatch[]
}

// ---------------------------------------------------------------------------
// Lookups: client palette + channel palette

const CHANNEL_DEF: Record<string, { label: string; color: string }> = {
  gitlab: { label: "GitLab", color: "#fc6d26" },
  github: { label: "GitHub", color: "#6e7681" },
  telegram: { label: "Telegram", color: "#0088cc" },
  whatsapp: { label: "WhatsApp", color: "#25d366" },
  slack: { label: "Slack", color: "#4a154b" },
  discord: { label: "Discord", color: "#5865f2" },
  mesh: { label: "Mesh (a2a)", color: "#bf8700" },
  cron: { label: "Schedule", color: "#6b7280" },
  workflow: { label: "Workflow", color: "#9333ea" },
  api: { label: "API", color: "#3a7bd5" },
}

// Stable client color from id hash — semantically muted but distinct.
function colorForClient(id: string): string {
  // Reserve known clients to nice colours; everything else picks from a
  // deterministic palette by hashing the id.
  const known: Record<string, string> = {
    mtgl: "#e07a3a",
    ksi: "#3a7bd5",
    noqta: "#10b981",
    hasanah: "#bc8cff",
    "hasanah-lab": "#bc8cff",
    hackathonat: "#ec775c",
    internal: "#6b7280",
  }
  if (known[id]) return known[id]
  const palette = ["#e07a3a", "#3a7bd5", "#10b981", "#bc8cff", "#ec775c", "#bf8700", "#5865f2", "#cf222e"]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

function clientFromProject(project: string | null | undefined): string {
  if (!project) return "internal"
  const slash = project.indexOf("/")
  return slash > 0 ? project.slice(0, slash) : project
}

// Best-effort initiator extraction per source.
function initiatorFrom(source: string, raw: any): { id: string; name: string; avatar: string } | null {
  if (!raw || typeof raw !== "object") return null
  if (source === "gitlab") {
    const u = raw.payload?.user || raw.user
    if (u?.username || u?.name) {
      const id = u.username || u.name
      const name = u.name || u.username
      return { id, name, avatar: initialsFor(name) }
    }
  }
  if (source === "github") {
    const u = raw.payload?.sender || raw.sender || raw.payload?.user
    if (u?.login) return { id: u.login, name: u.login, avatar: initialsFor(u.login) }
  }
  if (source === "telegram") {
    const f = raw.from || raw.payload?.from
    if (f?.username) return { id: f.username, name: f.first_name || f.username, avatar: initialsFor(f.first_name || f.username) }
    if (f?.id) return { id: String(f.id), name: f.first_name || `tg:${f.id}`, avatar: (f.first_name || "TG").slice(0, 2).toUpperCase() }
  }
  if (source === "whatsapp") {
    const j = raw.from || raw.payload?.from
    if (j) {
      const id = String(j)
      const name = id.replace(/@.*$/, "")
      return { id, name, avatar: initialsFor(name) }
    }
  }
  return null
}

function initialsFor(name: string): string {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(name || "?").slice(0, 2).toUpperCase()
}

// Trim "merge_request:957:..." → "MR #957", "issue:42:..." → "issue #42", etc.
function shortSubject(subject: string | null): string {
  if (!subject) return "(no subject)"
  let m: RegExpMatchArray | null
  if ((m = subject.match(/^merge_request:(\d+)(?::note:(\d+))?/))) {
    return m[2] ? `MR #${m[1]} · note ${m[2]}` : `MR #${m[1]}`
  }
  if ((m = subject.match(/^issue:(\d+)(?::note:(\d+))?/))) {
    return m[2] ? `Issue #${m[1]} · note ${m[2]}` : `Issue #${m[1]}`
  }
  if ((m = subject.match(/^chat:(.+?):(.+)$/))) return `${m[1]} · ${m[2].slice(0, 40)}`
  if ((m = subject.match(/^mesh:agent:(.+)$/))) return `→ ${m[1]}`
  if ((m = subject.match(/^workflow:([^:]+):(.+)$/))) return `${m[1]} · ${m[2].slice(0, 30)}`
  return subject.length > 60 ? subject.slice(0, 57) + "…" : subject
}

// ---------------------------------------------------------------------------
// Snapshot builder

function buildFleetSnapshot(db: Database.Database, daemonConfig: DaemonConfig | null, windowH: number): FleetSnapshot {
  const now = Date.now()
  const sinceMs = now - windowH * 3600 * 1000

  // Pull events in the window.
  const events = db.prepare(`
    SELECT id, ts, source, project, subject, intent, raw_json
    FROM intent_events WHERE ts >= ? ORDER BY ts ASC
  `).all(sinceMs) as Array<{ id: string; ts: number; source: string; project: string | null; subject: string | null; intent: string | null; raw_json: string }>

  // Decisions for those events
  const decisionsByEvent = new Map<string, Array<{ event_id: string; decided_at: number; decided_by: string; agent_id: string | null; outcome: string; reason: string | null }>>()
  const resolutionsByDecision = new Map<string, { resolved_at: number; status: string; duration_ms: number | null; result_summary: string | null }>()

  if (events.length > 0) {
    const ids = events.map((e) => e.id)
    const placeholders = ids.map((_, i) => `@id${i}`).join(",")
    const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]))

    const decRows = db.prepare(`
      SELECT event_id, decided_at, decided_by, agent_id, outcome, reason
      FROM intent_decisions WHERE event_id IN (${placeholders}) ORDER BY decided_at ASC
    `).all(params) as Array<{ event_id: string; decided_at: number; decided_by: string; agent_id: string | null; outcome: string; reason: string | null }>
    for (const d of decRows) {
      if (!decisionsByEvent.has(d.event_id)) decisionsByEvent.set(d.event_id, [])
      decisionsByEvent.get(d.event_id)!.push(d)
    }

    const resRows = db.prepare(`
      SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary
      FROM intent_resolutions WHERE decision_event_id IN (${placeholders})
    `).all(params) as Array<{ decision_event_id: string; decision_decided_by: string; resolved_at: number; status: string; duration_ms: number | null; result_summary: string | null }>
    for (const r of resRows) {
      resolutionsByDecision.set(`${r.decision_event_id}|${r.decision_decided_by}`, r)
    }
  }

  // Build entity caches
  const clientMap = new Map<string, FleetClient>()
  const projectsByClient = new Map<string, Set<string>>()
  const channelMap = new Map<string, FleetChannel>()
  const initiatorMap = new Map<string, FleetInitiator>()
  const dispatches: FleetDispatch[] = []

  for (const ev of events) {
    let raw: any = null
    try { raw = JSON.parse(ev.raw_json) } catch { /* ignore */ }

    const clientId = clientFromProject(ev.project)
    const projectId = ev.project || `${clientId}/_${ev.source}`

    if (!clientMap.has(clientId)) {
      clientMap.set(clientId, { id: clientId, name: clientId, color: colorForClient(clientId), projects: [] })
    }
    if (!projectsByClient.has(clientId)) projectsByClient.set(clientId, new Set())
    projectsByClient.get(clientId)!.add(projectId)

    const chanDef = CHANNEL_DEF[ev.source] || { label: ev.source, color: "#6b7280" }
    if (!channelMap.has(ev.source)) channelMap.set(ev.source, { id: ev.source, label: chanDef.label, color: chanDef.color })

    let initiatorId = "__system"
    const init = initiatorFrom(ev.source, raw)
    if (init) {
      initiatorId = init.id
      if (!initiatorMap.has(init.id)) initiatorMap.set(init.id, init)
    } else if (!initiatorMap.has("__system")) {
      initiatorMap.set("__system", { id: "__system", name: "Schedule", avatar: "⏱" })
    }

    // For each dispatched decision on this event, emit a dispatch row
    for (const d of decisionsByEvent.get(ev.id) ?? []) {
      if (d.outcome !== "dispatched" || !d.agent_id) continue
      const resKey = `${ev.id}|${d.decided_by}`
      const res = resolutionsByDecision.get(resKey)
      const startedAt = d.decided_at
      const resolvedAt = res?.resolved_at ?? null
      const active = resolvedAt === null
      const duration = res?.duration_ms ?? (active ? now - startedAt : 0)
      const outcome: FleetDispatch["outcome"] = active
        ? "active"
        : (res?.status === "error" || res?.status === "fail" ? "error" : "completed")

      dispatches.push({
        id: `${ev.id}|${d.decided_by}`,
        agentId: d.agent_id,
        clientId,
        projectId,
        channelId: ev.source,
        initiatorId,
        subject: shortSubject(ev.subject),
        intent: ev.intent || "",
        startedAt,
        resolvedAt,
        duration,
        active,
        outcome,
        tokens: 0,
      })
    }
  }

  // Materialize clients with their project list
  const clients: FleetClient[] = [...clientMap.values()].map((c) => ({
    ...c,
    projects: [...(projectsByClient.get(c.id) || [])].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id))

  // Agents: union of (configured agents) + (any agent that appears in dispatches)
  const agents: FleetAgent[] = []
  const agentSeen = new Set<string>()
  if (daemonConfig) {
    for (const [id, def] of Object.entries(daemonConfig.agents || {})) {
      const a: FleetAgent = {
        id,
        name: def.name || id,
        tier: def.tier === "claude-code" ? "lead" : "worker",
        model: def.model || "",
        role: def.systemPrompt ? def.systemPrompt.split(/[.\n]/)[0].slice(0, 60) : (def.tier || ""),
      }
      agents.push(a)
      agentSeen.add(id)
    }
  }
  for (const d of dispatches) {
    if (!agentSeen.has(d.agentId)) {
      agents.push({ id: d.agentId, name: d.agentId, tier: "worker", model: "", role: "" })
      agentSeen.add(d.agentId)
    }
  }
  agents.sort((a, b) => a.id.localeCompare(b.id))

  // Channels: include all known kinds (so the Flow view shows zero-traffic
  // channels too) plus any unknown sources we observed.
  const channels: FleetChannel[] = []
  const channelSeen = new Set<string>()
  for (const [id, def] of Object.entries(CHANNEL_DEF)) {
    channels.push({ id, label: def.label, color: def.color })
    channelSeen.add(id)
  }
  for (const c of channelMap.values()) {
    if (!channelSeen.has(c.id)) channels.push(c)
  }

  const initiators: FleetInitiator[] = [...initiatorMap.values()]
  if (!initiators.find((i) => i.id === "__system")) {
    initiators.push({ id: "__system", name: "Schedule", avatar: "⏱" })
  }

  return {
    now,
    windowH,
    clients,
    agents,
    channels,
    initiators,
    dispatches,
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers

let _daemonConfigRef: DaemonConfig | null = null
/** Wired by board-dashboard.ts when the dashboard starts so we can read
 *  agent metadata (tier, model, name) for the snapshot. */
export function setDaemonConfigForActivityGraph(cfg: DaemonConfig | null): void {
  _daemonConfigRef = cfg
}

export async function handleActivityGraphApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== "/api/admin/activity-graph" && !path.startsWith("/api/admin/activity-graph?")) return false
  const opened = openLedger()
  if (!opened) {
    sendJson(res, 503, { error: "intent ledger not available", clients: [], agents: [], channels: [], initiators: [], dispatches: [] })
    return true
  }
  try {
    const url = new URL(req.url || "/", "http://_")
    const windowH = clampWindow(parseInt(url.searchParams.get("hours") || "6", 10))
    sendJson(res, 200, buildFleetSnapshot(opened.db, _daemonConfigRef, windowH))
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e) })
  } finally {
    opened.close()
  }
  return true
}

const TICK_MS = 5000

export async function handleActivityGraphStream(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== "/api/admin/activity-graph/stream" && !path.startsWith("/api/admin/activity-graph/stream?")) return false
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })
  res.write(`: connected\n\n`)

  const url = new URL(req.url || "/", "http://_")
  const windowH = clampWindow(parseInt(url.searchParams.get("hours") || "6", 10))

  let stopped = false
  const stop = () => { stopped = true }
  req.on("close", stop); req.on("error", stop)
  res.on("close", stop); res.on("error", stop)
  const hb = setInterval(() => { if (!stopped) try { res.write(`: hb\n\n`) } catch { stop() } }, 25_000)

  try {
    while (!stopped) {
      const opened = openLedger()
      if (opened) {
        try {
          const snap = buildFleetSnapshot(opened.db, _daemonConfigRef, windowH)
          res.write(`event: snapshot\n`)
          res.write(`data: ${JSON.stringify(snap)}\n\n`)
        } catch (e: any) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message ?? String(e) })}\n\n`)
        } finally {
          opened.close()
        }
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "ledger not available" })}\n\n`)
      }
      const start = Date.now()
      while (!stopped && Date.now() - start < TICK_MS) await new Promise((r) => setTimeout(r, 200))
    }
  } finally {
    clearInterval(hb)
    try { res.end() } catch { /* nothing */ }
  }
  return true
}

function clampWindow(h: number): number {
  if (!Number.isFinite(h) || h < 1) return 6
  return Math.min(720, Math.max(1, h))
}
