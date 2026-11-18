// --- Due times from the queue, not from the agent (#1909) ---
//
// An agent that writes its own due time guesses: it cannot see its own
// queue, the node's other work, or how long its runs really take. Here
// the daemon places the work in the queue and reads the due time off it.
// Pure functions: the queue comes in as a list, the clock as a number.
//
// The model, kept small on purpose:
//   - Every open job of the node is one item with an estimate in minutes
//     (at most a week). A job running now counts what is left of it (its
//     estimate less the time it has run, never under a few minutes).
//   - Jobs running now come first. Then the rest in priority order:
//     critical, then work the requester asked to make room for, then high,
//     normal and low; same priority, oldest first. A job that waits for a
//     wake later on starts no earlier than that wake, after the others.
//   - The node runs at most `capacity` items at once, and each agent at
//     most its own `lanes` (its maxConcurrent).
//   - An estimate is multiplied by the agent's correction factor: how long
//     its work really took against what it said, from its past rows.
// An item's due time is when it would end in that order.

export const PRIORITIES = ["critical", "high", "normal", "low"] as const
export type Priority = (typeof PRIORITIES)[number]

const MIN = 60_000

/** An estimate is not counted over a week (#1909 review). */
export const MAX_ESTIMATE_MINUTES = 7 * 24 * 60
/** What is left of a running job is never counted under this. */
export const MIN_REMAINING_MINUTES = 5
/** A due time moves, and its requester hears of it, only for this much. */
export const MOVE_THRESHOLD_MINUTES = 15

/** Order of a priority: lower runs first. Room made for a requester's
 *  time sits after critical work and before everything else. */
function rank(p: Priority, ahead: boolean): number {
  if (p === "critical") return 0
  if (ahead) return 0.5
  return PRIORITIES.indexOf(p)
}

export interface QueueItem {
  id: string
  agentId: string
  priority: Priority
  /** The requester asked for room to be made for it (#1909 point 3a). */
  ahead?: boolean
  /** Minutes the agent said; null: its usual or the default. */
  estimateMinutes: number | null
  createdAt: number
  /** Its due time now, if it has one. */
  dueAt: number | null
  /** Who waits on it: "owner", an agent id, a person id. */
  requester: string | null
  /** Where its due time came from. Only "daemon" moves with the queue: a
   *  requester's, a fact's or an agent's does not move on its own, and a
   *  row with none ("none") is not given one. */
  source?: string | null
  /** A few words for a message about it. */
  words?: string
  /** Running now, since this time: only what is left of it counts. */
  runningSince?: number | null
  /** Waits for a wake at this time: it starts no earlier. */
  notBefore?: number | null
}

export interface SlotOptions {
  now: number
  /** Items the node runs at once. */
  capacity: number
  /** Items one agent runs at once. */
  lanes: (agentId: string) => number
  /** The agent's correction factor (1: its estimates hold). */
  factor: (agentId: string) => number
  /** Minutes for an item that has no estimate. */
  defaultMinutes: (item: QueueItem) => number
}

export interface Placed {
  id: string
  agentId: string
  startAt: number
  endAt: number
  /** Minutes it is counted for, the factor applied. */
  minutes: number
}

/** Minutes an item is counted for, the factor applied; a running item
 *  counts what is left of it at `opts.now`. */
export function minutesOf(item: QueueItem, opts: SlotOptions): number {
  const raw = item.estimateMinutes ?? opts.defaultMinutes(item)
  const est = Math.min(MAX_ESTIMATE_MINUTES, Number.isFinite(raw) && raw > 0 ? raw : 1)
  const whole = Math.max(1, Math.round(est * Math.max(0.01, opts.factor(item.agentId))))
  if (item.runningSince == null) return whole
  const ran = Math.max(0, (opts.now - item.runningSince) / MIN)
  return Math.max(MIN_REMAINING_MINUTES, Math.round(whole - ran))
}

/** Running now (0), ready (1), waiting for a later wake (2). */
function tier(item: QueueItem, now: number | undefined): number {
  if (item.runningSince != null) return 0
  if (item.notBefore != null && now !== undefined && item.notBefore > now) return 2
  return 1
}

/** The order the queue runs in at `now`. */
export function ordered(items: QueueItem[], now?: number): QueueItem[] {
  return [...items].sort((a, b) =>
    tier(a, now) - tier(b, now) || (tier(a, now) === 2 ? a.notBefore! - b.notBefore! : 0) ||
    rank(a.priority, !!a.ahead) - rank(b.priority, !!b.ahead) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** When each item starts and ends, in queue order. */
export function schedule(items: QueueItem[], opts: SlotOptions): Map<string, Placed> {
  const node = Array(Math.max(1, Math.floor(opts.capacity))).fill(opts.now) as number[]
  const agents = new Map<string, number[]>()
  const out = new Map<string, Placed>()
  for (const item of ordered(items, opts.now)) {
    let lanes = agents.get(item.agentId)
    if (!lanes) agents.set(item.agentId, (lanes = Array(Math.max(1, Math.floor(opts.lanes(item.agentId)))).fill(opts.now) as number[]))
    const n = node.indexOf(Math.min(...node))
    const a = lanes.indexOf(Math.min(...lanes))
    const startAt = Math.max(node[n], lanes[a], item.notBefore != null && item.notBefore > opts.now ? item.notBefore : opts.now)
    const minutes = minutesOf(item, opts)
    const endAt = startAt + minutes * MIN
    node[n] = endAt
    lanes[a] = endAt
    out.set(item.id, { id: item.id, agentId: item.agentId, startAt, endAt, minutes })
  }
  return out
}

/** What a due time was computed from: shown to the agent and kept. */
export interface SlotInputs {
  /** The agent's items that run before this one. */
  queueLength: number
  /** Their minutes, the factor applied. */
  queueMinutes: number
  /** Open items on the node, this one included. */
  nodeQueueLength: number
  priority: Priority
  factor: number
  capacity: number
  estimateMinutes: number
  /** Where the estimate came from. */
  estimateFrom: "given" | "usual" | "default"
}

export interface SlotAnswer {
  dueAt: number
  startAt: number
  minutes: number
  inputs: SlotInputs
}

/** Places `job` in `queue` and reads its due time. */
export function place(queue: QueueItem[], job: QueueItem, opts: SlotOptions, estimateFrom: SlotInputs["estimateFrom"]): SlotAnswer {
  const all = [...queue.filter((q) => q.id !== job.id), job]
  const plan = schedule(all, opts)
  const mine = plan.get(job.id)!
  const order = ordered(all, opts.now)
  const before = order.slice(0, order.findIndex((q) => q.id === job.id)).filter((q) => q.agentId === job.agentId)
  return {
    dueAt: mine.endAt,
    startAt: mine.startAt,
    minutes: mine.minutes,
    inputs: {
      queueLength: before.length,
      queueMinutes: before.reduce((s, q) => s + plan.get(q.id)!.minutes, 0),
      nodeQueueLength: all.length,
      priority: job.priority,
      factor: Math.round(opts.factor(job.agentId) * 100) / 100,
      capacity: Math.max(1, Math.floor(opts.capacity)),
      estimateMinutes: job.estimateMinutes ?? opts.defaultMinutes(job),
      estimateFrom,
    },
  }
}

/** A job whose due time moves because another went ahead. */
export interface Move {
  id: string
  agentId: string
  requester: string | null
  words: string
  from: number
  to: number
}

/** Items of `queue` whose due time `job` pushes back. Only due times the
 *  daemon gave move (source "daemon"). An item moves by what `job` itself
 *  costs it (where it ends with `job` less where it ends without, at the
 *  same clock), and only as far as its due time no longer holds: time the
 *  queue lost on its own is not put on the job that went ahead. Moves
 *  under `toleranceMinutes` are left out. */
export function movesBy(queue: QueueItem[], job: QueueItem, opts: SlotOptions, toleranceMinutes = MOVE_THRESHOLD_MINUTES): Move[] {
  const others = queue.filter((q) => q.id !== job.id)
  const before = schedule(others, opts)
  const after = schedule([...others, job], opts)
  const out: Move[] = []
  for (const q of others) {
    if (q.source !== "daemon") continue
    const was = before.get(q.id)!.endAt
    const ends = after.get(q.id)!.endAt
    const from = q.dueAt ?? was
    const by = Math.min(ends - was, ends - from)
    if (by < Math.max(1, toleranceMinutes) * MIN) continue
    out.push({ id: q.id, agentId: q.agentId, requester: q.requester, words: q.words ?? q.id, from, to: from + by })
  }
  return out
}

/** The answer to a due time the requester named (#1909 point 3a). */
export type FitAnswer =
  | { fits: true; answer: SlotAnswer }
  | {
    fits: false
    /** The earliest it ends with nothing moved. */
    earliest: SlotAnswer
    /** With room made for it: when it would end, and what would move. */
    withRoom: { answer: SlotAnswer; moves: Move[]; meets: boolean }
  }

/** Does the requested time hold in the queue as it stands? If not: the
 *  earliest time with nothing moved, and what moves if room is made. */
export function fit(queue: QueueItem[], job: QueueItem, requestedAt: number, opts: SlotOptions, estimateFrom: SlotInputs["estimateFrom"]): FitAnswer {
  const plain = place(queue, { ...job, ahead: false }, opts, estimateFrom)
  if (plain.dueAt <= requestedAt) return { fits: true, answer: plain }
  const roomy = { ...job, ahead: true }
  const answer = place(queue, roomy, opts, estimateFrom)
  // Every item that would end later, whatever set its due time: the
  // requester chooses knowing all of them.
  const moves = movesBy(queue.map((q) => ({ ...q, source: "daemon" })), roomy, opts, 1)
  return { fits: false, earliest: plain, withRoom: { answer, moves, meets: answer.dueAt <= requestedAt } }
}

/** An ISO time that never throws: a time out of the Date range reads
 *  as "out of range". */
export function isoOf(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : "out of range"
}

/** "2026-11-18 12:00 UTC" */
export const utc = (ms: number) => {
  const iso = isoOf(ms)
  return iso === "out of range" ? iso : iso.slice(0, 16).replace("T", " ") + " UTC"
}

/** One line per move: "job X moves from 12:00 to 16:00". */
export function describeMoves(moves: Move[]): string {
  return moves.map((m) => `"${m.words}" (${m.id}, @${m.agentId}) moves from ${utc(m.from)} to ${utc(m.to)}`).join("; ")
}
