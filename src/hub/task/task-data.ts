// --- One Task page per request, as data (#2101 T1) ---
//
// The merged Task page replaces the old post page (`#post=<id>`) and, with
// T2's run section, the old run page (`#page=task&task=…`). It reads what the
// old post page read: one request and its timeline from
// `GET /api/admin/wall/thread?id=<req>` (src/daemon/wall-api.ts), sent to
// the mesh node that keeps it (`X-Agentx-Peer`). Its writes are the old
// post page's: comment, call, Space, hand off, done, drop, run on.
//
// Plain data and pure functions, so the tests check them without a browser
// (test/hub-task-data.test.ts).
import { buildHash } from "../router"

/** The page's `#page=` id. A review id, as the new Settings and feed had,
 *  while the old run page still owns `#page=task`; T3 moves it there. */
export const TASK_PAGE = "task-preview"

/** What the address names: a request (`id=`), or a run whose request is
 *  looked up (`task=`), the node that keeps it, and the run opened in place. */
export interface TaskAddress { id: string | null; task: string | null; peer: string | null; run: string | null }

export function taskAddress(params: URLSearchParams): TaskAddress {
  const get = (k: string) => params.get(k) || null
  return { id: get("id"), task: get("task"), peer: get("peer"), run: get("run") }
}

/** The Task page of a request; `peer` when a mesh node keeps it. */
export function taskPageHref(id: string, opts: { peer?: string | null; run?: string | null } = {}): string {
  return buildHash({ page: TASK_PAGE, id, peer: opts.peer, run: opts.run })
}

/** Where the request is read: by its id, or by a run of it. */
export function taskThreadPath(a: Pick<TaskAddress, "id" | "task">): string | null {
  if (a.id) return "/api/admin/wall/thread?id=" + encodeURIComponent(a.id)
  if (a.task) return "/api/admin/wall/thread?task=" + encodeURIComponent(a.task)
  return null
}

// --- The reply (the parts of WallPost, WallPlanStep and WallEvent drawn) ---

export interface TaskNode { name?: string; peer?: string | null; daemonUrl?: string | null }

export interface TaskOwnerCard {
  id: string; title: string; ask: string; recommend: string; silence: string
  expiresAt: number; raisedBy: string; createdAt: number; source: string | null; choices: string[]; draft: string | null
}

export interface TaskPost {
  id: string
  state: string
  headline: string
  need?: string
  owner: string
  askedBy?: string | null
  group?: { channel: string; chatId: string } | null
  project?: string | null
  goal?: { id: string; title: string } | null
  home?: { kind: string; link: string } | null
  mergeRef?: string | null
  runOn?: string | null
  createdAt: number
  lastMoveAt?: number
  updatedAt?: number
  closedAt?: number | null
  evidence?: string | null
  blocked?: { who: string; why: string; since: number } | null
  estimateMinutes?: number | null
  runMs?: number
  runs?: number
  failedRuns?: number
  timeFlag?: string | null
  forgeState?: { provider: string; state: string; closedBy?: string | null; mismatch?: string | null } | null
  comments?: { url: string; at: number; agentId?: string | null }[]
  lastRun?: { taskId: string; agentId: string } | null
  result?: { text: string; at: number; from: "reply" | "close"; taskId: string | null; agentId: string | null } | null
  ownerCards?: TaskOwnerCard[]
  qa?: { verdict: string; by: string; at: number; note?: string } | null
  awaitingQa?: boolean
  loop?: { promise?: boolean; owedTo?: string | null; dueAt?: number | null; check?: string | null; verifyState?: string | null; verifyDetail?: string | null } | null
  standing?: string | null
  node?: TaskNode | null
}

export interface TaskPlanStep {
  idx: number; name: string; agentId: string; state: string; doneWhen: string
  evidence: string | null; note: string | null; updatedAt: number
}

export interface TaskEvent {
  at: number
  kind: string
  who: string | null
  text: string
  status?: string | null
  ref?: string
  mentions?: string[]
  ids?: string[]
  durationMs?: number | null
  route?: { from: string; to: string }
}

export interface TaskThreadReply { node?: string; post?: TaskPost | null; events?: TaskEvent[]; plan?: TaskPlanStep[] }

/** The read, with the node it came from. */
export interface TaskRead { post: TaskPost; events: TaskEvent[]; plan: TaskPlanStep[] }

/** The reply as the page draws it: the node named on the post, empty lists
 *  for an older node that sends none. Null: no request (a run nobody tracks). */
export function taskRead(reply: TaskThreadReply | null | undefined, peer: string | null): TaskRead | null {
  const post = reply?.post
  if (!post || !post.id) return null
  const node: TaskNode = { ...(post.node ?? {}), name: post.node?.name ?? reply?.node, peer: post.node?.peer ?? peer }
  return { post: { ...post, node }, events: Array.isArray(reply?.events) ? reply!.events : [], plan: Array.isArray(reply?.plan) ? reply!.plan : [] }
}

// --- Where it stands ---

const OPEN = ["in_progress", "waiting_owner", "waiting_other", "needs_attention"]
export const isOpen = (state: string) => OPEN.includes(state)

const waitsOnOwner = (p: TaskPost) => p.state === "waiting_owner" || (p.ownerCards ?? []).length > 0
const waitsOnSomeone = (p: TaskPost) => isOpen(p.state) && (waitsOnOwner(p) || p.state === "waiting_other" || !!p.blocked)

/** "1 h 20 min", "45 min". */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60
  return h ? h + " h" + (m ? " " + m + " min" : "") : m + " min"
}
const mins = (ms?: number) => Math.round((ms || 0) / 60000)

/** "5m", "3h", "2d": how long ago, short (orca-design C17). */
export function shortAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

/** Who an open request waits on: the blocker, you, or the agent of the
 *  plan's current step. */
export function waitsOn(p: TaskPost, plan: TaskPlanStep[]): string {
  if (p.blocked) return p.blocked.who
  if (waitsOnOwner(p)) return "you"
  const step = plan.find((s) => s.state === "active" || s.state === "blocked")
  return step ? "@" + step.agentId : "another agent"
}

export type StageName = "Asked" | "Working" | "Waits" | "Done" | string
export type StageMark = "done" | "now" | "wait" | "end" | "todo"
export interface Stage { name: StageName; detail: string; mark: StageMark }

/** Asked → Working → Waits (only while it waits) → Done, each with when or
 *  how long: the old post page's strip (wall.client.ts progressHtml). */
export function taskStages(p: TaskPost, plan: TaskPlanStep[], now = Date.now()): Stage[] {
  const open = isOpen(p.state), waits = waitsOnSomeone(p), runs = p.runs || 0
  // Open and never run: it still stands at Asked.
  const asked = open && !waits && !runs
  const ago = (at: number) => { const a = shortAgo(at, now); return a === "now" ? "now" : a + " ago" }
  const stages: Stage[] = [
    { name: "Asked", detail: ago(p.createdAt), mark: asked ? "now" : "done" },
    {
      name: "Working",
      detail: runs ? runs + (runs === 1 ? " run" : " runs") + (p.runMs ? ", " + mins(p.runMs) + " min" : "") : "not picked up yet",
      mark: !open || waits ? (runs ? "done" : "todo") : asked ? "todo" : "now",
    },
  ]
  if (waits) stages.push({ name: "Waits", detail: "on " + waitsOn(p, plan) + (p.blocked ? " for " + shortAgo(p.blocked.since, now) : ""), mark: "wait" })
  const end = open || p.state === "done" ? "Done" : stateWord(p.state)
  stages.push({
    name: end,
    detail: p.closedAt ? ago(p.closedAt) : p.estimateMinutes ? "estimate " + hm(p.estimateMinutes) : "",
    mark: open ? "todo" : p.state === "done" ? "done" : "end",
  })
  return stages
}

/** A state in words: "waiting_owner" → "Waiting on you". */
export function stateWord(state: string): string {
  const words: Record<string, string> = {
    in_progress: "Working", waiting_owner: "Waiting on you", waiting_other: "Waiting", needs_attention: "Needs attention",
    done: "Done", declined: "Declined", dropped: "Dropped",
  }
  return words[state] ?? state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ")
}

/** One amber line under the strip: why it waits. Empty: it does not. */
export function waitReason(p: TaskPost): string {
  if (!isOpen(p.state)) return ""
  if (p.blocked) return "Waits on " + p.blocked.who + ": " + p.blocked.why
  const c = (p.ownerCards ?? [])[0]
  if (c) return "Waits on you: " + c.title
  if (p.state === "waiting_owner") return "Waits on you"
  if (p.forgeState?.mismatch === "forge-closed") return forgeName(p.forgeState.provider) + " says " + p.forgeState.state + ". Do not pick it up."
  return ""
}

const forgeName = (provider: string) => (provider === "github" ? "GitHub" : "GitLab")

// --- The plan ---

export type StepTone = "done" | "work" | "wait" | "todo" | "skip"
/** A plan step's state as the one state set (orca-design recipes §9). */
export function stepState(state: string): { icon: string; word: string; tone: StepTone } {
  switch (state) {
    case "done": return { icon: "circle-check", word: "Done", tone: "done" }
    case "active": return { icon: "loader-circle", word: "Working", tone: "work" }
    case "blocked": return { icon: "clock", word: "Waiting", tone: "wait" }
    case "skipped": return { icon: "ban", word: "Skipped", tone: "skip" }
    default: return { icon: "circle-dashed", word: "Not started", tone: "todo" }
  }
}

/** "2 of 5 done": skipped steps count as done, as on the old page. */
export function planCount(plan: TaskPlanStep[]): { done: number; total: number } {
  return { done: plan.filter((s) => s.state === "done" || s.state === "skipped").length, total: plan.length }
}

/** A proof: a web link opens, anything else is shown as text. */
export function proofOf(evidence: string | null | undefined): { href: string | null; text: string } | null {
  if (!evidence) return null
  return /^https?:\/\//.test(evidence) ? { href: evidence, text: "Proof" } : { href: null, text: evidence }
}

// --- The facts ---

const LOOP_CHECK: Record<string, string> = {
  verified: "check met", unverified: "check could not say", failed: "check not met",
  held: "check met, held after a mismatch", proof_missing: "check met, waits for proof links",
}

export interface Fact { label: string; value: string; at?: number; mono?: boolean }

/** Who asked, where, the times and the estimate, as label and value pairs;
 *  rows with nothing to say are left out. `at` marks a time to draw. */
export function taskFacts(p: TaskPost): Fact[] {
  const loop = p.loop
  const rows: (Fact | null)[] = [
    p.askedBy ? { label: "Asked by", value: p.askedBy } : null,
    p.group ? { label: "Chat", value: p.group.channel + " · " + p.group.chatId } : null,
    p.project ? { label: "Project", value: p.project, mono: true } : null,
    p.goal ? { label: "Goal", value: p.goal.title } : null,
    loop?.promise && loop.owedTo ? { label: "Promised to", value: loop.owedTo === "owner" ? "you" : loop.owedTo } : null,
    loop?.dueAt ? { label: "Due", value: "", at: loop.dueAt } : null,
    loop?.check ? { label: "Closes when", value: loop.check + (loop.verifyState ? " (" + (LOOP_CHECK[loop.verifyState] ?? loop.verifyState) + (loop.verifyDetail ? ": " + loop.verifyDetail : "") + ")" : "") } : null,
    p.standing ? { label: "Standing order", value: p.standing } : null,
    { label: "Opened", value: "", at: p.createdAt },
    p.lastMoveAt ? { label: "Last move", value: "", at: p.lastMoveAt } : null,
    p.closedAt ? { label: "Closed", value: "", at: p.closedAt } : null,
    { label: "Time", value: (p.runMs ? mins(p.runMs) + " min of runs" : "No runs yet") + (p.estimateMinutes ? " against " + hm(p.estimateMinutes) : "") },
    p.qa || p.awaitingQa ? { label: "QA", value: p.qa ? p.qa.verdict.toUpperCase() + " by " + p.qa.by + (p.qa.note ? ": " + p.qa.note : "") + (p.awaitingQa ? " (new verdict asked)" : "") : "Awaiting sign-off" } : null,
    p.node?.name ? { label: "Machine", value: p.node.name, mono: true } : null,
    { label: "Request", value: p.id, mono: true },
  ]
  return rows.filter((r): r is Fact => !!r)
}

/** Warnings worth a line of their own: time, and the forge disagreeing. */
export function taskFlags(p: TaskPost): string[] {
  const out: string[] = []
  if (p.timeFlag) out.push("Time: " + p.timeFlag)
  const f = p.forgeState
  if (f?.mismatch === "forge-closed") out.push(forgeName(f.provider) + " says " + f.state + (f.closedBy ? " by " + f.closedBy : "") + ", but this request is still open. Do not pick it up.")
  if (f?.mismatch === "forge-open") out.push(forgeName(f.provider) + " says open, but this request is " + stateWord(p.state).toLowerCase() + ". Close it there or reopen it here.")
  return out
}

// --- Links out ---

export interface TaskLink { kind: "home" | "proof" | "comment" | "run"; label: string; href: string | null; title?: string }

const web = (s: string) => /^https?:\/\//.test(s)

/** Its home (issue or PR), its proof and the comments agents posted there. */
export function taskLinks(p: TaskPost): TaskLink[] {
  const out: TaskLink[] = []
  if (p.home) out.push({ kind: "home", label: p.home.link.replace(/^https?:\/\//, ""), href: web(p.home.link) ? p.home.link : null, title: "Home: " + p.home.link })
  if (p.evidence) out.push({ kind: "proof", label: web(p.evidence) ? "Proof" : "Proof: " + p.evidence, href: web(p.evidence) ? p.evidence : null })
  for (const c of (p.comments ?? []).slice(0, 3)) {
    if (web(c.url)) out.push({ kind: "comment", label: "Comment" + (c.agentId ? " by " + c.agentId : ""), href: c.url, title: new Date(c.at).toISOString() })
  }
  return out
}

// --- The thread ---

/** Repeats in a row (same kind, author, status and words) fold into one
 *  line with a count, as on the old page. */
export function foldEvents(events: TaskEvent[]): { event: TaskEvent; count: number; items: TaskEvent[] }[] {
  const out: { sig: string; event: TaskEvent; count: number; items: TaskEvent[] }[] = []
  for (const e of events) {
    const sig = e.kind + "|" + (e.who ?? "") + "|" + (e.status ?? "") + "|" + e.text
    const last = out[out.length - 1]
    if (last && last.sig === sig) { last.items.push(e); last.count++ } else out.push({ sig, event: e, count: 1, items: [e] })
  }
  return out.map(({ event, count, items }) => ({ event, count, items }))
}

export const EVENT_WORD: Record<string, string> = {
  asked: "Asked", run: "Run", handoff: "Hand-off", home: "Home", link: "Link", comment: "Comment",
  plan: "Plan", waiting: "Waiting", attention: "Attention", closed: "Closed",
}

export const eventFailed = (e: TaskEvent) => e.status === "error" || e.status === "timeout" || e.status === "failed"

// --- Actions ---

export type CloseKind = "handoff" | "done" | "drop"

/** The confirm line for Hand off, Done and Drop (wall-close.client.ts). */
export function closeConfirmText(kind: CloseKind, title: string, agentName: string, said: boolean): string {
  const t = "“" + title + "”"
  const lead = kind === "handoff" ? "Hand " + t + " to " + agentName + "." : kind === "done" ? "Close " + t + " as done." : "Drop " + t + "."
  return lead + (said ? " Your words above go with it." : "") + " It cannot be taken back."
}

/** The call each one makes, sent to the node that keeps the request. */
export function closeCall(kind: CloseKind, id: string, agentId: string, text: string): { path: string; body: Record<string, string> } {
  if (kind === "handoff") return { path: "/api/admin/wall/request/handoff", body: { id, agentId, note: text } }
  return { path: "/api/admin/wall/request/close", body: kind === "done" ? { id, action: "done", evidence: text } : { id, action: "drop", reason: text } }
}

export interface LiveAgent { id: string; name?: string; runningTasks?: { id: string; traceId?: string; channel?: string }[] }
export interface LiveNode { name: string; url?: string; agents?: LiveAgent[] }
export interface LiveSnapshot { nodes?: LiveNode[] }

/** The agents a request can be handed to: those on the node that keeps it
 *  (the first node, this one, for a local request). */
export function nodeAgents(live: LiveSnapshot | undefined, node: TaskNode | null | undefined): LiveAgent[] {
  const nodes = live?.nodes ?? []
  const hit = node?.peer ? nodes.find((n) => n.name === node.name) : nodes[0]
  return hit?.agents ?? []
}

/** Every agent on every node once, for the Space picker and @mentions; the
 *  peer is set for an agent off this node. */
export function allAgents(live: LiveSnapshot | undefined): (LiveAgent & { peer: string | null })[] {
  const seen = new Set<string>()
  const out: (LiveAgent & { peer: string | null })[] = []
  ;(live?.nodes ?? []).forEach((n, i) => (n.agents ?? []).forEach((a) => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push({ ...a, peer: i === 0 ? null : n.url ?? null })
  }))
  return out
}

/** The agents a comment names with @ (id or name, a name of several words
 *  too), in the order they appear, the owner left out (wall-live.client.ts). */
export function mentionedAgents<A extends { id: string; name?: string }>(text: string, agents: A[], except: string): A[] {
  const low = text.toLowerCase()
  // It must end at a word boundary: @far does not name "farm", "a@far" is no mention.
  const at = (s?: string) => {
    if (!s) return -1
    const tag = "@" + s.toLowerCase()
    for (let i = low.indexOf(tag); i !== -1; i = low.indexOf(tag, i + 1)) {
      const after = low.slice(i + tag.length)
      if ((i === 0 || !/[a-z0-9_]/.test(low.charAt(i - 1))) && !/^([a-z0-9_-]|[.:][a-z0-9_])/.test(after)) return i
    }
    return -1
  }
  return agents
    .filter((a) => a.id !== except)
    .map((a) => ({ a, pos: Math.min(...[at(a.id), at(a.name)].map((x) => (x < 0 ? Infinity : x))) }))
    .filter((x) => x.pos !== Infinity)
    .sort((x, y) => x.pos - y.pos)
    .map((x) => x.a)
}

/** The post a mentioned agent gets (same words as the old page). */
export function mentionText(hubName: string, p: Pick<TaskPost, "id" | "owner" | "headline">, comment: string): string {
  return "The owner mentioned you in a comment on " + hubName + " post " + p.id + " by @" + p.owner + ": \"" + (p.headline || p.id) + "\".\n\nTheir comment:\n" + comment
}
