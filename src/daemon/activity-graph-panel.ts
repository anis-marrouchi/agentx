import type { IncomingMessage, ServerResponse } from "http"
import { resolve, join } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"
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
export interface FleetInitiator { id: string; name: string; avatar: string; kind: InitiatorKind }
export interface FleetDispatch {
  id: string
  agentId: string
  clientId: string
  projectId: string
  channelId: string
  initiatorId: string
  /** What kind of trigger started this dispatch — "telegram", "gitlab",
   *  "github", "cron", "workflow", "a2a", … Lets the UI render a small
   *  pill ("Anis · GitLab MR") instead of the catch-all "Schedule". */
  initiatorKind?: InitiatorKind
  subject: string
  intent: string
  startedAt: number
  resolvedAt: number | null
  duration: number
  active: boolean
  outcome: "completed" | "active" | "error"
  tokens: number
  /** First ~200 chars of the inbound message text. Inline so the drawer
   *  can render the trigger without an extra round-trip. Full text +
   *  agent response come from the detail endpoint. */
  inputPreview: string
  /** True when this dispatch is internal infrastructure (intent classifier,
   *  background workers) rather than user-facing work. The activity graph
   *  hides these by default — they bloat the view without telling the
   *  business operator anything actionable. Toggle on to see them. */
  system: boolean
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
  a2a: { label: "Agent → Agent", color: "#bf8700" },
  cron: { label: "Cron", color: "#6b7280" },
  workflow: { label: "Workflow", color: "#9333ea" },
  api: { label: "API", color: "#3a7bd5" },
}

/** Collapse the storage `source` to the channel the operator thinks
 *  they're looking at. Examples:
 *    source=mesh,     intent=mesh.github            → "github"
 *    source=mesh,     intent=mesh.gitlab            → "gitlab"
 *    source=mesh,     intent=mesh.a2a               → "a2a"
 *    source=mesh,     intent=mesh.task              → "mesh"
 *    source=workflow, intent=workflow.whatsapp-msg  → "whatsapp"
 *    source=workflow, intent=workflow.hook          → "gitlab"|"github" (per payload)
 *  Everything else passes through unchanged. */
function upstreamChannel(source: string, intent: string, raw: any): string {
  if (source === "mesh") {
    const ctxChan = raw?.context?.channel
    if (typeof ctxChan === "string" && ctxChan in CHANNEL_DEF) return ctxChan
    if (intent.startsWith("mesh.")) {
      const suffix = intent.slice(5)
      if (suffix === "a2a") return "a2a"
      if (suffix in CHANNEL_DEF) return suffix
    }
    return "mesh"
  }
  if (source === "workflow") {
    // Trigger payload tells us the upstream channel for chat-style triggers.
    const payload = raw?.event?.payload
    const chan = typeof payload?.channel === "string" ? payload.channel : ""
    if (chan && chan in CHANNEL_DEF) return chan
    // Hook triggers — peek at the issueEvent shape to disambiguate.
    const issueEvent = payload?.issueEvent || payload?.webhookEvent
    if (issueEvent) {
      if (issueEvent.user?.username || issueEvent.project?.path_with_namespace) return "gitlab"
      if (issueEvent.sender?.login) return "github"
    }
    // Intent suffix as a final hint (e.g. `workflow.whatsapp-message`).
    if (intent.startsWith("workflow.")) {
      const suffix = intent.slice("workflow.".length).split("-")[0]
      if (suffix in CHANNEL_DEF) return suffix
    }
    return "workflow"
  }
  return source
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
    hexastack: "#06b6d4",
    hackathonat: "#ec775c",
    internal: "#6b7280",
    // "unmapped" is rendered amber so it's visually obvious that the
    // operator needs to add a contactMap or business.projects entry.
    unmapped: "#d29922",
  }
  if (known[id]) return known[id]
  const palette = ["#e07a3a", "#3a7bd5", "#10b981", "#bc8cff", "#ec775c", "#bf8700", "#5865f2", "#cf222e"]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

/** Returns true when this agent is internal infrastructure (intent
 *  classifier, background workers) that shouldn't show as user-facing
 *  work in the activity graph by default. Heuristics:
 *    - explicit `agents[X].system === true` in agentx.json (NEW)
 *    - well-known classifier names (graph-agent, *-classifier)
 *  Operators can opt anything in/out via the config flag. */
function isSystemAgent(agentId: string, daemonConfig: DaemonConfig | null): boolean {
  if (!agentId) return false
  const cfg = (daemonConfig as any)?.agents?.[agentId]
  if (cfg && typeof cfg.system === "boolean") return cfg.system
  // Default heuristic: the intent classifier is a known internal name,
  // and any agent ending in "-classifier" is by convention internal.
  if (agentId === "graph-agent" || agentId === "intent-classifier") return true
  if (/-classifier$/.test(agentId)) return true
  return false
}

function clientFromProject(project: string | null | undefined, projectsConfig?: Array<{ id: string; client?: string }>): string {
  if (!project) return "unmapped"
  // Explicit client mapping in business.projects[] wins.
  if (projectsConfig) {
    const hit = projectsConfig.find((p) => p.id === project)
    if (hit?.client) return hit.client
  }
  const slash = project.indexOf("/")
  return slash > 0 ? project.slice(0, slash) : project
}

interface ContactMapEntry {
  channel?: string
  chatId?: string
  username?: string
  senderId?: string
  client: string
  project?: string
  displayName?: string
}

/** Build a map of agent id -> default client by walking the orgChart.
 *  Sources:
 *    1. business.projects[] declares { id, pm } — the pm gets that
 *       project's client (via the leading-segment heuristic, or
 *       project.client when set).
 *    2. business.orgChart[] declares reportsTo edges — every direct
 *       or transitive report of an agent inherits their client.
 *
 *  Why this matters: a mesh dispatch to `mtgl-v2` carries no project
 *  metadata. Without this map, we'd attribute it to "unmapped".
 *  With it, we look up mtgl-v2 -> reportsTo pm-mtgl -> default client
 *  mtgl, and the dispatch lands in the right bucket.
 */
function buildAgentToClientMap(daemonConfig: DaemonConfig | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!daemonConfig) return out
  const business: any = (daemonConfig as any).business
  if (!business) return out

  const projectsCfg: Array<{ id: string; pm?: string; client?: string }> = business.projects ?? []
  const orgChart: Record<string, { reportsTo?: string }> = business.orgChart ?? {}

  // Step 1: PMs declared on projects get their project's client.
  for (const p of projectsCfg) {
    if (!p.pm) continue
    const c = p.client || (p.id.includes("/") ? p.id.slice(0, p.id.indexOf("/")) : p.id)
    // First win — if a PM is on multiple projects of different clients
    // we take the first; multi-client PMs are an explicit-config case
    // for contactMap or business.projects[].client to disambiguate.
    if (!out.has(p.pm)) out.set(p.pm, c)
  }

  // Step 2: Walk orgChart — for every agent, climb reportsTo until we
  // hit one that has a client mapping. Cache as we go.
  function clientFor(agentId: string, seen: Set<string> = new Set()): string | undefined {
    if (out.has(agentId)) return out.get(agentId)
    if (seen.has(agentId)) return undefined
    seen.add(agentId)
    const entry = orgChart[agentId]
    if (!entry?.reportsTo) return undefined
    const c = clientFor(entry.reportsTo, seen)
    if (c) out.set(agentId, c)
    return c
  }
  for (const agentId of Object.keys(orgChart)) clientFor(agentId)

  return out
}

/** Find a contact-map entry that matches the (source, sender, chatId)
 *  tuple. Match priority: chatId > username > senderId > channel-default.
 *  Returns undefined when no rule matches; the caller falls back to the
 *  default "unmapped" / project-derived client. */
function matchContact(
  source: string,
  raw: any,
  contactMap: ContactMapEntry[],
): ContactMapEntry | undefined {
  if (!contactMap.length) return undefined
  const chatId = String(raw?.chatId ?? raw?.message?.chat?.id ?? "")
  const username = String(raw?.sender?.username ?? raw?.message?.from?.username ?? "")
  const senderId = String(raw?.sender?.id ?? raw?.message?.from?.id ?? "")

  const candidates = contactMap.filter((m) => !m.channel || m.channel === source)
  // Specific match orders: by chatId, then username, then senderId, then channel-only fallback.
  for (const m of candidates) {
    if (m.chatId && chatId && m.chatId === chatId) return m
  }
  for (const m of candidates) {
    if (m.username && username && m.username === username) return m
  }
  for (const m of candidates) {
    if (m.senderId && senderId && m.senderId === senderId) return m
  }
  for (const m of candidates) {
    if (!m.chatId && !m.username && !m.senderId && m.channel === source) return m
  }
  return undefined
}

// Best-effort initiator extraction per source. The raw_json shape differs:
//   - chat-style channels (telegram/whatsapp/slack/discord): the IncomingMessage
//     is what's stored, with sender.{id,username,name} at the top level.
//   - gitlab webhook: the raw GitLab payload is stored as-is, with user.* at
//     the top level (no IncomingMessage wrapper).
//   - github webhook: raw GitHub payload, sender.login at top level.
//   - mesh: a routed task — the original channel + sender live under
//     `raw.context.{channel,sender,senderUsername,senderId}`, NOT at top level.
//   - cron: { jobId, agentId, firedAt } — no human; we name the cron job.
//   - workflow: workflow run envelope with {workflowId|runId}.
function initiatorFrom(source: string, intent: string, raw: any): { id: string; name: string; avatar: string; kind: InitiatorKind } | null {
  if (!raw || typeof raw !== "object") return null

  // ---- mesh-routed events: dig into raw.context.* ----
  // These look like {agentId, context:{channel, sender, senderUsername, senderId}, message}
  // and currently fall through every check below — that's why so many show
  // up as "Schedule". Treat the embedded context as the initiator.
  if (source === "mesh") {
    const ctx = raw.context && typeof raw.context === "object" ? raw.context : null
    if (ctx) {
      const senderUsername = typeof ctx.senderUsername === "string" ? ctx.senderUsername : null
      const senderName = typeof ctx.sender === "string" ? ctx.sender : null
      const senderId = typeof ctx.senderId === "string" ? ctx.senderId : null
      // graph-classifier and similar pseudo-senders are system traffic; let
      // the caller mark the row as "system" so the show-system toggle hides
      // them rather than emitting a confusing entry under "Schedule".
      const display = senderName || senderUsername || senderId
      if (display && !isSystemSender(senderUsername || senderName || "")) {
        const id = senderUsername || senderName || senderId!
        // Channel-aware kind so the UI can render "Anis (GitLab MR)" etc.
        const kind: InitiatorKind =
          intent === "mesh.github" ? "github"
          : intent === "mesh.gitlab" ? "gitlab"
          : intent === "mesh.a2a" ? "a2a"
          : "mesh"
        return { id, name: senderName || senderUsername || id, avatar: initialsFor(display), kind }
      }
    }
    // mesh.task without a recognizable sender → caller-dispatched a2a flow
    return null
  }

  // ---- cron: name the job, never bucket it as anonymous "Schedule" ----
  if (source === "cron") {
    const jobId = typeof raw.jobId === "string" ? raw.jobId : null
    if (jobId) {
      return { id: `cron:${jobId}`, name: `Cron: ${jobId}`, avatar: "⏱", kind: "cron" }
    }
  }

  // ---- workflow: dig into the wrapped trigger payload first ----
  // Workflow events envelope the original event under raw.event.payload.
  // Two shapes seen in the wild:
  //   - chat trigger:      raw.event.payload.{channel,sender,fromJid}
  //   - hook trigger:      raw.event.payload.issueEvent.{user,project} (gitlab)
  //                        raw.event.payload.issueEvent.{sender,...}   (github)
  // Without this, workflow events fall through to "Schedule" — exactly what
  // the user reported for an inbound WhatsApp message.
  if (source === "workflow") {
    const payload = raw.event?.payload
    if (payload && typeof payload === "object") {
      // Chat trigger (WhatsApp/Telegram/Slack/Discord wrapped by a workflow).
      if (payload.sender && typeof payload.sender === "object") {
        const s = payload.sender
        const username = typeof s.username === "string" ? s.username : null
        const name = typeof s.name === "string" ? s.name : null
        const id = username || (s.id != null ? String(s.id) : null) || name
        if (id && !isSystemSender(username || name || "")) {
          const chan = typeof payload.channel === "string" ? payload.channel : ""
          const kind = chatKindFor(chan)
          return { id, name: name || username || id, avatar: initialsFor(name || username || id), kind }
        }
      }
      // GitLab webhook nested in a workflow hook trigger.
      const issueEvent = payload.issueEvent || payload.webhookEvent
      if (issueEvent && typeof issueEvent === "object") {
        const u = issueEvent.user
        if (u && typeof u === "object" && (u.username || u.name)) {
          const id = u.username || u.name
          const name = u.name || u.username
          return { id, name, avatar: initialsFor(name), kind: "gitlab" }
        }
        // GitHub-shaped hook (sender.login)
        const ghs = issueEvent.sender
        if (ghs?.login) return { id: ghs.login, name: ghs.login, avatar: initialsFor(ghs.login), kind: "github" }
      }
    }
    // No upstream sender we can attribute → name the workflow itself.
    const wid =
      (typeof raw.workflowId === "string" && raw.workflowId) ||
      (typeof raw.runId === "string" && raw.runId) ||
      (typeof raw.workflow === "string" && raw.workflow) ||
      (typeof raw.event?.id === "string" && raw.event.id.split(":")[0])
    if (wid) return { id: `workflow:${wid}`, name: `Workflow: ${wid}`, avatar: "▶", kind: "workflow" }
  }

  // Chat-style: IncomingMessage shape with sender.{id,username,name}.
  if (raw.sender && typeof raw.sender === "object") {
    const s = raw.sender
    const username = typeof s.username === "string" ? s.username : null
    const name = typeof s.name === "string" ? s.name : null
    const id = username || (s.id != null ? String(s.id) : null) || name
    if (id) {
      const display = name || username || id
      return { id, name: display, avatar: initialsFor(display), kind: chatKindFor(source) }
    }
  }

  // GitLab webhook payload as-is.
  if (source === "gitlab") {
    const u = raw.user || raw.payload?.user
    if (u && typeof u === "object" && (u.username || u.name)) {
      const id = u.username || u.name
      const name = u.name || u.username
      return { id, name, avatar: initialsFor(name), kind: "gitlab" }
    }
  }

  // GitHub webhook payload — sender.login at top level.
  if (source === "github") {
    const s = raw.sender || raw.payload?.sender
    if (s?.login) return { id: s.login, name: s.login, avatar: initialsFor(s.login), kind: "github" }
  }

  // Last-ditch fallbacks for chat-style raw payloads we didn't catch above.
  if (source === "telegram") {
    const f = raw.message?.from || raw.from
    if (f?.username) {
      const display = f.first_name || f.username
      return { id: f.username, name: display, avatar: initialsFor(display), kind: "telegram" }
    }
    if (f?.id) return { id: String(f.id), name: f.first_name || `tg:${f.id}`, avatar: initialsFor(f.first_name || `tg${f.id}`), kind: "telegram" }
  }
  if (source === "whatsapp") {
    const f = raw.from || raw.payload?.from
    if (f) {
      const id = String(f)
      const name = id.replace(/@.*$/, "")
      return { id, name, avatar: initialsFor(name), kind: "whatsapp" }
    }
  }
  return null
}

/** Initiator origin — used by the UI to render a small pill next to the
 *  initiator name (e.g. "Anis · GitLab MR", "Cron: daily-brief"). */
export type InitiatorKind =
  | "telegram" | "whatsapp" | "slack" | "discord"
  | "gitlab" | "github"
  | "cron" | "workflow"
  | "mesh" | "a2a"
  | "system"

function chatKindFor(source: string): InitiatorKind {
  if (source === "telegram" || source === "whatsapp" || source === "slack" || source === "discord") {
    return source
  }
  return "system"
}

/** Pseudo-senders the orchestrator generates on internal hops (the graph
 *  classifier sub-call, hook fan-outs, etc.). These don't represent real
 *  initiators — they're system traffic. Flag them so the activity graph
 *  can group them under "system" instead of inventing a fake person. */
function isSystemSender(s: string): boolean {
  if (!s) return false
  const v = s.toLowerCase()
  return (
    v === "graph-classifier" ||
    v === "graph-agent" ||
    v.startsWith("system:") ||
    v.startsWith("internal:") ||
    v.endsWith("-system")
  )
}

function initialsFor(name: string): string {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(name || "?").slice(0, 2).toUpperCase()
}

/** Pull a short text preview of what triggered this event from its
 *  raw payload. Each source stashes the human-meaningful text in a
 *  different place; we try the most-likely paths in order and trim
 *  to a fixed cap. Empty string when nothing readable was found. */
function inputPreviewFrom(source: string, raw: any): string {
  if (!raw || typeof raw !== "object") return ""
  const candidates: Array<unknown> = []
  // Chat-style normalized IncomingMessage
  if (typeof raw.text === "string") candidates.push(raw.text)
  // Telegram raw payload
  if (raw.message?.text) candidates.push(raw.message.text)
  if (raw.message?.caption) candidates.push(raw.message.caption)
  // GitLab webhook
  if (raw.object_attributes?.note) candidates.push(raw.object_attributes.note)
  if (raw.object_attributes?.title) {
    const t = raw.object_attributes.title
    const d = raw.object_attributes.description
    candidates.push(d ? `${t}\n${d}` : t)
  }
  // GitHub webhook
  if (raw.comment?.body) candidates.push(raw.comment.body)
  if (raw.issue?.title) candidates.push(raw.issue.title + (raw.issue.body ? `\n${raw.issue.body}` : ""))
  if (raw.pull_request?.title) candidates.push(raw.pull_request.title)
  // mesh / cron / workflow envelopes
  if (typeof raw.message === "string") candidates.push(raw.message)
  if (typeof raw.prompt === "string") candidates.push(raw.prompt)
  if (typeof raw.input === "string") candidates.push(raw.input)
  if (raw.payload && typeof raw.payload.text === "string") candidates.push(raw.payload.text)
  if (raw.payload && typeof raw.payload.message === "string") candidates.push(raw.payload.message)

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      const s = c.trim()
      return s.length > 220 ? s.slice(0, 217) + "…" : s
    }
  }
  return ""
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

  // Pull config knobs once per snapshot.
  const businessProjects = (daemonConfig as any)?.business?.projects ?? []
  const contactMap: ContactMapEntry[] = (daemonConfig as any)?.business?.contactMap ?? []
  const agentToClient = buildAgentToClientMap(daemonConfig)

  for (const ev of events) {
    let raw: any = null
    try { raw = JSON.parse(ev.raw_json) } catch { /* ignore */ }

    // Resolve client + project. Attribution precedence:
    //   1. contactMap match (operator-explicit)
    //   2. ev.project namespace prefix (with projects[].client override)
    //   3. agent's default client via orgChart (agent reportsTo PM whose
    //      project has a known client — covers mesh dispatches with no
    //      project metadata, like a2a calls to mtgl-v2)
    //   4. "unmapped" fallback
    //
    // Step 3 is computed per-decision below since it's agent-dependent.
    const contact = matchContact(ev.source, raw, contactMap)
    let baseClientId: string | null = null
    let baseProjectId: string | null = null
    if (contact) {
      baseClientId = contact.client
      baseProjectId = contact.project || `${contact.client}/_chat`
    } else if (ev.project) {
      baseClientId = clientFromProject(ev.project, businessProjects)
      baseProjectId = ev.project
    }

    // Origin channel — what the operator thinks of as "where this came
    // from". For mesh-routed events the source is "mesh" but the user
    // experiences a GitLab MR / GitHub push / a2a hop; collapse to the
    // upstream channel via raw.context.channel or the intent suffix.
    const upstream = upstreamChannel(ev.source, ev.intent || "", raw)
    const chanDef = CHANNEL_DEF[upstream] || { label: upstream, color: "#6b7280" }
    if (!channelMap.has(upstream)) channelMap.set(upstream, { id: upstream, label: chanDef.label, color: chanDef.color })

    let initiatorId = "__system"
    let initiatorKind: InitiatorKind | undefined
    const init = initiatorFrom(ev.source, ev.intent || "", raw)
    if (init) {
      initiatorId = init.id
      initiatorKind = init.kind
      // Contact-map can override the display name (e.g. map "marrouchi" → "Anis")
      const display = contact?.displayName || init.name
      if (!initiatorMap.has(init.id) || contact?.displayName) {
        initiatorMap.set(init.id, { id: init.id, name: display, avatar: initialsFor(display), kind: init.kind })
      }
    } else if (!initiatorMap.has("__system")) {
      initiatorMap.set("__system", { id: "__system", name: "Schedule", avatar: "⏱", kind: "system" })
    }

    const inputPreview = inputPreviewFrom(ev.source, raw)

    // For each dispatched decision on this event, emit a dispatch row.
    // Client/project resolves per-decision because the orgChart fallback
    // depends on which agent received the dispatch.
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

      // Resolved client/project: contactMap > project > orgChart > unmapped
      let clientId: string
      let projectId: string
      if (baseClientId) {
        clientId = baseClientId
        projectId = baseProjectId!
      } else {
        const orgClient = agentToClient.get(d.agent_id)
        if (orgClient) {
          clientId = orgClient
          projectId = `${orgClient}/_${ev.source}`
        } else {
          clientId = "unmapped"
          projectId = `unmapped/_${ev.source}`
        }
      }

      if (!clientMap.has(clientId)) {
        clientMap.set(clientId, { id: clientId, name: clientId, color: colorForClient(clientId), projects: [] })
      }
      if (!projectsByClient.has(clientId)) projectsByClient.set(clientId, new Set())
      projectsByClient.get(clientId)!.add(projectId)

      dispatches.push({
        id: `${ev.id}|${d.decided_by}`,
        agentId: d.agent_id,
        clientId,
        projectId,
        channelId: upstream,
        initiatorId,
        initiatorKind,
        subject: shortSubject(ev.subject),
        intent: ev.intent || "",
        startedAt,
        resolvedAt,
        duration,
        active,
        outcome,
        tokens: 0,
        inputPreview,
        system: isSystemAgent(d.agent_id, daemonConfig),
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
    initiators.push({ id: "__system", name: "Schedule", avatar: "⏱", kind: "system" })
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

// ---------------------------------------------------------------------------
// Dispatch detail — joins the file-based task-history JSON to recover the
// full input + agent's response for the drawer. The ledger doesn't store
// responses (only resolutions), so we look them up by (agentId, startedAt±)
// in .agentx/task-history/<agent>/<day>/*.json.

interface TaskRecordLite {
  id?: string
  agentId?: string
  channel?: string
  message?: string
  responseText?: string
  startedAt?: string | number
  durationMs?: number
  ok?: boolean
}

function findTaskRecord(agentId: string, startedAtMs: number, fuzzMs = 5_000): TaskRecordLite | null {
  const day = new Date(startedAtMs).toISOString().slice(0, 10)
  const dir = resolve(process.cwd(), ".agentx/task-history", agentId, day)
  if (!existsSync(dir)) {
    // Try yesterday too — UTC day boundary can put a 22:59 dispatch on
    // either side depending on local TZ.
    const yDay = new Date(startedAtMs - 86400_000).toISOString().slice(0, 10)
    const yDir = resolve(process.cwd(), ".agentx/task-history", agentId, yDay)
    if (!existsSync(yDir)) return null
    return scanDir(yDir, startedAtMs, fuzzMs)
  }
  return scanDir(dir, startedAtMs, fuzzMs)
}

function scanDir(dir: string, startedAtMs: number, fuzzMs: number): TaskRecordLite | null {
  let best: TaskRecordLite | null = null
  let bestDelta = Infinity
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    let parsed: TaskRecordLite
    try { parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) }
    catch { continue }
    const ts = parsed.startedAt
    let recMs: number
    if (typeof ts === "number") recMs = ts
    else if (typeof ts === "string") {
      const n = Date.parse(ts)
      if (!Number.isFinite(n)) continue
      recMs = n
    } else continue
    const d = Math.abs(recMs - startedAtMs)
    if (d < bestDelta && d <= fuzzMs) {
      best = parsed
      bestDelta = d
    }
  }
  return best
}

export async function handleActivityGraphDetail(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/api\/admin\/activity-graph\/dispatch\/([^/?]+)(?:\?.*)?$/)
  if (!m) return false
  const dispatchId = decodeURIComponent(m[1])
  const sep = dispatchId.indexOf("|")
  if (sep < 0) { sendJson(res, 400, { error: "invalid dispatch id" }); return true }
  const eventId = dispatchId.slice(0, sep)
  const decidedBy = dispatchId.slice(sep + 1)

  const opened = openLedger()
  if (!opened) { sendJson(res, 503, { error: "ledger not available" }); return true }
  try {
    const ev = opened.db
      .prepare(`SELECT id, ts, source, project, subject, intent, raw_json FROM intent_events WHERE id = ?`)
      .get(eventId) as { id: string; ts: number; source: string; project: string | null; subject: string | null; intent: string | null; raw_json: string } | undefined
    if (!ev) { sendJson(res, 404, { error: "event not found" }); return true }

    const dec = opened.db
      .prepare(`SELECT decided_at, decided_by, agent_id, outcome, reason FROM intent_decisions WHERE event_id = ? AND decided_by = ?`)
      .get(eventId, decidedBy) as { decided_at: number; decided_by: string; agent_id: string | null; outcome: string; reason: string | null } | undefined
    if (!dec) { sendJson(res, 404, { error: "decision not found" }); return true }

    const resn = opened.db
      .prepare(`SELECT resolved_at, status, duration_ms, result_summary FROM intent_resolutions WHERE decision_event_id = ? AND decision_decided_by = ?`)
      .get(eventId, decidedBy) as { resolved_at: number; status: string; duration_ms: number | null; result_summary: string | null } | undefined

    let raw: any = null
    try { raw = JSON.parse(ev.raw_json) } catch { /* ignore */ }
    const fullInput = inputPreviewFrom(ev.source, raw) // returns truncated; pull a fuller version below
    const longInput =
      (raw && typeof raw === "object" && (raw.text || raw.message?.text || raw.message?.caption || raw.object_attributes?.note || raw.object_attributes?.description || raw.comment?.body || raw.issue?.body || (typeof raw.message === "string" ? raw.message : null) || (typeof raw.prompt === "string" ? raw.prompt : null) || null)) || fullInput

    let response: string | null = null
    let transcriptLen: number | null = null
    if (dec.agent_id) {
      const rec = findTaskRecord(dec.agent_id, dec.decided_at)
      if (rec) {
        if (typeof rec.responseText === "string") response = rec.responseText
        const t = (rec as any).transcript
        if (Array.isArray(t)) transcriptLen = t.length
      }
    }

    // Re-derive the attribution chain so the drawer can explain why a
    // particular client was assigned. Same precedence the snapshot uses;
    // we just record which step won.
    const businessProjects = (_daemonConfigRef as any)?.business?.projects ?? []
    const contactMap: ContactMapEntry[] = (_daemonConfigRef as any)?.business?.contactMap ?? []
    const agentToClient = buildAgentToClientMap(_daemonConfigRef)
    let attribution: { client: string; project: string; via: string } = { client: "unmapped", project: `unmapped/_${ev.source}`, via: "fallback" }
    const contact = matchContact(ev.source, raw, contactMap)
    if (contact) {
      attribution = {
        client: contact.client,
        project: contact.project || `${contact.client}/_chat`,
        via: `contactMap (channel=${contact.channel ?? "*"}${contact.username ? ` username=${contact.username}` : ""}${contact.chatId ? ` chatId=${contact.chatId}` : ""})`,
      }
    } else if (ev.project) {
      attribution = {
        client: clientFromProject(ev.project, businessProjects),
        project: ev.project,
        via: `project namespace prefix (${ev.project})`,
      }
    } else if (dec.agent_id) {
      const orgClient = agentToClient.get(dec.agent_id)
      if (orgClient) {
        attribution = {
          client: orgClient,
          project: `${orgClient}/_${ev.source}`,
          via: `orgChart fallback (agent ${dec.agent_id} reports up to a PM whose project belongs to ${orgClient})`,
        }
      }
    }

    sendJson(res, 200, {
      id: dispatchId,
      eventId,
      source: ev.source,
      subject: ev.subject,
      intent: ev.intent,
      project: ev.project,
      decidedBy: dec.decided_by,
      agentId: dec.agent_id,
      outcome: dec.outcome,
      reason: dec.reason,
      startedAt: dec.decided_at,
      resolvedAt: resn?.resolved_at ?? null,
      durationMs: resn?.duration_ms ?? null,
      input: longInput,
      response,
      transcriptLen,
      resolutionStatus: resn?.status ?? null,
      resultSummary: resn?.result_summary ?? null,
      attribution,
    })
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e) })
  } finally {
    opened.close()
  }
  return true
}
