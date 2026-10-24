import type Database from "better-sqlite3"
import { redactSecrets } from "@/agents/memory-trust"
import { cardWords, summarize } from "@/requests/card-view"
import { activeStepAgentOf, stalledWhy, waitsOn } from "@/requests/loops"
import type { PlanStore } from "@/requests/plan-store"
import { OPEN_STATES, type RequestRecord, type RequestStore } from "@/requests/store"

// --- The Wall's data (#1180) ---
//
// Each request is a post; what is recorded against it (its runs, its
// hand-offs, its plan steps, its homes, its close) is the post's thread.
// Everything here is a read of the request, plan and trace records the
// daemon already keeps: no write, no notification, no model call.
//
// A post only ever carries what is linked to its own request, so a run
// from another chat (another group) never shows inside it. Text that
// agents or channels wrote is passed through redactSecrets.
//   GET /api/admin/wall?days=7            posts (open + closed in the last days) and failed runs
//   GET /api/admin/wall/thread?id=<req>   one post and its timeline
//   GET /api/admin/wall/thread?task=<id>  the same, found from a run (classic task page link)

export const WALL_PREFIX = "/api/admin/wall"
const HOUR = 3_600_000
const DAY = 24 * HOUR
export const WALL_DAYS_MAX = 30
const TEXT_MAX = 600
const FAILED_LIMIT = 200

export interface WallDeps {
  store: Pick<RequestStore, "listOpen" | "listClosedSince" | "get" | "byLink">
  plans?: Pick<PlanStore, "get" | "steps" | "events"> | null
  db: Database.Database | null
  now: number
  staleAfterHours: number
  isAgent: (id: string) => boolean
}

export interface WallRun {
  taskId: string
  agentId: string | null
  status: string | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  error: string | null
}

export interface WallPost {
  id: string
  state: string
  headline: string
  need: string
  /** The named owner: the agent it was handed to, or the one it was asked of. */
  owner: string
  agentId: string
  askedBy: string | null
  /** The chat it came from: the post's group. */
  group: { channel: string; chatId: string }
  project: string | null
  home: { kind: string; link: string } | null
  createdAt: number
  updatedAt: number
  /** Last time its state changed, else last activity. */
  lastMoveAt: number
  closedAt: number | null
  evidence: string | null
  closeReason: string | null
  /** Who or what it waits on, and since when. Null: moving. */
  blocked: { who: string; why: string; since: number } | null
  estimateMinutes: number | null
  runMs: number
  runs: number
  failedRuns: number
  /** Estimate against measured run time, in words. Null: nothing to flag. */
  timeFlag: string | null
  lastRun: { taskId: string; agentId: string } | null
}

export interface WallEvent {
  at: number
  kind: "asked" | "run" | "handoff" | "home" | "link" | "plan" | "waiting" | "attention" | "closed"
  who: string | null
  text: string
  status?: string | null
  ref?: string
  /** Agents named with @ in the text: hand-offs. */
  mentions: string[]
  /** Issue/MR numbers, commit ids and links found in it, to check against. */
  ids: string[]
  durationMs?: number | null
  /** A2A: sender → receiver. */
  route?: { from: string; to: string }
}

export interface WallFailure {
  agentId: string
  status: string
  signature: string
  count: number
  lastAt: number
  lastTaskId: string
  error: string
}

const clean = (s: string | null | undefined, max = TEXT_MAX): string => (s ? redactSecrets(summarize(s, max)) : "")

export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s(])@([a-z0-9][a-z0-9_-]{1,63})\b/gi)].map((m) => m[1].toLowerCase()))]
}

export function sourceIdsIn(text: string): string[] {
  const ids = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]"']+/g)) ids.add(m[0])
  for (const m of text.matchAll(/(?:^|[\s(])([#!]\d{1,7})\b/g)) ids.add(m[1])
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (/[a-f]/.test(m[0]) && /\d/.test(m[0])) ids.add(m[0])
  return [...ids].slice(0, 12)
}

/** The repository a request belongs to, from its home link or its forge chat. */
export function projectOf(r: Pick<RequestRecord, "home" | "chatId">): string | null {
  const link = r.home?.link ?? ""
  const url = link.match(/^https?:\/\/[^/]+\/(.+?)(?:\/-)?\/(?:issues|merge_requests|pull|pulls)\/\d+/)
  if (url) return url[1]
  const chat = r.chatId.match(/^([^:\s]+\/[^:\s]+):(?:issue|merge_request|pull)(?::|$)/)
  return chat ? chat[1] : null
}

function runsOf(db: Database.Database | null, requestId: string): WallRun[] {
  if (!db) return []
  try {
    return (db.prepare(
      `SELECT l.ref AS taskId, t.agent_id AS agentId, t.status AS status, t.started_at AS startedAt,
              t.finished_at AS finishedAt, t.duration_ms AS durationMs, t.error AS error
       FROM request_links l LEFT JOIN task_traces t ON t.task_id = l.ref
       WHERE l.request_id = ? AND l.kind = 'run' ORDER BY l.at, l.rowid`,
    ).all(requestId) as WallRun[])
  } catch {
    return []
  }
}

const FAILED = new Set(["error", "timeout"])

export function timeFlag(r: RequestRecord, runs: WallRun[], runMs: number, now: number, staleAfterHours: number): string | null {
  const open = (OPEN_STATES as readonly string[]).includes(r.state)
  if (r.estimateMinutes && runMs > r.estimateMinutes * 60_000) return `over estimate: ${Math.round(runMs / 60_000)} of ${r.estimateMinutes} min`
  if (open && runs.length === 0 && now - r.createdAt > staleAfterHours * HOUR) return "no run recorded"
  if (!open && runs.length === 0) return "closed with no run recorded"
  return null
}

/** The agent an unfinished hand-off of this request went to, read from
 *  the A2A chat of its runs. Null: none open, or no run recorded yet. */
function openHandoffTo(db: Database.Database | null, requestId: string): string | null {
  if (!db) return null
  return safe(() => {
    const open = db.prepare("SELECT ref FROM request_links WHERE request_id = ? AND kind = 'delegation' AND ended IS NULL ORDER BY at DESC").all(requestId) as Array<{ ref: string }>
    for (const l of open) {
      const row = db.prepare("SELECT chat_id FROM task_traces WHERE chat_id LIKE ? ORDER BY started_at DESC LIMIT 1").get(`a2a:%:${l.ref}%`) as { chat_id: string } | undefined
      const route = row ? a2aRoute(row.chat_id) : null
      if (route) return route.to
    }
    return null
  }, null)
}

export function wallPost(r: RequestRecord, deps: WallDeps): WallPost {
  const runs = runsOf(deps.db, r.id)
  const runMs = runs.reduce((n, x) => n + (x.durationMs ?? 0), 0)
  const words = cardWords(r)
  const stall = stalledWhy(r, deps.staleAfterHours, deps.now)
  const waiting = r.state === "waiting_owner" || r.state === "waiting_other" || r.state === "needs_attention"
  const lastMoveAt = r.stateChangedAt ?? r.updatedAt
  let blocked: WallPost["blocked"] = null
  if (waiting || stall) {
    const handedTo = r.state === "waiting_other" ? openHandoffTo(deps.db, r.id) : null
    const on = handedTo ? { who: handedTo } : waitsOn(r, { isAgent: deps.isAgent, activeStepAgent: activeStepAgentOf(deps.plans) })
    const why = r.state === "waiting_owner" ? (r.question ?? "waiting on the owner")
      : r.state === "needs_attention" ? (r.attentionReason ?? "needs attention")
      : stall ?? "waiting on another agent"
    blocked = { who: on.who, why: clean(why, 200), since: lastMoveAt }
  }
  const last = [...runs].reverse().find((x) => x.agentId)
  return {
    id: r.id,
    state: r.state,
    headline: redactSecrets(words.headline),
    need: redactSecrets(words.need),
    owner: r.askedAgent ?? r.agentId,
    agentId: r.agentId,
    askedBy: r.person ?? r.sender,
    group: { channel: r.channel, chatId: r.chatId },
    project: projectOf(r),
    home: r.home,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMoveAt,
    closedAt: r.closedAt,
    evidence: r.evidence,
    closeReason: r.closeReason ? clean(r.closeReason, 200) : null,
    blocked,
    estimateMinutes: r.estimateMinutes,
    runMs,
    runs: runs.length,
    failedRuns: runs.filter((x) => x.status && FAILED.has(x.status)).length,
    timeFlag: timeFlag(r, runs, runMs, deps.now, deps.staleAfterHours),
    lastRun: last ? { taskId: last.taskId, agentId: last.agentId! } : null,
  }
}

export function wallPosts(deps: WallDeps, days: number): WallPost[] {
  const open = deps.store.listOpen()
  const closed = deps.store.listClosedSince(deps.now - days * DAY, 200)
  return [...open, ...closed].map((r) => wallPost(r, deps)).sort((a, b) => b.updatedAt - a.updatedAt)
}

function event(e: Omit<WallEvent, "mentions" | "ids">, raw = e.text): WallEvent {
  return { ...e, mentions: mentionsIn(raw), ids: sourceIdsIn(raw) }
}

/** a2a:<from>:<to>:<dialog> → the two agents of a hand-off. */
export function a2aRoute(chatId: string): { from: string; to: string } | null {
  const m = chatId.match(/^a2a:([^:]+):([^:]+):/)
  return m ? { from: m[1], to: m[2] } : null
}

export function wallThread(r: RequestRecord, deps: WallDeps): WallEvent[] {
  const events: WallEvent[] = []
  events.push(event({ at: r.createdAt, kind: "asked", who: r.person ?? r.sender ?? r.channel, text: clean(r.text) }, r.text))
  const db = deps.db
  const links = db ? safe(() => db.prepare(
    "SELECT kind, ref, at, ended, ended_at AS endedAt, proof FROM request_links WHERE request_id = ? ORDER BY at, rowid",
  ).all(r.id) as Array<{ kind: string; ref: string; at: number; ended: string | null; endedAt: number | null; proof: string | null }>, []) : []
  for (const l of links) {
    if (l.kind === "run") {
      const t = db ? safe(() => db.prepare(
        "SELECT agent_id, status, started_at, duration_ms, error, final_response, message_preview FROM task_traces WHERE task_id = ?",
      ).get(l.ref) as any, null) : null
      const said = t?.final_response || t?.message_preview || ""
      events.push(event({
        at: t?.started_at ?? l.at, kind: "run", who: t?.agent_id ?? null, ref: l.ref, status: t?.status ?? null, durationMs: t?.duration_ms ?? null,
        text: t?.error ? clean(`Error: ${t.error}`, 300) : clean(said),
      }, said))
    } else if (l.kind === "delegation") {
      const runs = db ? safe(() => db.prepare(
        "SELECT task_id, agent_id, chat_id, status, started_at, duration_ms, final_response FROM task_traces WHERE chat_id LIKE ? ORDER BY started_at LIMIT 20",
      ).all(`a2a:%:${l.ref}%`) as any[], []) : []
      const route = runs.map((x) => a2aRoute(String(x.chat_id))).find(Boolean) ?? undefined
      const ended = l.ended ? ` — ${l.ended}${l.proof ? `: ${l.proof}` : ""}` : ""
      events.push(event({ at: l.at, kind: "handoff", who: route?.from ?? r.agentId, route, ref: l.ref, status: l.ended, text: `Asked ${route?.to ?? "another agent"} (${l.ref})${ended}` }))
      for (const x of runs) {
        events.push(event({
          at: x.started_at, kind: "run", who: x.agent_id, ref: x.task_id, status: x.status, durationMs: x.duration_ms,
          route: a2aRoute(String(x.chat_id)) ?? undefined, text: clean(x.final_response),
        }, x.final_response ?? ""))
      }
    } else if (["issue", "idea", "approval", "erp"].includes(l.kind)) {
      events.push(event({ at: l.at, kind: "home", who: null, ref: l.ref, text: `Home: ${l.kind}` }, ""))
    } else {
      events.push(event({ at: l.at, kind: "link", who: null, ref: l.ref, status: l.ended, text: `${l.kind} ${l.ref}${l.ended ? ` — ${l.ended}` : ""}` }))
    }
  }
  const plan = deps.plans?.get(r.id) ? deps.plans : null
  if (plan) {
    const names = new Map(plan.steps(r.id).map((s) => [s.idx, s] as const))
    for (const e of plan.events(r.id)) {
      const step = e.step !== null ? names.get(e.step) : undefined
      events.push(event({ at: e.at, kind: "plan", who: step?.agentId ?? null, text: clean(`${step ? `Step ${e.step} ${step.name}: ` : ""}${e.kind} ${e.detail}`) }, e.detail))
    }
  }
  const changed = r.stateChangedAt ?? r.updatedAt
  if (r.state === "waiting_owner" && r.question) events.push(event({ at: changed, kind: "waiting", who: r.agentId, text: clean(`Asks the owner: ${r.question}`) }, r.question))
  if (r.state === "needs_attention") events.push(event({ at: changed, kind: "attention", who: null, text: clean(`Needs attention: ${r.attentionReason ?? ""}`) }))
  if (r.closedAt) {
    const why = r.evidence ?? r.closeReason ?? ""
    events.push(event({ at: r.closedAt, kind: "closed", who: r.agentId, status: r.state, text: clean(`${r.state}${why ? `: ${why}` : ""}`) }, why))
  }
  return events.sort((a, b) => a.at - b.at)
}

/** Failed agent runs in the last day, one row per agent and error shape,
 *  plus webhook runs that ended without a reply. */
export function wallFailures(db: Database.Database | null, now: number): WallFailure[] {
  if (!db) return []
  const rows = safe(() => db.prepare(
    `SELECT task_id, agent_id, status, error, started_at, channel FROM task_traces
     WHERE started_at >= ? AND (status IN ('error', 'timeout')
       OR (status = 'ok' AND channel LIKE '%webhook%' AND (final_response IS NULL OR final_response = '')))
     ORDER BY started_at DESC LIMIT ?`,
  ).all(now - DAY, FAILED_LIMIT) as any[], [])
  const groups = new Map<string, WallFailure>()
  for (const x of rows) {
    const error = x.status === "ok" ? "webhook run ended without a reply" : String(x.error || x.status)
    const signature = error.toLowerCase().replace(/[0-9a-f]{8,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 80)
    const key = `${x.agent_id}|${signature}`
    const g = groups.get(key)
    if (g) { g.count++; continue }
    groups.set(key, { agentId: x.agent_id, status: x.status, signature, count: 1, lastAt: x.started_at, lastTaskId: x.task_id, error: clean(error, 300) })
  }
  return [...groups.values()]
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

export function handleWallApi(path: string, q: URLSearchParams, deps: WallDeps | null, node: string): { status: number; body: unknown } {
  const syncedAt = deps?.now ?? Date.now()
  if (path === WALL_PREFIX) {
    const days = Math.max(0, Math.min(WALL_DAYS_MAX, Number(q.get("days") ?? 7) || 0))
    if (!deps) return { status: 200, body: { node, syncedAt, posts: [], failures: [], staleAfterHours: null } }
    return { status: 200, body: { node, syncedAt, posts: wallPosts(deps, days), failures: wallFailures(deps.db, deps.now), staleAfterHours: deps.staleAfterHours } }
  }
  if (path === `${WALL_PREFIX}/thread`) {
    if (!deps) return { status: 404, body: { error: "no requests on this node" } }
    const id = q.get("id")
    const task = q.get("task")
    const r = id ? deps.store.get(id) : task ? deps.store.byLink("run", task) : null
    if (!r) return { status: 404, body: { error: "no post for that id" } }
    return { status: 200, body: { node, syncedAt, post: wallPost(r, deps), events: wallThread(r, deps) } }
  }
  return { status: 404, body: { error: "not found" } }
}
