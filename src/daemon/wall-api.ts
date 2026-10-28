import type Database from "better-sqlite3"
import { redactSecrets } from "@/agents/memory-trust"
import type { DecisionCard, IfSilent } from "@/approvals/cards"
import { cardWords, summarize } from "@/requests/card-view"
import { activeStepAgentOf, stalledWhy, waitsOn } from "@/requests/loops"
import { awaitingQa, type QaRecord } from "@/requests/qa"
import type { PlanStore } from "@/requests/plan-store"
import { OPEN_STATES, type RequestRecord, type RequestStore } from "@/requests/store"
import { chatKey, findOverlaps, worktreeKey, type RunOverlap, type RunSpan } from "./concurrent-runs"
import type { WallForgeTime, WallForgeTimeSource } from "./wall-forge-time"
import { forgeCommentsOf, forgeCommentsOfAll, type WallForgeComment, type WallForgeState, type WallForgeStateSource } from "./wall-forge-state"
import { isStalled, projectOverview, repoOfChat, type WallProjects } from "./wall-projects"
import { wallClosures, wallThroughput } from "./wall-throughput"
import { blockerOf, type WallBlocker } from "./wall-blocks"
import { wallCapacity } from "./wall-capacity"
import { mergeGoals, wallGoalOf } from "./wall-goals"
import type { RequestGoal } from "@/requests/goals"

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
//
// `?quick=1` on the list (#1442) waits only briefly for the forge and for
// peers: what is cached shows now, and `pending: true` says the page should
// ask again in a moment.
//
// A pending decision card (#1185) sits on the post of the request it was
// raised from, read-only: its recommendation, what applies if the owner
// stays silent, and when. Answering stays on the Desk and Approvals page.
//
// A post's project and its stalled mark come from the project mapping
// (#1190, ./wall-projects); the list reply carries one overview row per
// project with its open, in progress, blocked and stalled counts.
//
// Capacity per owner (#1191, ./wall-capacity): each post carries the agent
// of its active plan step, and the list reply one row per agent with its
// work in progress, the items waiting on it and an over-capacity flag.
//
// A post leads with its result (#1242): what its own last run answered,
// else what it was closed with. The request it answers is the post's own
// record, opened from the result. No result recorded: the request alone.
//
// Goals (#1392, ./wall-goals): a post carries the goal its request serves,
// and the list reply one row per goal with its progress and cost.

export const WALL_PREFIX = "/api/admin/wall"
const HOUR = 3_600_000
const DAY = 24 * HOUR
export const WALL_DAYS_MAX = 30
const TEXT_MAX = 600
const FAILED_LIMIT = 200

export interface WallDeps {
  store: Pick<RequestStore, "listOpen" | "listClosedSince" | "get" | "byLink"> & Partial<Pick<RequestStore, "goalCounts">>
  plans?: Pick<PlanStore, "get" | "steps" | "events"> | null
  db: Database.Database | null
  now: number
  staleAfterHours: number
  isAgent: (id: string) => boolean
  /** The workspace folder an agent runs in: its worktree (#1187). */
  workspaceOf?: (id: string) => string | null | undefined
  /** Pending decision cards on this node (#1185). Unset: none shown. */
  cards?: (() => DecisionCard[]) | null
  /** This node's GitLab address, for GitLab homes and comment links (#1184). */
  gitlabUrl?: string | null
  /** The project mapping (#1190). Unset: a post's project is its home repo. */
  projects?: WallProjects | null
  /** Over-capacity threshold (#1191). Unset: the flag is off. */
  capacityThreshold?: number | null
}

/** A pending owner decision card, as the Wall shows it: no answer here. */
export interface WallOwnerCard {
  id: string
  title: string
  ask: string
  recommend: string
  ifSilent: IfSilent
  /** What happens if the owner does not answer, in words. */
  silence: string
  expiresAt: number
  raisedBy: string
  createdAt: number
  source: string | null
  /** The ready-made answers on offer; a yes picks one by its number
   *  (#1440). Empty: a plain yes or no. */
  choices: string[]
  /** The suggested message, `{choice}` not yet filled in. Null: none. */
  draft: string | null
}

export interface WallRun {
  taskId: string
  agentId: string | null
  status: string | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  error: string | null
  channel: string | null
  chatId: string | null
  /** The run's final reply. Never sent as is: only a post's result reads it. */
  reply: string | null
}

/** What a post delivered or answered (#1242): its own last run that ended
 *  ok with a reply, else the proof or reason it was closed with. */
export interface WallResult {
  text: string
  at: number
  from: "reply" | "close"
  /** The run the reply came from. Null for a close. */
  taskId: string | null
  agentId: string | null
}

export interface WallPost {
  id: string
  state: string
  headline: string
  /** The headline was set by an agent or the model, not cut from the
   *  request's text: only then is it a title (#1194). */
  titled: boolean
  need: string
  /** The named owner: the agent it was handed to, or the one it was asked of. */
  owner: string
  agentId: string
  askedBy: string | null
  /** The chat it came from: the post's group. */
  group: { channel: string; chatId: string }
  /** From the project mapping, else the home repo (#1190). Null: none. */
  project: string | null
  /** The home repo, as "group/project", whatever the mapping says. */
  repo: string | null
  /** Its project's normal rhythm, in hours (#1190). */
  rhythmHours: number
  /** The goal its request serves (#1168, #1392). Null: none named. */
  goal: RequestGoal | null
  /** Open, with no move for more than twice the rhythm. */
  stalled: boolean
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
  /** What a record says it waits on, with that agent's project (#1193).
   *  Null when blocked with no record of a blocker, or not blocked. */
  blockedBy: WallBlocker | null
  /** The agent of the active plan step, while open (#1191). Null: none. */
  stepAgent: string | null
  estimateMinutes: number | null
  runMs: number
  runs: number
  failedRuns: number
  /** Estimate against measured run time, in words. Null: nothing to flag. */
  timeFlag: string | null
  /** The forge's own time tracking (#1189): GitLab homes only. Null: the
   *  home has no time tracking this node can read. */
  forgeTime: WallForgeTime | null
  /** The home's live state on GitHub or GitLab, who closed it and when it
   *  was checked (#1184). Null: no forge home this node can read. */
  forgeState: WallForgeState | null
  /** Comments agents posted on the home through the daemon, newest first,
   *  each linked by its own id (#1184). */
  comments: WallForgeComment[]
  lastRun: { taskId: string; agentId: string } | null
  /** The result, which the feed shows first; the request sits behind it.
   *  Null: nothing delivered or answered yet. */
  result: WallResult | null
  /** Runs of this post that overlapped another run on the same chat or in
   *  the same worktree, with both run ids (#1187). Empty: none. */
  concurrent: RunOverlap[]
  /** Pending owner decision cards raised from this request (#1185). */
  ownerCards: WallOwnerCard[]
  /** The latest QA verdict, with who gave it and when (#1188). */
  qa: QaRecord | null
  /** Marked as needing QA, with no verdict since. */
  awaitingQa: boolean
}

/** One step of a post's plan, as the opened task shows it (#1355). */
export interface WallPlanStep {
  idx: number
  name: string
  agentId: string
  state: string
  doneWhen: string
  evidence: string | null
  /** Why it is blocked or skipped. */
  note: string | null
}

export interface WallEvent {
  at: number
  kind: "asked" | "run" | "handoff" | "home" | "link" | "comment" | "plan" | "waiting" | "attention" | "closed"
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

// Redact before cutting: a token cut at `max` may no longer match a pattern.
const clean = (s: string | null | undefined, max = TEXT_MAX): string => (s ? summarize(redactSecrets(s), max) : "")

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
  return repoOfChat(r.chatId)
}

const RUN_COLUMNS = `l.ref AS taskId, t.agent_id AS agentId, t.status AS status, t.started_at AS startedAt,
              t.finished_at AS finishedAt, t.duration_ms AS durationMs, t.error AS error,
              t.channel AS channel, t.chat_id AS chatId, t.final_response AS reply`

function runsOf(db: Database.Database | null, requestId: string): WallRun[] {
  if (!db) return []
  try {
    return (db.prepare(
      `SELECT ${RUN_COLUMNS}
       FROM request_links l LEFT JOIN task_traces t ON t.task_id = l.ref
       WHERE l.request_id = ? AND l.kind = 'run' ORDER BY l.at, l.rowid`,
    ).all(requestId) as WallRun[])
  } catch {
    return []
  }
}

/** Ids per IN (…) list, well under SQLite's bound on parameters. */
const CHUNK = 500
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

/** runsOf for many requests in one read per chunk (#1252): the same rows,
 *  in the same order, keyed by request. A failed read gives no runs. */
export function runsOfAll(db: Database.Database | null, requestIds: string[]): Map<string, WallRun[]> {
  const out = new Map<string, WallRun[]>(requestIds.map((id) => [id, []]))
  if (!db) return out
  for (const ids of chunks(requestIds)) {
    const rows = safe(() => db.prepare(
      `SELECT l.request_id AS requestId, ${RUN_COLUMNS}
       FROM request_links l LEFT JOIN task_traces t ON t.task_id = l.ref
       WHERE l.request_id IN (${ids.map(() => "?").join(",")}) AND l.kind = 'run' ORDER BY l.at, l.rowid`,
    ).all(...ids) as Array<WallRun & { requestId: string }>, [])
    for (const { requestId, ...run } of rows) out.get(requestId)?.push(run)
  }
  return out
}

const FAILED = new Set(["error", "timeout"])

/** A result as written, line breaks and links kept (summarize() drops
 *  markdown marks, "_" in links too), cut to the post's length. */
function resultText(s: string): string {
  const text = redactSecrets(s.trim().replace(/\n{3,}/g, "\n\n"))
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1).trimEnd()}…` : text
}

/** The post's result: the newest of its own runs that ended ok with a
 *  reply, else what it was closed with. Nothing recorded: null, no guess. */
export function resultOf(r: Pick<RequestRecord, "closedAt" | "evidence" | "closeReason">, runs: WallRun[]): WallResult | null {
  const run = [...runs].reverse().find((x) => x.status === "ok" && x.reply?.trim())
  if (run) return { text: resultText(run.reply!), at: run.finishedAt ?? run.startedAt ?? 0, from: "reply", taskId: run.taskId, agentId: run.agentId }
  const why = r.evidence ?? r.closeReason
  if (r.closedAt && why?.trim()) return { text: resultText(why), at: r.closedAt, from: "close", taskId: null, agentId: null }
  return null
}

/** How far back a run that overlaps one of a post's runs may have started. */
const OVERLAP_LOOKBACK = DAY
const OVERLAP_CANDIDATES = 200
const traceAgents = new WeakMap<WallDeps, string[]>()

function spanOf(t: { taskId: string; agentId: string | null; channel: string | null; chatId: string | null; status: string | null; startedAt: number | null; finishedAt: number | null; durationMs: number | null }, deps: WallDeps): RunSpan | null {
  if (!t.agentId || t.startedAt == null) return null
  const endedAt = t.finishedAt ?? (t.status === "in-flight" ? null : t.startedAt + (t.durationMs ?? 0))
  return { runId: t.taskId, agentId: t.agentId, chat: chatKey(t.channel, t.chatId), worktree: worktreeOf(t.agentId, deps), startedAt: t.startedAt, endedAt }
}

/** An agent's worktree key, worked out once per call: every candidate run
 *  needs it (#1252). */
const worktrees = new WeakMap<WallDeps, Map<string, string | null>>()
function worktreeOf(agentId: string, deps: WallDeps): string | null {
  let map = worktrees.get(deps)
  if (!map) worktrees.set(deps, (map = new Map()))
  if (!map.has(agentId)) map.set(agentId, worktreeKey(deps.workspaceOf?.(agentId)))
  return map.get(agentId)!
}

type TraceSpanRow = Parameters<typeof spanOf>[0]
const TRACE_SPAN_COLUMNS = `task_id AS taskId, agent_id AS agentId, channel, chat_id AS chatId, status, started_at AS startedAt,
            finished_at AS finishedAt, duration_ms AS durationMs`

function traceAgentsOf(db: Database.Database, deps: WallDeps): string[] {
  const agents = traceAgents.get(deps) ?? safe(() => (db.prepare("SELECT DISTINCT agent_id AS a FROM task_traces").all() as Array<{ a: string }>).map((x) => x.a), [] as string[])
  traceAgents.set(deps, agents)
  return agents
}

/** The overlaps of `own` with the candidate runs read for each of them. */
function overlapsOf(own: RunSpan[], candidates: (s: RunSpan) => Array<RunSpan | null>, deps: WallDeps): RunOverlap[] {
  const spans = new Map(own.map((s) => [s.runId, s] as const))
  for (const s of own) {
    for (const o of candidates(s)) {
      if (!o || spans.has(o.runId)) continue
      if ((s.chat && o.chat === s.chat) || (s.worktree && o.worktree === s.worktree)) spans.set(o.runId, o)
    }
  }
  const mine = new Set(own.map((s) => s.runId))
  return findOverlaps([...spans.values()], deps.now).filter((x) => mine.has(x.runs[0]) || mine.has(x.runs[1]))
}

const ownSpans = (runs: WallRun[], deps: WallDeps): RunSpan[] => runs.map((r) => spanOf(r, deps)).filter((s): s is RunSpan => s !== null)

/** The post's runs that overlapped another run on one chat or in one
 *  worktree. Only run ids, agents and times leave here: no text. */
export function concurrentOf(runs: WallRun[], deps: WallDeps): RunOverlap[] {
  const db = deps.db
  const own = ownSpans(runs, deps)
  if (!db || own.length === 0) return []
  const agents = traceAgentsOf(db, deps)
  if (agents.length === 0) return []
  // agent_id IN (…) keeps the read on idx_traces_agent_started. Only runs
  // still going when this one started: a busy node logs 500+ runs a day,
  // so the oldest rows of the lookback would crowd out the real overlaps.
  const q = safe(() => db.prepare(
    `SELECT ${TRACE_SPAN_COLUMNS}
     FROM task_traces WHERE agent_id IN (${agents.map(() => "?").join(",")}) AND started_at >= ? AND started_at < ?
       AND (status = 'in-flight' OR COALESCE(finished_at, started_at + COALESCE(duration_ms, 0)) > ?)
     ORDER BY started_at DESC LIMIT ${OVERLAP_CANDIDATES}`,
  ), null)
  if (!q) return []
  return overlapsOf(own, (s) => safe(() => q.all(...agents, s.startedAt - OVERLAP_LOOKBACK, s.endedAt ?? deps.now, s.startedAt) as TraceSpanRow[], []).map((row) => spanOf(row, deps)), deps)
}

/** concurrentOf for every post at once (#1252). Instead of one read per
 *  run, the runs' lookback windows are merged and each merged window is
 *  read once; each run then takes, from those rows, exactly what its own
 *  read would have returned (same window, same filter, newest first, same
 *  cap). */
export function concurrentOfAll(runsByPost: Map<string, WallRun[]>, deps: WallDeps): Map<string, RunOverlap[]> {
  const out = new Map<string, RunOverlap[]>()
  const owns = new Map<string, RunSpan[]>()
  for (const [id, runs] of runsByPost) { out.set(id, []); owns.set(id, ownSpans(runs, deps)) }
  const db = deps.db
  const all = [...owns.values()].flat()
  if (!db || all.length === 0) return out
  const agents = traceAgentsOf(db, deps)
  if (agents.length === 0) return out
  const windowOf = (s: RunSpan): [number, number] => [s.startedAt - OVERLAP_LOOKBACK, s.endedAt ?? deps.now]
  const merged: Array<[number, number]> = []
  for (const [lo, hi] of all.map(windowOf).filter(([lo, hi]) => lo < hi).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else merged.push([lo, hi])
  }
  const q = safe(() => db.prepare(
    `SELECT ${TRACE_SPAN_COLUMNS}
     FROM task_traces WHERE agent_id IN (${agents.map(() => "?").join(",")}) AND started_at >= ? AND started_at < ?
     ORDER BY started_at DESC`,
  ), null)
  if (!q) return out
  // Newest first across all windows: the windows are disjoint, so read
  // them newest window first.
  const rows: TraceSpanRow[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    for (const row of safe(() => q.all(...agents, merged[i][0], merged[i][1]) as TraceSpanRow[], [])) rows.push(row)
  }
  // Worked out once per row, not once per run that reads it.
  const starts = rows.map((t) => t.startedAt!)
  const ends = rows.map((t) => (t.status === "in-flight" ? Infinity : t.finishedAt ?? t.startedAt! + (t.durationMs ?? 0)))
  const rowSpans: Array<RunSpan | null | undefined> = new Array(rows.length)
  const candidates = (s: RunSpan): Array<RunSpan | null> => {
    const [lo, hi] = windowOf(s)
    // The first row that started before `hi` (rows run newest first).
    let a = 0, b = rows.length
    while (a < b) { const m = (a + b) >> 1; if (starts[m] >= hi) a = m + 1; else b = m }
    const got: Array<RunSpan | null> = []
    for (let i = a; i < rows.length && starts[i] >= lo && got.length < OVERLAP_CANDIDATES; i++) {
      if (ends[i] <= s.startedAt) continue
      if (rowSpans[i] === undefined) rowSpans[i] = spanOf(rows[i], deps)
      got.push(rowSpans[i]!)
    }
    return got
  }
  for (const [id, own] of owns) if (own.length) out.set(id, overlapsOf(own, candidates, deps))
  return out
}

export function timeFlag(r: RequestRecord, runs: WallRun[], runMs: number, now: number, staleAfterHours: number): string | null {
  const open = (OPEN_STATES as readonly string[]).includes(r.state)
  if (r.estimateMinutes && runMs > r.estimateMinutes * 60_000) return `over estimate: ${Math.round(runMs / 60_000)} of ${r.estimateMinutes} min`
  if (open && runs.length === 0 && now - r.createdAt > staleAfterHours * HOUR) return "no run recorded"
  if (!open && runs.length === 0) return "closed with no run recorded"
  return null
}

/** A hand-off's chat is a2a:<from>:<to>:<dialog id>; match the id whole,
 *  so a longer id that starts with the same text is not taken. */
const HANDOFF_CHAT = "chat_id LIKE 'a2a:%' AND substr(chat_id, -?) = ?"
const handoffArgs = (ref: string): [number, string] => [ref.length + 1, `:${ref}`]

/** The agent an unfinished hand-off of this request went to, read from
 *  the A2A chat of its runs. Null: none open, or no run recorded yet. */
function openHandoffTo(db: Database.Database | null, requestId: string): string | null {
  if (!db) return null
  return safe(() => {
    const open = db.prepare("SELECT ref FROM request_links WHERE request_id = ? AND kind = 'delegation' AND ended IS NULL ORDER BY at DESC").all(requestId) as Array<{ ref: string }>
    for (const l of open) {
      const row = db.prepare(`SELECT chat_id FROM task_traces WHERE ${HANDOFF_CHAT} ORDER BY started_at DESC LIMIT 1`).get(...handoffArgs(l.ref)) as { chat_id: string } | undefined
      const route = row ? a2aRoute(row.chat_id) : null
      if (route) return route.to
    }
    return null
  }, null)
}

/** openHandoffTo for many requests (#1252): one read of their open
 *  delegations, and one pass over the A2A runs for all of them, instead
 *  of a scan of task_traces per delegation. */
export function openHandoffsTo(db: Database.Database | null, requestIds: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>(requestIds.map((id) => [id, null]))
  if (!db || requestIds.length === 0) return out
  return safe(() => {
    const refsOf = new Map<string, string[]>()
    for (const ids of chunks(requestIds)) {
      const rows = db.prepare(
        `SELECT request_id AS requestId, ref FROM request_links WHERE request_id IN (${ids.map(() => "?").join(",")}) AND kind = 'delegation' AND ended IS NULL ORDER BY at DESC`,
      ).all(...ids) as Array<{ requestId: string; ref: string }>
      for (const l of rows) {
        const refs = refsOf.get(l.requestId)
        if (refs) refs.push(l.ref)
        else refsOf.set(l.requestId, [l.ref])
      }
    }
    const want = new Set([...refsOf.values()].flat())
    if (want.size === 0) return out
    // The latest A2A chat whose id ends in ":<ref>", per ref.
    const chatOf = new Map<string, string>()
    for (const row of db.prepare("SELECT chat_id FROM task_traces WHERE chat_id LIKE 'a2a:%' ORDER BY started_at DESC").iterate() as Iterable<{ chat_id: string }>) {
      for (let p = row.chat_id.indexOf(":"); p >= 0; p = row.chat_id.indexOf(":", p + 1)) {
        const ref = row.chat_id.slice(p + 1)
        if (want.has(ref) && !chatOf.has(ref)) chatOf.set(ref, row.chat_id)
      }
      if (chatOf.size === want.size) break
    }
    for (const [id, refs] of refsOf) {
      for (const ref of refs) {
        const chat = chatOf.get(ref)
        const route = chat ? a2aRoute(chat) : null
        if (route) { out.set(id, route.to); break }
      }
    }
    return out
  }, out)
}

/** In plain words, what a card's `if_silent` does when it expires. A card
 *  never approves itself (#741). */
export const SILENCE_WORDS: Record<IfSilent, string> = {
  discard: "the agent drops it",
  keep: "things stay as they are; nothing is approved",
  pause: "the agent pauses this piece of work",
}

const cardsByRequest = new WeakMap<WallDeps, Map<string, WallOwnerCard[]>>()

/** The request a card was raised from: its "card" link, or the plan whose
 *  step it asks about. Null: not tied to a request on this node. */
function requestOfCard(c: DecisionCard, deps: WallDeps): string | null {
  const linked = safe(() => deps.store.byLink("card", c.id)?.id ?? null, null)
  if (linked) return linked
  return c.origin?.kind === "plan-step" ? c.origin.requestId : null
}

/** Pending cards keyed by the request they belong to, read once per call. */
export function ownerCardsOf(requestId: string, deps: WallDeps): WallOwnerCard[] {
  let map = cardsByRequest.get(deps)
  if (!map) {
    map = new Map()
    const cards = deps.cards ? safe(deps.cards, []) : []
    for (const c of cards) {
      if (c.status !== "pending") continue
      const id = requestOfCard(c, deps)
      if (!id) continue
      const list = map.get(id) ?? []
      list.push({
        id: c.id,
        title: clean(c.title, 120),
        ask: clean(c.ask, 300),
        recommend: clean(c.recommend, 300),
        ifSilent: c.if_silent,
        silence: SILENCE_WORDS[c.if_silent] ?? c.if_silent,
        expiresAt: Date.parse(c.expires),
        raisedBy: c.raised_by,
        createdAt: Date.parse(c.created_at),
        source: c.source ? redactSecrets(c.source) : null,
        choices: (c.choices ?? []).map((x) => redactSecrets(x)),
        draft: c.draft ? redactSecrets(c.draft) : null,
      })
      map.set(id, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.expiresAt - b.expiresAt)
    cardsByRequest.set(deps, map)
  }
  return map.get(requestId) ?? []
}

/** What a post reads from the database. wallPosts reads it for all posts
 *  at once (#1252); a single post (a thread) reads its own. */
export interface WallPostReads {
  runs: WallRun[]
  concurrent: RunOverlap[]
  /** Only read for posts waiting on another agent. */
  handedTo: string | null
  comments: WallForgeComment[]
}

const forgeCommentPost = (r: RequestRecord) => ({ home: r.home, group: { channel: r.channel, chatId: r.chatId }, createdAt: r.createdAt, closedAt: r.closedAt })

export function wallPost(r: RequestRecord, deps: WallDeps, reads?: WallPostReads): WallPost {
  const runs = reads ? reads.runs : runsOf(deps.db, r.id)
  const runMs = runs.reduce((n, x) => n + (x.durationMs ?? 0), 0)
  const words = cardWords(r)
  const stall = stalledWhy(r, deps.staleAfterHours, deps.now)
  const waiting = r.state === "waiting_owner" || r.state === "waiting_other" || r.state === "needs_attention"
  const lastMoveAt = r.stateChangedAt ?? r.updatedAt
  const repo = projectOf(r)
  const project = deps.projects ? deps.projects.of(r, repo) : { name: repo, rhythmHours: deps.staleAfterHours }
  let blocked: WallPost["blocked"] = null
  let blockedBy: WallBlocker | null = null
  const stepAgent = (OPEN_STATES as readonly string[]).includes(r.state) ? safe(() => activeStepAgentOf(deps.plans)(r.id), null) : null
  if (waiting || stall) {
    const handedTo = r.state !== "waiting_other" ? null : reads ? reads.handedTo : openHandoffTo(deps.db, r.id)
    const look = waitsOn(r, { isAgent: deps.isAgent, activeStepAgent: () => stepAgent })
    const on = handedTo ? { who: handedTo } : look
    const why = r.state === "waiting_owner" ? (r.question ?? "waiting on the owner")
      : r.state === "needs_attention" ? (r.attentionReason ?? "needs attention")
      : stall ?? "waiting on another agent"
    blocked = { who: on.who, why: clean(why, 200), since: lastMoveAt }
    blockedBy = blockerOf({ owner: r.askedAgent ?? r.agentId, project: project.name, handedTo, stepAgent, waitsOn: look }, deps.projects)
  }
  const last = [...runs].reverse().find((x) => x.agentId)
  return {
    id: r.id,
    state: r.state,
    headline: redactSecrets(words.headline),
    titled: !!r.headline,
    need: redactSecrets(words.need),
    owner: r.askedAgent ?? r.agentId,
    agentId: r.agentId,
    askedBy: r.person ?? r.sender,
    group: { channel: r.channel, chatId: r.chatId },
    project: project.name,
    repo,
    rhythmHours: project.rhythmHours,
    goal: r.goal ? { id: r.goal.id, title: redactSecrets(r.goal.title) } : null,
    stalled: isStalled({ state: r.state, lastMoveAt, rhythmHours: project.rhythmHours }, deps.now),
    home: r.home,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMoveAt,
    closedAt: r.closedAt,
    evidence: r.evidence ? redactSecrets(r.evidence) : null,
    closeReason: r.closeReason ? clean(r.closeReason, 200) : null,
    blocked,
    blockedBy,
    stepAgent,
    estimateMinutes: r.estimateMinutes,
    runMs,
    runs: runs.length,
    failedRuns: runs.filter((x) => x.status && FAILED.has(x.status)).length,
    timeFlag: timeFlag(r, runs, runMs, deps.now, deps.staleAfterHours),
    forgeTime: null,
    forgeState: null,
    comments: reads ? reads.comments : forgeCommentsOf(forgeCommentPost(r), deps.db, deps.gitlabUrl, deps.now),
    lastRun: last ? { taskId: last.taskId, agentId: last.agentId! } : null,
    result: resultOf(r, runs),
    concurrent: reads ? reads.concurrent : concurrentOf(runs, deps),
    ownerCards: ownerCardsOf(r.id, deps),
    qa: r.qa ? { ...r.qa, note: r.qa.note ? redactSecrets(r.qa.note) : null } : null,
    awaitingQa: awaitingQa(r),
  }
}

/** Milliseconds per part of a Wall build, for `?timings=1` (#1252). */
export type WallTimings = Record<string, number>

/** Runs `fn`, adding the time it took to `timings[part]`. */
export function timed<T>(timings: WallTimings | undefined, part: string, fn: () => T): T {
  if (!timings) return fn()
  const t0 = performance.now()
  try { return fn() } finally { timings[part] = Math.round(((timings[part] ?? 0) + performance.now() - t0) * 10) / 10 }
}

export function wallPosts(deps: WallDeps, days: number, timings?: WallTimings): WallPost[] {
  const requests = timed(timings, "requests", () => [...deps.store.listOpen(), ...deps.store.listClosedSince(deps.now - days * DAY, 200)])
  // Each read once for every post, not once per post (#1252).
  const ids = requests.map((r) => r.id)
  const runs = timed(timings, "runs", () => runsOfAll(deps.db, ids))
  const concurrent = timed(timings, "concurrent", () => concurrentOfAll(runs, deps))
  const handedTo = timed(timings, "handoffs", () => openHandoffsTo(deps.db, requests.filter((r) => r.state === "waiting_other").map((r) => r.id)))
  const comments = timed(timings, "comments", () => forgeCommentsOfAll(requests.map(forgeCommentPost), deps.db, deps.gitlabUrl, deps.now))
  return timed(timings, "cards", () => requests.map((r, i) => wallPost(r, deps, {
    runs: runs.get(r.id) ?? [], concurrent: concurrent.get(r.id) ?? [], handedTo: handedTo.get(r.id) ?? null, comments: comments[i],
  })).sort((a, b) => b.updatedAt - a.updatedAt))
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
    if (l.kind === "run" || l.kind === "step_run") {
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
        `SELECT task_id, agent_id, chat_id, status, started_at, duration_ms, final_response FROM task_traces WHERE ${HANDOFF_CHAT} ORDER BY started_at LIMIT 20`,
      ).all(...handoffArgs(l.ref)) as any[], []) : []
      const route = runs.map((x) => a2aRoute(String(x.chat_id))).find(Boolean) ?? undefined
      const ended = l.ended ? ` — ${l.ended}${l.proof ? `: ${redactSecrets(l.proof)}` : ""}` : ""
      events.push(event({ at: l.at, kind: "handoff", who: route?.from ?? r.agentId, route, ref: l.ref, status: l.ended, text: `Asked ${route?.to ?? "another agent"} (${l.ref})${ended}` }))
      for (const x of runs) {
        events.push(event({
          at: x.started_at, kind: "run", who: x.agent_id, ref: x.task_id, status: x.status, durationMs: x.duration_ms,
          route: a2aRoute(String(x.chat_id)) ?? undefined, text: clean(x.final_response),
        }, x.final_response ?? ""))
      }
    } else if (l.kind === "comment") {
      // The owner's comment from the Wall (#1316): its words are the proof.
      events.push(event({ at: l.at, kind: "comment", who: "owner", ref: l.ref, text: clean(redactSecrets(l.proof ?? "")) }, l.proof ?? ""))
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

const EVIDENCE_MAX = 500

/** The post's plan steps, in order. Empty: it has no plan. */
export function wallPlan(r: RequestRecord, deps: WallDeps): WallPlanStep[] {
  if (!deps.plans?.get(r.id)) return []
  return deps.plans.steps(r.id).map((s) => ({
    idx: s.idx,
    name: clean(s.name, 200),
    agentId: s.agentId,
    state: s.state,
    doneWhen: clean(s.doneWhen, 200),
    // Clamped, not `clean`ed: markdown stripping would break a proof URL.
    // Redacted before the cut, so a secret across the limit is still caught.
    evidence: s.evidence ? redactSecrets(s.evidence.trim()).slice(0, EVIDENCE_MAX) : null,
    note: s.note ? clean(s.note, 200) : null,
  }))
}

/** Webhook runs are stored under their forge's channel, not "webhook". */
const WEBHOOK_CHANNELS = "'github', 'gitlab'"

/** The shape of a failure text: lower case, ids and numbers as "#". */
export const failureSignature = (text: string): string =>
  text.toLowerCase().replace(/[0-9a-f]{8,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 80)

/** Failed agent runs in the last day, one row per agent and error shape,
 *  plus webhook runs that ended without a reply. */
export function wallFailures(db: Database.Database | null, now: number): WallFailure[] {
  if (!db) return []
  const rows = safe(() => db.prepare(
    `SELECT task_id, agent_id, status, error, started_at, channel FROM task_traces
     WHERE started_at >= ? AND (status IN ('error', 'timeout')
       OR (status = 'ok' AND (channel IN (${WEBHOOK_CHANNELS}) OR channel LIKE '%webhook%') AND (final_response IS NULL OR final_response = '')))
     ORDER BY started_at DESC LIMIT ?`,
  ).all(now - DAY, FAILED_LIMIT) as any[], [])
  const groups = new Map<string, WallFailure>()
  for (const x of rows) {
    const error = x.status === "ok" ? "webhook run ended without a reply" : String(x.error || x.status)
    const signature = failureSignature(error)
    const key = `${x.agent_id}|${signature}`
    const g = groups.get(key)
    if (g) { g.count++; continue }
    groups.set(key, { agentId: x.agent_id, status: x.status, signature, count: 1, lastAt: x.started_at, lastTaskId: x.task_id, error: clean(error, 300) })
  }
  return [...groups.values()]
}

/** A Wall reply with what the forge says set on its posts: GitLab time
 *  (#1189) and home state (#1184). A missing source (no connector) leaves
 *  its field null. The sources read side by side, each in its own time box. */
export async function withForge(
  reply: { status: number; body: any }, deps: WallDeps | null, sources: Array<WallForgeTimeSource | WallForgeStateSource | null>, quick?: boolean,
): Promise<{ status: number; body: unknown }> {
  if (!deps || reply.status !== 200) return reply
  const posts: WallPost[] = Array.isArray(reply.body?.posts) ? reply.body.posts : reply.body?.post ? [reply.body.post] : []
  if (posts.length) await Promise.all(sources.map((s) => s?.annotate(posts, deps.now, deps.staleAfterHours, quick)))
  return reply
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/** This node's goal rows (#1392), as the fleet merge shapes them. A store
 *  without goals, or a failed read, gives none. */
export function wallGoals(deps: WallDeps): ReturnType<typeof mergeGoals> {
  const read = deps.store.goalCounts
  if (!read) return []
  return mergeGoals([safe(() => read.call(deps.store).map((g) => ({ ...wallGoalOf(g), title: redactSecrets(g.title) })), [])])
}

export function handleWallApi(path: string, q: URLSearchParams, deps: WallDeps | null, node: string): { status: number; body: unknown } {
  const syncedAt = deps?.now ?? Date.now()
  if (path === WALL_PREFIX) {
    const days = Math.max(0, Math.min(WALL_DAYS_MAX, Number(q.get("days") ?? 7) || 0))
    if (!deps) return { status: 200, body: { node, syncedAt, posts: [], failures: [], projects: [], goals: [], capacity: wallCapacity([]), staleAfterHours: null } }
    const timings: WallTimings | undefined = q.get("timings") === "1" ? {} : undefined
    const t0 = performance.now()
    const posts = wallPosts(deps, days, timings)
    const failures = timed(timings, "failures", () => wallFailures(deps.db, deps.now))
    const goals = timed(timings, "goals", () => wallGoals(deps))
    if (timings) timings.totalMs = Math.round((performance.now() - t0) * 10) / 10
    return { status: 200, body: {
      node, syncedAt, posts, failures, projects: projectOverview(posts, deps.projects?.names), goals,
      capacity: wallCapacity(posts, deps.capacityThreshold), staleAfterHours: deps.staleAfterHours,
      ...(timings ? { timings } : {}),
    } }
  }
  // Weekly throughput (#1192): this node's closures of the last four
  // weeks, the owners with open work (a row even with no closure), and
  // the counts made from them.
  if (path === `${WALL_PREFIX}/throughput`) {
    if (!deps) return { status: 200, body: { node, syncedAt, closures: [], owners: [], throughput: wallThroughput([], { now: syncedAt }) } }
    const closures = wallClosures(deps, projectOf)
    const owners = [...new Set(deps.store.listOpen().map((r) => r.askedAgent ?? r.agentId))]
    return { status: 200, body: { node, syncedAt, closures, owners, throughput: wallThroughput(closures, { now: deps.now, projectNames: deps.projects?.names, owners }) } }
  }
  if (path === `${WALL_PREFIX}/thread`) {
    if (!deps) return { status: 404, body: { error: "no requests on this node" } }
    const id = q.get("id")
    const task = q.get("task")
    const r = id ? deps.store.get(id) : task ? deps.store.byLink("run", task) : null
    // A run no request tracks is the usual case for the Wall's Task page
    // (#1439): an answer, not a failed request.
    if (!r && !id && task) return { status: 200, body: { node, syncedAt, post: null } }
    if (!r) return { status: 404, body: { error: "no post for that id" } }
    return { status: 200, body: { node, syncedAt, post: wallPost(r, deps), events: wallThread(r, deps), plan: wallPlan(r, deps) } }
  }
  return { status: 404, body: { error: "not found" } }
}
