import type { IncomingMessage } from "@/channels/types"
import { askSeat, decisionsRuntime, getSeatMode, labelSeatCall, recordSeatOutcome } from "@/decisions/seat"
import type { GradedRow, SeatMode } from "@/decisions/store"
import { PRE_SPAWN_SEAT_TIMEOUT_MS } from "@/decisions/limits"
import {
  pNeedsReply, saysNoReply, seatImportance, seatPhase, SITUATION_PHASE_SEAT, situationPhaseQuestions, situationPhaseState,
  type SituationImportance, type SituationPhaseAnswers, type SituationPhaseInput,
} from "@/decisions/seats/situation-phase"
import type { StateValue } from "@/decisions/types"
import type { SituationsConfig } from "./config"
import { formatSeatReport, situationSeatReport, type SeatReport } from "./seat-report"
import type { GateDecision, SituationGate } from "./gate"

// --- The situation-phase seat at the gate (#1892, phase 5) ---
//
// The gate asks `consult` after `decide` and before `commit`. The seat is
// asked only when the word list is unsure of the message, the talk is
// ending or has ended, the gate would not already hold it, and its answer
// could change something: the gate would hold a closer here and no run
// claims the message (or, when the seat acts, importance is on).
//
//   seat off      nothing (today's rule). The default: like every seat, it
//                 is off until the operator names it in
//                 decisions.seats.situation-phase, with a hosted backend
//                 (Jev), so no local model process is ever started for it.
//   seat shadow   asked WITHOUT waiting: `consult` returns at once, the
//                 message goes on. A "no reply needed" answer becomes one
//                 `would-drop` row in the gate log with the seat call id,
//                 for a person to label.
//   seat active   the same as shadow, unless the calibration report passes
//                 the owner's limit (`situations.seat.maxFalseNoReply`) and
//                 the gate is in active mode. Then `consult` returns a
//                 promise (at most 1.5 s) and the router holds a per-chat
//                 lock around decide, consult and commit; a "no reply
//                 needed" holds the message as a "thanks" is held.
//
// Any failure (backend down, credits out, timeout, a report that cannot be
// read) gives today's rule: the message passes. Never throws.

export interface SeatPlan {
  mode: SeatMode
  /** The seat's answer may hold a message. */
  act: boolean
  why: string
}

export interface SeatVerdict {
  callId: string | null
  pNeedsReply: number
  noReply: boolean
  phase: string | null
  importance: SituationImportance | null
}

type Ask = (state: StateValue, opts: { timeoutMs: number; incumbent: Record<string, string>; features: Record<string, string | boolean> }) =>
  Promise<{ answers: SituationPhaseAnswers; callId: string | null } | null>

export interface SituationSeatDeps {
  settings: () => SituationsConfig
  /** The seat's mode. Unset: decisions.seats (off when unnamed). */
  mode?: () => SeatMode
  /** The backend the seat uses now. Unset: its setting, else the default. */
  backend?: () => string
  /** Ask the seat. Unset: askSeat. */
  ask?: Ask
  /** The seat's graded needsReply rows. Unset: the decisions store. */
  rows?: () => GradedRow[]
  /** How long a calibration plan is reused. Default (and at most) 60 s. */
  cacheMs?: number
  /** Share of acting answers let through anyway, to keep grading the
   *  region the seat holds. Unset: decisions.seats.situation-phase.explore. */
  explore?: () => number
  rng?: () => number
  log?: (line: string) => void
  now?: () => number
}

/** A shadow call never waits on the routing path; this bounds it. */
const SHADOW_TIMEOUT_MS = 10_000
const MAX_CACHE_MS = 60_000

type ConsultOpts = { replay?: boolean; chatId?: string }

export class SituationSeat {
  private cached: { at: number; sig: string; plan: SeatPlan } | null = null
  private readonly pending = new Set<Promise<unknown>>()
  private lastPlanLog = ""

  constructor(private readonly deps: SituationSeatDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  mode(): SeatMode {
    try {
      return this.deps.mode?.() ?? getSeatMode(SITUATION_PHASE_SEAT)
    } catch { return "off" }
  }

  private backend(): string {
    if (this.deps.backend) return this.deps.backend()
    const rt = decisionsRuntime()
    return rt.seats[SITUATION_PHASE_SEAT]?.backend ?? rt.defaultBackend
  }

  private rows(): GradedRow[] {
    if (this.deps.rows) return this.deps.rows()
    const store = decisionsRuntime().store
    return store ? store.gradedRows({ seat: SITUATION_PHASE_SEAT, question: "needsReply" }) : []
  }

  /** The calibration report for the backend in use and the model it
   *  answers with now (its newest row). Throws when rows cannot be read. */
  report(): SeatReport {
    const s = this.deps.settings().seat
    const backend = this.backend()
    const rows = this.rows()
    let model: string | null = null
    let newest = -Infinity
    for (const r of rows) if (r.backend === backend && r.ts > newest) { newest = r.ts; model = r.model }
    return situationSeatReport(rows, { below: s.noReplyBelow, limit: s.maxFalseNoReply ?? null, minLabeled: s.minLabeled, backend, model })
  }

  reportText(): string[] {
    return formatSeatReport(this.report())
  }

  /** May the seat act now? Cached at most a minute; any error means no. */
  plan(): SeatPlan {
    const mode = this.mode()
    if (mode !== "active") return { mode, act: false, why: mode === "off" ? "the seat is off" : "shadow: the seat only records" }
    const s = this.deps.settings().seat
    const sig = JSON.stringify([s, this.backend()])
    const now = this.now()
    const ttl = Math.min(this.deps.cacheMs ?? MAX_CACHE_MS, MAX_CACHE_MS)
    if (this.cached && this.cached.sig === sig && now - this.cached.at < ttl) return this.cached.plan
    let plan: SeatPlan
    try {
      const r = this.report()
      plan = { mode, act: r.ready, why: r.why }
    } catch (e: any) {
      plan = { mode, act: false, why: `the calibration report could not be read: ${e?.message ?? e}` }
    }
    this.cached = { at: now, sig, plan }
    if (!plan.act && plan.why !== this.lastPlanLog) {
      this.lastPlanLog = plan.why
      this.deps.log?.(`[situation] seat situation-phase is active but does not act: ${plan.why}`)
    }
    return plan
  }

  /** A new label can change readiness: the next plan reads it. */
  private invalidate(): void { this.cached = null }

  /** Ask the seat. Null on any failure. */
  async ask(input: SituationPhaseInput, timeoutMs: number): Promise<SeatVerdict | null> {
    try {
      const state = situationPhaseState(input)
      const opts = {
        timeoutMs,
        // Today's rule: an unsure message passes, needs a reply, and does
        // not move the phase.
        incumbent: { needsReply: "yes", phase: input.phase },
        features: { channel: input.channel, sender: input.senderKind, group: input.group, phase: input.phase },
      }
      const res = this.deps.ask
        ? await this.deps.ask(state, opts)
        : await askSeat(SITUATION_PHASE_SEAT, state, situationPhaseQuestions, opts)
      if (!res) return null
      const below = this.deps.settings().seat.noReplyBelow
      return {
        callId: res.callId,
        pNeedsReply: pNeedsReply(res.answers),
        noReply: saysNoReply(res.answers, below),
        phase: seatPhase(res.answers),
        importance: seatImportance(res.answers),
      }
    } catch {
      return null
    }
  }

  /** Wait for every shadow call in flight (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  /** A person re-delivered a message the seat held: it needed a reply. */
  labelRelease(callId: string, by = "release"): void {
    labelSeatCall(callId, "needsReply", "yes", { kind: "human", labeledBy: by })
    this.invalidate()
  }

  /** The gate's step between `decide` and `commit`. Returns `d` at once
   *  when the seat is not waited for (off, shadow, not calibrated, not
   *  useful, explored), else a promise of the decision to commit. Never
   *  throws, and the promise never rejects. */
  consult(gate: SituationGate, msg: IncomingMessage, d: GateDecision, opts: ConsultOpts, messageJson: () => string): GateDecision | Promise<GateDecision> {
    try {
      if (!d.active || d.duplicate || d.hop || d.courtesy !== "unsure" || d.unclaimed === "drop") return d
      if (d.phase !== "ending" && d.phase !== "ended") return d
      const plan = this.plan()
      if (plan.mode === "off") return d
      // What the gate would do if the word list had called it a closer.
      const would = gate.decide(msg, { ...opts, courtesy: "courtesy" })
      const useful = would.unclaimed === "drop" && !would.claimed
      const acting = plan.act && d.enforce
      const forImportance = acting && this.deps.settings().importance.enabled
      // The answer could change nothing: do not ask.
      if (!useful && !forImportance) return d
      const input: SituationPhaseInput = {
        message: msg.text ?? "", senderKind: d.senderKind, channel: msg.channel, group: !!msg.group, phase: d.phase,
        endReason: d.phase === "ended" ? d.record?.endReason ?? null : null,
        minutesInPhase: d.record ? (this.now() - d.record.phaseChangedAt) / 60_000 : 0,
      }
      const explore = this.deps.explore?.() ?? decisionsRuntime().seats[SITUATION_PHASE_SEAT]?.explore ?? 0
      const explored = acting && useful && explore > 0 && (this.deps.rng ?? Math.random)() < explore
      if (!acting || explored) {
        const p = this.ask(input, SHADOW_TIMEOUT_MS).then((v) => {
          if (!v) return
          recordSeatOutcome(v.callId, v.noReply && useful ? "skip" : "review", explored)
          if (!v.noReply || !useful) return
          gate.logDrop(msg, { ...would, enforce: false, reason: seatReason(v, explored ? "explored" : "shadow") }, messageJson(), "seat", v.callId)
        }).catch(() => {}).finally(() => { this.pending.delete(p) })
        this.pending.add(p)
        return d
      }
      return this.waitFor(input, d, would, useful)
    } catch {
      return d
    }
  }

  private async waitFor(input: SituationPhaseInput, d: GateDecision, would: GateDecision, useful: boolean): Promise<GateDecision> {
    try {
      const v = await this.ask(input, Math.min(PRE_SPAWN_SEAT_TIMEOUT_MS, decisionsRuntime().seats[SITUATION_PHASE_SEAT]?.timeoutMs ?? PRE_SPAWN_SEAT_TIMEOUT_MS))
      if (!v) return d
      recordSeatOutcome(v.callId, v.noReply && useful ? "skip" : "review")
      const seat = { callId: v.callId, pNeedsReply: v.pNeedsReply, importance: v.importance, acted: false }
      if (!v.noReply || !useful) return { ...d, seat }
      return { ...would, reason: `${would.reason}; ${seatReason(v, "active")}`, seat: { ...seat, acted: true } }
    } catch {
      return d
    }
  }
}

function seatReason(v: SeatVerdict, mode: "shadow" | "active" | "explored"): string {
  return `seat: no reply needed (P(needs a reply) ${v.pNeedsReply.toFixed(2)}, ${mode})`
}
