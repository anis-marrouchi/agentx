import type { InboxItem } from "@/approvals/inbox"

// --- The owner's desk: one standard card over every source (#959) ---
//
// A read model, not a store, like the Approvals inbox it builds on. Each
// card is one source record (a decision waiting in the inbox, a request the
// owner made, a decision card that closed, a turn an agent is running) in
// one shape, and its column is computed here from the source's state each
// time the desk is read. Nothing writes a column, so nothing can say
// "running" after the work ended.
//
//   yours   the next step is the owner's: every pending inbox item, and a
//           request waiting on the owner or needing attention
//   agent   work is going on and there is proof: a live run linked to it,
//           or a change inside the quiet limit
//   quiet   open, nothing running, nothing changed inside the quiet limit
//   done    the source finished in the last DONE_DAYS days
//
// Everything here is pure: the sources are read on each node (read.ts) and
// the dashboard joins them with the fleet snapshot's running tasks.

export type DeskColumn = "yours" | "agent" | "quiet" | "done"
export const DESK_COLUMNS: readonly DeskColumn[] = ["yours", "agent", "quiet", "done"]

export type DeskAction = "answer" | "write" | "defer" | "call"
export const DESK_ACTIONS: readonly DeskAction[] = ["answer", "write", "defer", "call"]

export type DeskSourceKind = InboxItem["kind"] | "task"

/** Finished sources stay on the desk this long. */
export const DONE_DAYS = 7
export const DEFAULT_QUIET_HOURS = 3
export const FACTS_MAX = 280
export const TITLE_MAX = 120
/** Done cards per node, newest first: the column is for a glance. */
export const DONE_MAX = 50

/** One answer the owner can pick, and exactly what picking it does. */
export interface DeskOption {
  /** What the act route takes back: "yes", "no", or a choice's number. */
  id: string
  label: string
  means: string
}

export interface DeskCard {
  /** `<kind>:<ref>`, the inbox's own keys; a running turn is `task:<id>`. */
  key: string
  /** The daemon URL of the machine the source lives on. */
  node: string
  nodeName: string
  source: { kind: DeskSourceKind; ref: string }
  title: string
  /** What is true and how it was checked. Never an instruction. */
  facts?: string
  /** The one question the options answer. */
  ask?: string
  options: DeskOption[]
  recommend?: string
  /** A written answer is accepted: what it does, and the suggested words. */
  text?: { hint: string; draft?: string; required?: boolean }
  /** Who acts next. */
  actor: "owner" | "agent" | "nobody"
  /** The agent that owns the work. */
  agent?: string
  column: DeskColumn
  /** Put off by the owner until then: folded at the foot of "yours". */
  deferredUntil?: string
  /** It failed, timed out or went quiet and came back to the owner. */
  attention?: boolean
  /** Its machine could not be read: this is the last known card. */
  staleSince?: string
  /** "step 2 of 4" for a tracked plan. */
  progress?: string
  askedAt: string
  changedAt: string
  expiresAt?: string
  /** A finished source: the result word and the proof or reason. */
  outcome?: { word: string; detail?: string }
  actions: DeskAction[]
}

/** A request as a node reports it: bounded, no full transcript. */
export interface DeskRequest {
  id: string
  state: string
  agentId: string
  summary: string
  question: string | null
  attentionReason: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
  evidence: string | null
  closeReason: string | null
  /** Task ids of its runs: one of them running now is proof of work. */
  runs: string[]
  /** Decision cards raised under it. */
  cards: string[]
  lastAnswer: { text: string; at: number } | null
  plan: { done: number; total: number } | null
}

/** A decision card that closed, as a node reports it. */
export interface DeskClosedCard {
  id: string
  title: string
  raisedBy: string
  status: "decided" | "expired" | "resolved"
  verdict?: "yes" | "no"
  choice?: string
  outcome?: string
  createdAt: string
  closedAt: string
}

/** Everything one machine holds for the desk (read.ts). */
export interface DeskSource {
  items: InboxItem[]
  requests: DeskRequest[]
  closedCards: DeskClosedCard[]
  /** Desk keys the owner put off, and until when (inbox state). */
  deferred: Record<string, string>
  errors?: string[]
}

/** A turn an agent is running now, from the fleet snapshot. */
export interface DeskTask {
  node: string
  nodeName: string
  taskId: string
  agentId: string
  agentName?: string
  preview?: string
  startedAt: string
}

export interface DeskNode {
  node: string
  nodeName: string
  source: DeskSource | null
  error?: string
  staleSince?: string
}

export interface DeskFigures {
  yours: { count: number; oldest?: { key: string; title: string; since: string } }
  agent: { count: number }
  stuck: { count: number; oldest?: { key: string; title: string; since: string } }
  deferred: number
}

export interface Desk {
  cards: DeskCard[]
  figures: DeskFigures
  errors: Array<{ node: string; nodeName: string; error: string }>
}

export function clip(text: string | null | undefined, max = FACTS_MAX): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The words the inbox puts in `yes` ("tell writer yes") as a sentence. */
function sentence(s: string): string {
  const t = s.trim()
  if (!t) return t
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".")
}

/** The options of one inbox item, each with the exact effect of picking it. */
export function inboxOptions(item: InboxItem): DeskOption[] {
  const no: DeskOption = { id: "no", label: "No", means: sentence(item.no) }
  if (item.choices?.length) {
    return [
      ...item.choices.map((c, i) => ({
        id: String(i + 1),
        label: c,
        means: `${item.raised_by} is told yes, with "${c}"${item.draft ? ", and gets the message below" : ""}.`,
      })),
      no,
    ]
  }
  return [{ id: "yes", label: "Yes", means: sentence(item.yes) }, no]
}

/** A pending inbox item: always the owner's turn. */
export function inboxCard(item: InboxItem, node: string, nodeName: string, deferredUntil?: string): DeskCard {
  const isRequest = item.kind === "request"
  return {
    ...(isRequest ? { attention: true } : {}),
    key: item.key,
    node,
    nodeName,
    source: { kind: item.kind, ref: item.key.slice(item.key.indexOf(":") + 1) },
    title: clip(item.title, TITLE_MAX) ?? item.key,
    ...(item.detail ? { facts: clip(item.detail) } : {}),
    ask: item.ask,
    options: inboxOptions(item),
    ...(item.recommend ? { recommend: item.recommend } : {}),
    text: item.draft
      ? { hint: "The message the agent gets. Edit it before you answer.", draft: item.draft }
      : { hint: isRequest ? "Your words go to the agent with the request." : "Optional words for the agent, kept with your answer." },
    actor: "owner",
    agent: item.raised_by,
    column: "yours",
    ...(deferredUntil ?? item.snoozed_until ? { deferredUntil: deferredUntil ?? item.snoozed_until } : {}),
    askedAt: item.created_at,
    changedAt: item.created_at,
    ...(item.expires ? { expiresAt: item.expires } : {}),
    actions: isRequest ? ["answer", "write", "defer", "call"] : ["answer", "defer", "call"],
  }
}

/** The mirror rule for one open or recently closed request. */
export function requestCard(
  r: DeskRequest,
  node: string,
  nodeName: string,
  opts: { now: number; quietMs: number; live: ReadonlySet<string>; deferredUntil?: string },
): DeskCard | null {
  const base = {
    key: `request:${r.id}`,
    node,
    nodeName,
    source: { kind: "request" as const, ref: r.id },
    title: clip(r.summary, TITLE_MAX) ?? r.id,
    agent: r.agentId,
    askedAt: iso(r.createdAt),
    changedAt: iso(r.updatedAt),
    ...(r.plan && r.plan.total > 1 ? { progress: `step ${Math.min(r.plan.done + 1, r.plan.total)} of ${r.plan.total}` } : {}),
  }
  const answer = r.lastAnswer ? clip(`Last answer from ${r.agentId}: ${r.lastAnswer.text}`) : undefined

  if (r.state === "done" || r.state === "declined" || r.state === "dropped") {
    const at = r.closedAt ?? r.updatedAt
    if (opts.now - at > DONE_DAYS * 86_400_000) return null
    return {
      ...base,
      changedAt: iso(at),
      options: [],
      actor: "nobody",
      column: "done",
      outcome: { word: r.state, ...(r.evidence || r.closeReason ? { detail: clip(r.evidence ?? r.closeReason) } : {}) },
      actions: [],
    }
  }

  if (r.state === "waiting_owner") {
    return {
      ...base,
      ...(answer ? { facts: answer } : {}),
      ask: r.question ?? `${r.agentId} is waiting for your answer.`,
      options: [],
      text: { hint: `Your answer goes to ${r.agentId}, who goes on with the request.`, required: true },
      actor: "owner",
      column: "yours",
      ...(opts.deferredUntil ? { deferredUntil: opts.deferredUntil } : {}),
      actions: ["write", "defer", "call"],
    }
  }

  if (r.state === "needs_attention") {
    return {
      ...base,
      facts: clip([r.attentionReason ?? "It needs attention", answer].filter(Boolean).join(". ")),
      ask: `Ask ${r.agentId} to pick it up again?`,
      options: [
        { id: "yes", label: "Hand it back", means: `${r.agentId} is asked to pick it up again within a minute.` },
        { id: "no", label: "Drop it", means: "The request is closed as dropped. Nothing more is done." },
      ],
      text: { hint: `Your words go to ${r.agentId} with the request.` },
      actor: "owner",
      column: "yours",
      attention: true,
      ...(opts.deferredUntil ? { deferredUntil: opts.deferredUntil } : {}),
      actions: ["answer", "write", "defer", "call"],
    }
  }

  // in_progress, waiting_other: with an agent only with proof of work.
  const running = r.runs.some((id) => opts.live.has(id))
  const recent = opts.now - r.updatedAt < opts.quietMs
  const waitingOther = r.state === "waiting_other"
  return {
    ...base,
    facts: clip([
      running ? `${r.agentId} is working on it now` : waitingOther ? "Waiting on another agent" : recent ? "Changed recently" : "Nothing running and no change for a while",
      answer,
    ].filter(Boolean).join(". ")),
    options: [],
    text: { hint: `Your words go to ${r.agentId}, who goes on with the request.`, required: true },
    actor: running || recent ? "agent" : "nobody",
    column: running || recent ? "agent" : "quiet",
    actions: ["write", "call"],
  }
}

/** A decision card that closed in the last DONE_DAYS days. */
export function closedCard(c: DeskClosedCard, node: string, nodeName: string, now: number): DeskCard | null {
  if (now - Date.parse(c.closedAt) > DONE_DAYS * 86_400_000) return null
  const word = c.status === "decided" ? (c.verdict === "yes" ? "yes" : "no") : c.status
  const detail = c.status === "expired" ? `nobody answered; default: ${c.outcome ?? "keep"}` : c.choice
  return {
    key: `card:${c.id}`,
    node,
    nodeName,
    source: { kind: "card", ref: c.id },
    title: clip(c.title, TITLE_MAX) ?? c.id,
    options: [],
    actor: "nobody",
    agent: c.raisedBy,
    column: "done",
    askedAt: c.createdAt,
    changedAt: c.closedAt,
    outcome: { word, ...(detail ? { detail } : {}) },
    actions: [],
  }
}

/** A running turn no request on the desk claims: what that agent is doing. */
export function taskCard(t: DeskTask): DeskCard {
  return {
    key: `task:${t.taskId}`,
    node: t.node,
    nodeName: t.nodeName,
    source: { kind: "task", ref: t.taskId },
    title: clip(t.preview, TITLE_MAX) ?? `${t.agentName ?? t.agentId} is working`,
    facts: `${t.agentName ?? t.agentId} is working on it now`,
    options: [],
    actor: "agent",
    agent: t.agentId,
    column: "agent",
    askedAt: t.startedAt,
    changedAt: t.startedAt,
    actions: ["call"],
  }
}

const normal = (u: string) => u.replace(/\/+$/, "")

/** Join every node's sources and the running tasks into one desk. */
export function buildDesk(
  nodes: DeskNode[],
  tasks: DeskTask[],
  opts: { now: number; quietHours?: number },
): Desk {
  const quietMs = (opts.quietHours && opts.quietHours > 0 ? opts.quietHours : DEFAULT_QUIET_HOURS) * 3_600_000
  const cards: DeskCard[] = []
  const errors: Desk["errors"] = []
  const claimed = new Set<string>()

  for (const n of nodes) {
    if (n.error) errors.push({ node: n.node, nodeName: n.nodeName, error: n.error })
    const src = n.source
    if (!src) continue
    for (const e of src.errors ?? []) errors.push({ node: n.node, nodeName: n.nodeName, error: e })
    const live = n.staleSince
      ? new Set<string>()
      : new Set(tasks.filter((t) => normal(t.node) === normal(n.node)).map((t) => t.taskId))
    const pendingCards = new Set(src.items.filter((i) => i.kind === "card").map((i) => i.key.slice(5)))
    const fromRequests = new Set<string>()
    const own: DeskCard[] = []

    for (const r of src.requests) {
      for (const id of r.runs) claimed.add(`${normal(n.node)} ${id}`)
      // A question asked through a decision card shows once, as that card.
      if (r.state === "waiting_owner" && r.cards.some((c) => pendingCards.has(c))) continue
      const key = `request:${r.id}`
      const card = requestCard(r, n.node, n.nodeName, { now: opts.now, quietMs, live, deferredUntil: src.deferred[key] })
      if (!card) continue
      fromRequests.add(key)
      own.push(card)
    }
    for (const item of src.items) {
      // The inbox lists requests that need attention: the request card says more.
      if (fromRequests.has(item.key)) continue
      own.push(inboxCard(item, n.node, n.nodeName, src.deferred[item.key]))
    }
    for (const c of src.closedCards) {
      const card = closedCard(c, n.node, n.nodeName, opts.now)
      if (card) own.push(card)
    }
    for (const card of own) {
      if (n.staleSince) {
        card.staleSince = n.staleSince
        // Nothing is shown running from a machine that cannot be read.
        if (card.column === "agent") { card.column = "quiet"; card.actor = "nobody" }
      }
      // A deferred card that came due is the owner's again, unfolded.
      if (card.deferredUntil && Date.parse(card.deferredUntil) <= opts.now) delete card.deferredUntil
      if (card.column !== "yours") delete card.deferredUntil
    }
    cards.push(...own)
  }

  for (const t of tasks) {
    if (!claimed.has(`${normal(t.node)} ${t.taskId}`)) cards.push(taskCard(t))
  }
  cards.sort(byColumnThenAge)
  return { cards, figures: figures(cards), errors }
}

const COLUMN_ORDER: Record<DeskColumn, number> = { yours: 0, agent: 1, quiet: 2, done: 3 }

/** Within a column: the owner's oldest first, done newest first. */
export function byColumnThenAge(a: DeskCard, b: DeskCard): number {
  const c = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column]
  if (c) return c
  if (a.column === "yours" && !!a.deferredUntil !== !!b.deferredUntil) return a.deferredUntil ? 1 : -1
  if (a.column === "done" || a.column === "agent") return Date.parse(b.changedAt) - Date.parse(a.changedAt)
  return Date.parse(a.askedAt) - Date.parse(b.askedAt)
}

/** Count and age of what waits for the owner, what is with agents, and
 *  what is stuck: quiet, or brought back because it needs attention. */
export function figures(cards: DeskCard[]): DeskFigures {
  const oldest = (list: DeskCard[], at: (c: DeskCard) => string) => {
    let best: DeskCard | undefined
    for (const c of list) if (!best || Date.parse(at(c)) < Date.parse(at(best))) best = c
    return best ? { key: best.key, title: best.title, since: at(best) } : undefined
  }
  const yours = cards.filter((c) => c.column === "yours" && !c.deferredUntil)
  const stuck = cards.filter((c) => c.column === "quiet" || c.attention)
  return {
    yours: { count: yours.length, oldest: oldest(yours, (c) => c.askedAt) },
    agent: { count: cards.filter((c) => c.column === "agent").length },
    stuck: { count: stuck.length, oldest: oldest(stuck, (c) => c.changedAt) },
    deferred: cards.filter((c) => c.column === "yours" && !!c.deferredUntil).length,
  }
}
