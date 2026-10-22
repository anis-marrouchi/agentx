import type { DecisionCard } from "@/approvals/cards"
import { requestTitle, youSaid } from "@/requests/card-view"
import type { LinkKind, RequestRecord } from "@/requests/store"

// --- The Desk: one board over what waits, what runs and what ended (#959) ---
//
// A read model, not a store, like the Approvals inbox (approvals/inbox.ts).
// Each card is one source record in a standard shape, and its column is
// worked out from the source's state every time the board is read:
//
//   yours   the next step is the owner's: every pending inbox item, and a
//           request whose agent asked the owner a question
//   agent   an open request with proof of work: one of its runs is live
//           now, or something happened under it inside the quiet limit
//           (its card's "changed" time is still its last change of state)
//   quiet   an open request without that proof
//   done    requests and decision cards that ended in the last days
//
// Nothing writes a column, so a card cannot say "running" after the work
// ended, and a card without a source cannot exist.

export type DeskColumn = "yours" | "agent" | "quiet" | "done"
export const DESK_COLUMNS: readonly DeskColumn[] = ["yours", "agent", "quiet", "done"]

/** Open work that nothing touched for this long has no news. */
export const DESK_QUIET_HOURS = 3
/** How far back the done column goes, and how many cards it holds. */
export const DESK_DONE_DAYS = 7
export const DESK_DONE_MAX = 50
export const DESK_TITLE_MAX = 120
export const DESK_FACTS_MAX = 280
/** A question is shown whole where it can be; one of pages is cut. */
export const DESK_ASK_MAX = 600

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface DeskCard {
  /** `<kind>:<ref>`, the key the inbox uses. */
  key: string
  kind: string
  column: DeskColumn
  /** The node the source is on: its URL as the app posts it back, and its name. */
  node: string
  nodeName: string
  title: string
  /** The one question the answers are for. */
  ask?: string
  /** What is known about it. Never an instruction. */
  facts?: string
  recommend?: string
  /** The agent that raised it or has the work. */
  agent?: string
  /** What yes and no do, in words. */
  yes?: string
  no?: string
  choices?: string[]
  draft?: string
  expires?: string
  askedAt?: string
  changedAt?: string
  /** Proof behind "with an agent": one of its runs is live now. */
  live?: boolean
  /** A finished card: the result in a word, and the proof or the reason. */
  outcome?: string
  evidence?: string
  /** What the owner can do with it from the board. */
  can: { answer: boolean; later: boolean; reply: boolean }
}

/** One pending inbox item, as a node reports it. */
export interface DeskInboxItem {
  key: string
  title: string
  ask?: string
  recommend?: string
  yes?: string
  no?: string
  raisedBy?: string
  expires?: string
  choices?: string[]
  draft?: string
  detail?: string
  createdAt?: string
}

export interface DeskInbox {
  node: string
  nodeName: string
  items: DeskInboxItem[]
  error?: string
}

export interface DeskRequest {
  record: RequestRecord
  links: Array<{ kind: LinkKind; ref: string }>
}

export interface DeskInput {
  now: number
  /** This node: its requests and finished cards are the ones read here. */
  node: string
  nodeName: string
  inbox: DeskInbox[]
  /** Open requests and the ones closed lately. Null: no requests here. */
  requests: DeskRequest[] | null
  /** Decision cards of this node that are no longer pending. */
  cards: DecisionCard[]
  /** The runs that are live on this node right now, by the id a request's
   *  run link holds (see `liveRunRefs`). */
  liveRuns: ReadonlySet<string>
  /** Inbox keys of this node the owner put off: still waiting, not shown. */
  deferred?: ReadonlySet<string>
  quietHours?: number
  doneDays?: number
}

/** The live runs of a node's agent list, each by its trace id. That is the
 *  id `task:started` carries and a request's run link stores; a running
 *  task's own `id` is a different one and matches no link. */
export function liveRunRefs(agents: ReadonlyArray<{ runningTasks?: ReadonlyArray<{ traceId?: string }> }>): Set<string> {
  const refs = new Set<string>()
  for (const a of agents) for (const t of a.runningTasks ?? []) if (t.traceId) refs.add(t.traceId)
  return refs
}

export interface DeskFigures {
  yours: { count: number; oldest?: string }
  agent: { count: number }
  quiet: { count: number; oldest?: string }
  done: { count: number }
}

export interface DeskBoard {
  ts: string
  cards: DeskCard[]
  figures: DeskFigures
  /** Sources that could not be read, so a short board is not taken for a quiet one. */
  errors: string[]
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const iso = (ms: number) => new Date(ms).toISOString()

function inboxCard(node: DeskInbox, item: DeskInboxItem, local: boolean): DeskCard {
  const kind = item.key.slice(0, Math.max(0, item.key.indexOf(":"))) || "card"
  return {
    key: item.key,
    kind,
    column: "yours",
    node: node.node,
    nodeName: node.nodeName,
    title: clip(item.title, DESK_TITLE_MAX),
    ...(item.ask ? { ask: clip(item.ask, DESK_ASK_MAX) } : {}),
    ...(item.detail ? { facts: clip(item.detail, DESK_FACTS_MAX) } : {}),
    ...(item.recommend ? { recommend: item.recommend } : {}),
    ...(item.raisedBy ? { agent: item.raisedBy } : {}),
    ...(item.yes ? { yes: item.yes } : {}),
    ...(item.no ? { no: item.no } : {}),
    ...(item.choices?.length ? { choices: item.choices } : {}),
    ...(item.draft ? { draft: item.draft } : {}),
    ...(item.expires ? { expires: item.expires } : {}),
    ...(item.createdAt ? { askedAt: item.createdAt } : {}),
    // A written reply goes through this node's requests; another node's are not read here.
    can: { answer: true, later: true, reply: local && kind === "request" },
  }
}

const CLOSED_WORD: Record<string, string> = { done: "Done", declined: "Declined", dropped: "Dropped" }

function requestCard(input: DeskInput, r: DeskRequest, waiting: ReadonlySet<string>): DeskCard | null {
  const { record: q, links } = r
  const base = {
    key: `request:${q.id}`,
    kind: "request",
    node: input.node,
    nodeName: input.nodeName,
    // Its headline, then what is needed, then the owner's words (#1126).
    title: requestTitle(q, DESK_TITLE_MAX),
    ...(q.need ? { ask: clip(q.need, DESK_ASK_MAX) } : {}),
    ...(q.headline ? { facts: clip(`You said: ${youSaid(q, DESK_FACTS_MAX)}`, DESK_FACTS_MAX) } : {}),
    agent: q.agentId,
    askedAt: iso(q.createdAt),
    // When its state last changed: a run starting or ending is not news.
    // Rows from before the column fall back to the last activity.
    changedAt: iso(q.stateChangedAt ?? q.updatedAt),
  }
  switch (q.state) {
    case "candidate":
    // The inbox already lists it, with yes and no.
    case "needs_attention":
      return null
    case "waiting_owner":
      // Its question is a decision card that is in the inbox: one card, not two.
      if (links.some((l) => l.kind === "card" && waiting.has(`card:${l.ref}`))) return null
      return { ...base, column: "yours", ...(q.question ? { ask: clip(q.question, DESK_ASK_MAX) } : {}), can: { answer: false, later: false, reply: true } }
    case "in_progress":
    case "waiting_other": {
      const live = links.some((l) => l.kind === "run" && input.liveRuns.has(l.ref))
      // Proof of work is any activity, not only a change of state.
      const fresh = input.now - q.updatedAt < (input.quietHours ?? DESK_QUIET_HOURS) * HOUR
      // A written word starts a turn of its own: not beside a run that is live.
      return { ...base, column: live || fresh ? "agent" : "quiet", ...(live ? { live } : {}), can: { answer: false, later: false, reply: !live } }
    }
    default: {
      const detail = q.state === "done" ? q.evidence : q.closeReason
      return {
        ...base,
        column: "done",
        changedAt: iso(q.closedAt ?? q.stateChangedAt ?? q.updatedAt),
        outcome: CLOSED_WORD[q.state] ?? q.state,
        ...(detail ? { evidence: detail } : {}),
        can: { answer: false, later: false, reply: false },
      }
    }
  }
}

function cardOutcome(c: DecisionCard): string {
  if (c.status === "decided") return c.verdict === "yes" ? `Answered yes${c.choice ? `: ${c.choice}` : ""}` : "Answered no"
  if (c.status === "expired") return `No answer in time: ${c.outcome === "discard" ? "discarded" : c.outcome === "pause" ? "paused" : "kept"}`
  return "Closed by the agent"
}

function finishedCard(input: DeskInput, c: DecisionCard): DeskCard {
  return {
    key: `card:${c.id}`,
    kind: "card",
    column: "done",
    node: input.node,
    nodeName: input.nodeName,
    title: clip(c.title, DESK_TITLE_MAX),
    ask: c.ask,
    agent: c.raised_by,
    askedAt: c.created_at,
    ...(c.decided_at ? { changedAt: c.decided_at } : {}),
    outcome: cardOutcome(c),
    ...(c.resolution ? { evidence: c.resolution } : {}),
    can: { answer: false, later: false, reply: false },
  }
}

const time = (s: string | undefined) => (s ? Date.parse(s) || 0 : 0)
const oldest = (cards: DeskCard[], field: "askedAt" | "changedAt") =>
  cards.map((c) => c[field]).filter((s): s is string => !!time(s)).sort((a, b) => time(a) - time(b))[0]

export function buildDesk(input: DeskInput): DeskBoard {
  const yours: DeskCard[] = []
  const errors: string[] = []
  for (const node of input.inbox) {
    if (node.error) errors.push(`What waits on ${node.nodeName} could not be read: ${node.error}`)
    for (const item of node.items) yours.push(inboxCard(node, item, node.node === input.node))
  }
  // A card the owner put off still asks its request's question: "later" hides both.
  const waiting = new Set([...yours.filter((c) => c.node === input.node).map((c) => c.key), ...(input.deferred ?? [])])

  const agent: DeskCard[] = []
  const quiet: DeskCard[] = []
  const done: DeskCard[] = []
  for (const r of input.requests ?? []) {
    const card = requestCard(input, r, waiting)
    if (card) ({ yours, agent, quiet, done })[card.column].push(card)
  }
  const since = input.now - (input.doneDays ?? DESK_DONE_DAYS) * DAY
  for (const c of input.cards) {
    if (c.status !== "pending" && time(c.decided_at) >= since) done.push(finishedCard(input, c))
  }

  // Each column in the order it is read: what was touched last on top for
  // work under way and work ended, the longest silence on top for no news.
  agent.sort((a, b) => time(b.changedAt) - time(a.changedAt))
  quiet.sort((a, b) => time(a.changedAt) - time(b.changedAt))
  done.sort((a, b) => time(b.changedAt) - time(a.changedAt))
  const shown = done.filter((c) => time(c.changedAt) >= since).slice(0, DESK_DONE_MAX)

  const yoursOldest = oldest(yours, "askedAt")
  const quietOldest = oldest(quiet, "changedAt")
  return {
    ts: iso(input.now),
    cards: [...yours, ...agent, ...quiet, ...shown],
    figures: {
      yours: { count: yours.length, ...(yoursOldest ? { oldest: yoursOldest } : {}) },
      agent: { count: agent.length },
      quiet: { count: quiet.length, ...(quietOldest ? { oldest: quietOldest } : {}) },
      done: { count: shown.length },
    },
    errors,
  }
}
