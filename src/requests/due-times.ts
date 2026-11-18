import type Database from "better-sqlite3"
import { EstimateCache, factorOf, usualOf, type AgentFactor, type EstimateRow } from "./estimates"
import { SlotStore, type DueSource } from "./slot-store"
import { describeMoves, fit, isoOf, MAX_ESTIMATE_MINUTES, movesBy, place, PRIORITIES, utc, type Move, type Priority, type QueueItem, type SlotAnswer, type SlotInputs, type SlotOptions } from "./slots"

// --- The daemon gives the due time (#1909) ---
//
// A promise or an accept registers the work (estimateMinutes, priority)
// and the daemon answers with the due time, read off the queue (slots.ts).
// A due time the agent writes needs a source: the requester's words or an
// outside fact. A requester's time is checked against the queue: it fits,
// or the answer is the earliest time and what would have to move.
//
// Three modes (requests.dueTimes.mode):
//   off      nothing changes (the default)
//   shadow   nothing changes for the agent: the same reply as off, and
//            nothing written but the due_slots row with the time the
//            daemon would have given next to the time the agent wrote.
//            Fields the agent got wrong are noted there, never refused.
//   on       a call without `due` gets the computed time; a `due` with no
//            source is refused; a requester's time that does not fit is
//            answered at once, and nothing is accepted until they choose;
//            work that goes ahead moves the daemon's due times behind it,
//            and each requester is told once

export const DUE_TIME_MODES = ["off", "shadow", "on"] as const
export type DueTimeMode = (typeof DUE_TIME_MODES)[number]

export interface DueTimeSettings {
  mode: DueTimeMode
  /** Items the node runs at once. 0: the admission queue's maxSessions,
   *  else 2. */
  capacity: number
  /** Minutes counted for work with no estimate and no usual length. */
  defaultEstimateMinutes: number
  /** Days of closed rows the correction factor is read from. */
  factorDays: number
  /** Fewer closed rows than this: the factor is 1. */
  factorMinRows: number
}

export const DEFAULT_DUE_TIME_SETTINGS: DueTimeSettings = { mode: "off", capacity: 0, defaultEstimateMinutes: 30, factorDays: 30, factorMinRows: 3 }

export const dueTimeSettingsOf = (s: { dueTimes?: Partial<DueTimeSettings> } | undefined): DueTimeSettings => ({ ...DEFAULT_DUE_TIME_SETTINGS, ...s?.dueTimes })

/** The node's capacity: the setting, else the admission cap, else 2. */
export function capacityOf(settings: DueTimeSettings, admissionMaxSessions?: number): number {
  if (settings.capacity > 0) return settings.capacity
  if (admissionMaxSessions && admissionMaxSessions > 0) return admissionMaxSessions
  return 2
}

export interface DueTimesCtx {
  settings: DueTimeSettings
  slots: SlotStore
  capacity: number
  /** An open row untouched this long, with no wake ahead, is not queued. */
  staleAfterMs: number
  /** Items one agent runs at once (its maxConcurrent). */
  lanes: (agentId: string) => number
  factor: (agentId: string) => AgentFactor
  /** The usual real minutes of this agent's work of this kind. */
  usual: (agentId: string, work: string | null) => number | null
  /** Tells whoever waits on a request that its due time moved. */
  tell?: (requester: string, text: string, requestId: string) => void
  log?: (msg: string) => void
}

/** The context the daemon passes, read from its database. An agent's
 *  past rows are read once and kept for a minute: its factor and its
 *  usual minutes both come from that one bounded read. Pass `estimates`
 *  from something that outlives the call, or the minute starts over with
 *  every context (#1920). */
export function dueTimesCtx(
  db: Database.Database,
  settings: DueTimeSettings,
  deps: {
    capacity: number; lanes: (agentId: string) => number; tell?: DueTimesCtx["tell"]; log?: (msg: string) => void; now?: () => number
    /** requests.staleAfterHours; unset, 24. */
    staleAfterHours?: number
    /** Rows kept between calls; unset, kept for this context only. */
    estimates?: EstimateCache
  },
  slots: SlotStore = new SlotStore(db),
): DueTimesCtx {
  const opts = () => ({ now: deps.now?.() ?? Date.now(), days: settings.factorDays, minRows: settings.factorMinRows })
  const estimates = deps.estimates ?? new EstimateCache()
  const rowsOf = (agentId: string): EstimateRow[] => estimates.rows(db, { ...opts(), agentId })
  return {
    settings, slots, capacity: deps.capacity, lanes: deps.lanes, tell: deps.tell, log: deps.log,
    staleAfterMs: (deps.staleAfterHours ?? 24) * 60 * 60_000,
    factor: (agentId) => factorOf(agentId, rowsOf(agentId), opts()),
    usual: (agentId, work) => usualOf(rowsOf(agentId), work, opts()),
  }
}

// ── The call's fields ─────────────────────────────────────────────────────

export interface DueFields {
  priority: Priority
  source: { kind: "requester" | "fact"; text: string } | null
  makeRoom: boolean
}

const SOURCE_TEXT_MAX = 500

/** `priority`, `dueSource` and `makeRoom` of promise and accept, read
 *  leniently: what is wrong is left at its default and named in
 *  `problems` (shadow records them; on refuses the first). */
export function readDueFields(input: Record<string, unknown>): { fields: DueFields; problems: string[] } {
  const problems: string[] = []
  let p = typeof input.priority === "string" ? input.priority.trim().toLowerCase() : ""
  if (input.priority !== undefined && input.priority !== null && typeof input.priority !== "string") p = "?"
  if (p && !(PRIORITIES as readonly string[]).includes(p)) {
    problems.push(`priority must be one of ${PRIORITIES.join(", ")}`)
    p = ""
  }
  let source: DueFields["source"] = null
  const raw = input.dueSource
  if (raw !== undefined && raw !== null && raw !== "") {
    const obj = typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const kind = String(obj.kind ?? "").trim().toLowerCase()
    const text = String(obj.text ?? "").trim()
    if (kind !== "requester" && kind !== "fact") problems.push('dueSource.kind must be "requester" (the words of the one who asked) or "fact" (a posting slot, a meeting)')
    else if (!text) problems.push("dueSource.text is required: the requester's words, or the fact that sets the time")
    else source = { kind, text: text.slice(0, SOURCE_TEXT_MAX) }
  }
  let makeRoom = false
  if (input.makeRoom !== undefined && input.makeRoom !== null && typeof input.makeRoom !== "boolean") problems.push("makeRoom must be true or false")
  else makeRoom = input.makeRoom === true
  return { fields: { priority: (p || "normal") as Priority, source, makeRoom }, problems }
}

/** The same, strictly: the first problem, or the fields. */
export function parseDueFields(input: Record<string, unknown>): DueFields | string {
  const r = readDueFields(input)
  return r.problems.length ? r.problems[0] : r.fields
}

export const ESTIMATE_TOO_LONG = `estimateMinutes must be at most ${MAX_ESTIMATE_MINUTES} (a week): split longer work into steps`

// ── Deciding ──────────────────────────────────────────────────────────────

export interface DueAsk {
  agentId: string
  /** The request it is about; null for a promise not opened yet. */
  requestId: string | null
  estimateMinutes: number | null
  work: string | null
  /** The due time the call wrote, if any. */
  due: number | null
  fields: DueFields
  requester: string | null
  words: string
  /** When the work came in; unset, now. */
  createdAt?: number
  /** What was wrong with the call's fields, in shadow: noted, not refused. */
  problems?: string[]
}

/** What the daemon gave, in the reply to the agent. */
export interface DueGiven {
  at: string
  dueAt: number
  source: DueSource
  inputs: SlotInputs
  /** Other work whose due time moved because this went ahead. */
  moved: number
}

export type DuePlan =
  /** Go on as before. `finish` records the shadow row once the id is known. */
  | { kind: "pass"; finish: (requestId: string, now: number) => void }
  | { kind: "refuse"; status: number; body: Record<string, unknown> }
  /** Go on with this due time; `finish` keeps the slot and moves others. */
  | { kind: "set"; dueAt: number; finish: (requestId: string, now: number) => DueGiven }

const NOTHING = { kind: "pass", finish: () => {} } as const

export const NO_SOURCE_REFUSAL =
  "Not recorded: you wrote a due time with no source. Register the work instead: send estimateMinutes and priority without due, " +
  "and the daemon gives the time from your queue. If the requester named the time, or an outside fact sets it (a posting slot, a meeting), " +
  'send due with dueSource {kind:"requester"|"fact", text:"<their words, or the fact>"}.'

export function planDue(ctx: DueTimesCtx | undefined, ask: DueAsk, now: number): DuePlan {
  if (!ctx || ctx.settings.mode === "off") return NOTHING
  const mode = ctx.settings.mode
  // Notices held back by the hour window, now due (on only).
  if (mode === "on") flushNotices(ctx, now)
  const factor = ctx.factor(ask.agentId)
  // Where the estimate comes from: the agent's, else its usual real time
  // for this kind of work (already real, so the factor is taken out), else
  // the default.
  let estimate = ask.estimateMinutes
  let from: SlotInputs["estimateFrom"] = "given"
  if (estimate === null || estimate <= 0) {
    const usual = ctx.usual(ask.agentId, ask.work)
    if (usual !== null) { estimate = usual / Math.max(0.01, factor.factor); from = "usual" } else { estimate = ctx.settings.defaultEstimateMinutes; from = "default" }
  }
  // One read per agent: the queue is placed several times below.
  const factors = new Map<string, number>([[ask.agentId, factor.factor]])
  const lanes = new Map<string, number>()
  const opts: SlotOptions = {
    now, capacity: ctx.capacity,
    lanes: (a) => lanes.get(a) ?? (lanes.set(a, ctx.lanes(a)), lanes.get(a)!),
    factor: (a) => factors.get(a) ?? (factors.set(a, ctx.factor(a).factor), factors.get(a)!),
    defaultMinutes: () => ctx.settings.defaultEstimateMinutes,
  }
  const id = ask.requestId ?? "(new)"
  const queue = ctx.slots.queue({ now, staleAfterMs: ctx.staleAfterMs }).filter((q) => q.id !== id)
  const job: QueueItem = {
    id, agentId: ask.agentId, priority: ask.fields.priority, ahead: false, estimateMinutes: estimate,
    // New work queues behind what came in up to now, same priority.
    createdAt: ask.createdAt ?? now + 1, dueAt: null, requester: ask.requester, source: "daemon", words: ask.words.slice(0, 80),
  }
  const computed = place(queue, job, opts, from)
  const source: DueSource = ask.due === null ? "daemon" : ask.fields.source?.kind ?? "agent"
  const fitted = ask.due !== null && ask.fields.source ? fit(queue, job, ask.due, opts, from) : null
  const wouldRefuse = ask.due !== null && !ask.fields.source ? "no source"
    : fitted && !fitted.fits && !(ask.fields.makeRoom && fitted.withRoom.meets) ? "does not fit"
    : ask.problems?.length ? `invalid: ${ask.problems.join("; ")}`.slice(0, 300) : null

  const row = (requestId: string, given: number | null, ahead: boolean, inputs: SlotInputs) => ({
    requestId, agentId: ask.agentId, priority: ask.fields.priority, ahead, source, sourceText: ask.fields.source?.text ?? null,
    mode, computedDue: computed.dueAt, agentDue: ask.due, givenDue: given, wouldRefuse, inputs,
  })

  if (mode === "shadow") {
    return {
      kind: "pass",
      finish: (requestId, at) => {
        try {
          ctx.slots.put(row(requestId, ask.due, false, computed.inputs), at)
          const diff = ask.due === null ? "no due written" : `${Math.round((ask.due - computed.dueAt) / 60_000)} min from it`
          ctx.log?.(`[due-times] shadow ${requestId} @${ask.agentId}: would give ${utc(computed.dueAt)} (${diff}${wouldRefuse ? `; would refuse: ${wouldRefuse}` : ""})`)
        } catch (e: any) {
          ctx.log?.(`[due-times] ${requestId}: shadow row not written: ${e?.message ?? e}`)
        }
      },
    }
  }

  // on
  if (ask.problems?.length) return { kind: "refuse", status: 400, body: { error: ask.problems[0] } }
  if (wouldRefuse === "no source") return { kind: "refuse", status: 400, body: { error: NO_SOURCE_REFUSAL, dueSourceRequired: true, wouldGive: iso(computed) } }
  if (fitted && !fitted.fits && wouldRefuse) return { kind: "refuse", status: 409, body: doesNotFit(ask.due!, fitted.earliest, fitted.withRoom) }

  const ahead = !!fitted && !fitted.fits
  const answer: SlotAnswer = !fitted ? computed : fitted.fits ? fitted.answer : fitted.withRoom.answer
  const dueAt = ask.due ?? computed.dueAt
  return {
    kind: "set",
    dueAt,
    finish: (requestId, at) => {
      const placed: QueueItem = { ...job, id: requestId, ahead }
      const moves = movesBy(queue, placed, opts)
      ctx.slots.put(row(requestId, dueAt, ahead, answer.inputs), at)
      for (const m of moves) {
        ctx.slots.moveDue(m.id, m.from, m.to, at)
        // One notice per request per hour: a later move in the hour is
        // told with the next notice, from the oldest time.
        const note = m.requester ? ctx.slots.noteMove(m.id, m.from, at) : { tell: false, from: m.from }
        if (m.requester && note.tell) ctx.tell?.(m.requester, moveText({ ...m, from: note.from }, ask, requestId), m.id)
        ctx.log?.(`[due-times] ${m.id}: moved from ${utc(m.from)} to ${utc(m.to)}: ${requestId} went ahead${m.requester ? (note.tell ? `; ${m.requester} told` : `; ${m.requester} told within the hour`) : ""}`)
      }
      return { at: isoOf(dueAt), dueAt, source, inputs: answer.inputs, moved: moves.length }
    },
  }
}

const iso = (a: SlotAnswer) => isoOf(a.dueAt)

/** Tells the requesters of moves held back by the hour window. */
function flushNotices(ctx: DueTimesCtx, now: number): void {
  try {
    for (const n of ctx.slots.dueNotices(now)) {
      if (!n.requester) continue
      ctx.tell?.(n.requester, `Due time moved: "${n.words}" (${n.requestId}) is now due ${utc(n.to)}, not ${utc(n.from)}. Reason: other work went ahead of it in the queue.`, n.requestId)
    }
  } catch (e: any) {
    ctx.log?.(`[due-times] held notices not sent: ${e?.message ?? e}`)
  }
}

/** The answer to a requester's time the queue cannot hold (point 3a). */
function doesNotFit(requested: number, earliest: SlotAnswer, withRoom: { answer: SlotAnswer; moves: Move[]; meets: boolean }): Record<string, unknown> {
  const room = withRoom.moves.length
    ? `To meet ${utc(withRoom.meets ? requested : withRoom.answer.dueAt)}, ${describeMoves(withRoom.moves)}.`
    : ""
  const choice = withRoom.meets
    ? `Ask the requester which they want: move that work (send again with makeRoom: true), or take ${utc(earliest.dueAt)} (send due ${iso(earliest)} with the same dueSource).`
    : `Even with room made it ends ${utc(withRoom.answer.dueAt)}. Ask the requester to take ${utc(earliest.dueAt)}, or ${utc(withRoom.answer.dueAt)} with makeRoom: true.`
  return {
    error: `Not accepted: ${utc(requested)} does not fit the queue. The earliest with nothing moved is ${utc(earliest.dueAt)}. ${room} ${choice} Nothing is recorded until they choose.`.replace(/\s+/g, " ").trim(),
    fits: false,
    requested: isoOf(requested),
    earliest: iso(earliest),
    withRoom: { dueAt: iso(withRoom.answer), meets: withRoom.meets, moves: withRoom.moves.map((m) => ({ id: m.id, agentId: m.agentId, from: isoOf(m.from), to: isoOf(m.to) })) },
    inputs: earliest.inputs,
  }
}

/** The one message a requester gets when their work moves (point 4). */
export function moveText(m: Move, ask: Pick<DueAsk, "words" | "fields" | "agentId">, requestId: string): string {
  return `Due time moved: "${m.words}" (${m.id}) is now due ${utc(m.to)}, not ${utc(m.from)}. ` +
    `Reason: "${ask.words.slice(0, 80)}" (${requestId}, ${ask.fields.priority}, @${ask.agentId}) went ahead of it in the queue.`
}

/** One line for the agent's reply. */
export function describeDue(d: DueGiven): string {
  const i = d.inputs
  const from = d.source === "daemon" ? "Due time given by the daemon" : `Due time from the ${d.source === "fact" ? "outside fact" : "requester"}, checked against the queue`
  return `${from}: ${utc(d.dueAt)}. From: ${i.queueLength} job(s) of yours ahead (${i.queueMinutes} min), priority ${i.priority}, ` +
    `estimate ${Math.round(i.estimateMinutes)} min (${i.estimateFrom}) × correction ${i.factor}, ${i.capacity} run(s) at once on this node.` +
    (d.moved ? ` ${d.moved} other job(s) moved later; their requesters were told.` : "")
}
