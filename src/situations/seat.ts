import type { IncomingMessage } from "@/channels/types"
import { askSeat, decisionsRuntime, getSeatMode, labelSeatCall, recordSeatOutcome } from "@/decisions/seat"
import type { DecisionAction, GradedRow, SeatMode } from "@/decisions/store"
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
// The gate asks `consult` after `decide` and before `commit`. Nothing
// happens unless the word list is unsure of the message, the talk is
// ending or has ended, and the gate would not already hold it.
//
//   seat off      nothing (today's rule)
//   seat shadow   the seat is asked WITHOUT waiting: the message goes on at
//                 once. When the answer comes back and says "no reply
//                 needed", one `would-drop` row goes in the gate log with
//                 the seat's call id, for a person to label.
//   seat active   the same as shadow, unless the calibration report passes
//                 the owner's limit (`situations.seat.maxFalseNoReply`) and
//                 the gate is in active mode. Then the gate waits for the
//                 answer (at most 1.5 s) and holds the message when the
//                 seat says no reply is needed, exactly as it holds a
//                 "thanks" (a person gets the reaction).
//
// Any failure (seat off, backend down, credits out, timeout, a report that
// cannot be read) gives today's rule: the message passes. Never throws.
//
// The mode is the seat's own (`decisions.seats.situation-phase.mode`);
// unnamed, the seat ships in shadow once decisions are on.

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
  /** The seat's mode. Unset: decisions.seats, shadow when unnamed. */
  mode?: () => SeatMode
  /** Ask the seat. Unset: askSeat. */
  ask?: Ask
  /** The seat's graded needsReply rows. Unset: the decisions store. */
  rows?: () => GradedRow[]
  /** How long a calibration plan is reused. Default 10 minutes. */
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

export class SituationSeat {
  private cached: { at: number; sig: string; plan: SeatPlan } | null = null
  private readonly pending = new Set<Promise<unknown>>()
  private lastPlanLog = ""

  constructor(private readonly deps: SituationSeatDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  mode(): SeatMode {
    try {
      return this.deps.mode?.() ?? getSeatMode(SITUATION_PHASE_SEAT, process.env, "shadow")
    } catch { return "off" }
  }

  private rows(): GradedRow[] {
    if (this.deps.rows) return this.deps.rows()
    const store = decisionsRuntime().store
    return store ? store.gradedRows({ seat: SITUATION_PHASE_SEAT, question: "needsReply" }) : []
  }

  /** The calibration report, read now. Throws when the rows cannot be read. */
  report(): SeatReport {
    const s = this.deps.settings().seat
    return situationSeatReport(this.rows(), { below: s.noReplyBelow, limit: s.maxFalseNoReply ?? null, minLabeled: s.minLabeled })
  }

  reportText(): string[] {
    return formatSeatReport(this.report())
  }

  /** May the seat act now? Cached; any error means no. */
  plan(): SeatPlan {
    const mode = this.mode()
    if (mode !== "active") return { mode, act: false, why: mode === "off" ? "the seat is off" : "shadow: the seat only records" }
    const s = this.deps.settings().seat
    const sig = JSON.stringify(s)
    const now = this.now()
    const ttl = this.deps.cacheMs ?? 10 * 60_000
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
        : await askSeat(SITUATION_PHASE_SEAT, state, situationPhaseQuestions, { ...opts, defaultMode: "shadow" })
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
  }

  private outcome(callId: string | null, action: DecisionAction): void {
    recordSeatOutcome(callId, action)
  }

  /** The gate's step between `decide` and `commit`. Returns the decision
   *  to commit: `d` unchanged, or (acting) the decision the gate makes for
   *  a closer. Never throws. */
  async consult(gate: SituationGate, msg: IncomingMessage, d: GateDecision, opts: { replay?: boolean; chatId?: string }, messageJson: () => string): Promise<GateDecision> {
    try {
      if (!d.active || d.duplicate || d.hop || d.courtesy !== "unsure" || d.unclaimed === "drop") return d
      if (d.phase !== "ending" && d.phase !== "ended") return d
      const plan = this.plan()
      if (plan.mode === "off") return d
      // What the gate would do if the word list had called it a closer.
      const would = gate.decide(msg, { ...opts, courtesy: "courtesy" })
      const wouldDrop = would.unclaimed === "drop"
      const input: SituationPhaseInput = {
        message: msg.text ?? "", senderKind: d.senderKind, channel: msg.channel, group: !!msg.group, phase: d.phase,
        why: d.record?.why, minutesInPhase: d.record ? (this.now() - d.record.phaseChangedAt) / 60_000 : 0,
      }
      const explore = this.deps.explore?.() ?? decisionsRuntime().seats[SITUATION_PHASE_SEAT]?.explore ?? 0
      const explored = plan.act && explore > 0 && (this.deps.rng ?? Math.random)() < explore
      if (!plan.act || !d.enforce || explored) {
        const p = this.ask(input, SHADOW_TIMEOUT_MS).then((v) => {
          if (!v) return
          this.outcome(v.callId, v.noReply && wouldDrop ? "skip" : "review")
          // A run that takes the message would get it anyway: no row.
          if (!v.noReply || !wouldDrop || would.claimed) return
          gate.logDrop(msg, { ...would, enforce: false, reason: seatReason(v, "shadow") }, messageJson(), "seat", v.callId)
        }).catch(() => {}).finally(() => { this.pending.delete(p) })
        this.pending.add(p)
        return d
      }
      const v = await this.ask(input, Math.min(PRE_SPAWN_SEAT_TIMEOUT_MS, decisionsRuntime().seats[SITUATION_PHASE_SEAT]?.timeoutMs ?? PRE_SPAWN_SEAT_TIMEOUT_MS))
      if (!v) return d
      this.outcome(v.callId, v.noReply && wouldDrop ? "skip" : "review")
      const seat = { callId: v.callId, pNeedsReply: v.pNeedsReply, importance: v.importance, acted: false }
      if (!v.noReply || !wouldDrop) return { ...d, seat }
      return { ...would, reason: `${would.reason}; ${seatReason(v, "active")}`, seat: { ...seat, acted: true } }
    } catch {
      return d
    }
  }
}

function seatReason(v: SeatVerdict, mode: "shadow" | "active"): string {
  return `seat: no reply needed (P(needs a reply) ${v.pNeedsReply.toFixed(2)}, ${mode})`
}
