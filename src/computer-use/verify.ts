import { look, type LookOptions, type Sighting } from "./look"
import { probe, type Probe } from "./probes"
import { askSeat } from "@/decisions/seat"
import {
  SCREEN_STATE_SEAT,
  screenStateQuestions,
  screenStateState,
  toVerdict,
} from "@/decisions/seats/screen-state"

// Checking that an instruction actually took effect.
//
// The rule this enforces: an action is not done because the call that
// performed it returned. It is done when the effect has been OBSERVED.
// Everything that used to pass for verification here — a helper exiting 0,
// a pixel diff around the cursor, a tree containing the element we asked
// for — confirms that something was attempted, not that anything happened.
//
// Three outcomes, and the third is the point:
//
//   confirmed  the effect is visible
//   refuted    the effect is visibly absent — stop, and say what was seen
//   unknown    the capture could not settle it — ALSO stop
//
// `unknown` is not a soft pass. A verifier that treats "I could not tell"
// as "fine" is worse than no verifier, because it launders a guess into a
// check. Callers are expected to treat anything other than `confirmed` as
// a reason not to continue, which is why `ok` is defined the way it is.
//
// The decision seat is fail-OPEN by contract: askSeat returns null when the
// seat is off or the backend is unreachable. That default is wrong here —
// it would turn a missing verifier into a pass — so a null seat falls back
// to the vision model's own reading and the result is marked uncalibrated,
// with `unclear` mapping to `unknown` rather than to success.

export type Outcome = "confirmed" | "refuted" | "unknown"

export interface Verification {
  claim: string
  outcome: Outcome
  /** True only for `confirmed`. The single thing a caller should branch on. */
  ok: boolean
  /** P(the gathered evidence settles the claim). Null when no seat answered. */
  observable: number | null
  /** P(the claim holds). Null when no seat answered. */
  holds: number | null
  /** False when the seat was unavailable and the vision model's own
   *  uncalibrated reading was used instead. */
  calibrated: boolean
  /** Plain-words explanation, suitable for showing a person. */
  reason: string
  sighting: Sighting
  /** Deterministic facts weighed alongside the image. */
  probes: Probe[]
}

/** Below this, nothing gathered could settle the question, and the answer
 *  to `holds` is noise regardless of how confident it looks. */
const OBSERVABLE_FLOOR = 0.6
const HOLDS_TRUE = 0.7
const HOLDS_FALSE = 0.3

export interface VerifyOptions extends LookOptions {
  /** What the accessibility tree said, to corroborate the observation. */
  treeNote?: string
  /** Lets a caller demand more certainty for a costly or risky step. */
  observableFloor?: number
}

/**
 * Look at the screen and report whether a claim about it is true.
 *
 * `claim` is a statement, not a question: "the search field contains
 * from:naval", "a recording is in progress", "the compose dialog is
 * covering the timeline".
 */
export async function verify(claim: string, opts: VerifyOptions = {}): Promise<Verification> {
  // Both sources, gathered before either is judged. The probes are the
  // only thing in the state that a confident wrong observation cannot
  // talk its way past.
  const [sighting, probes] = await Promise.all([
    look(claim, opts),
    probe(claim).catch((): Probe[] => []),
  ])
  const floor = opts.observableFloor ?? OBSERVABLE_FLOOR

  const seat = await askSeat(
    SCREEN_STATE_SEAT,
    screenStateState({
      claim,
      observation: sighting.observation,
      evidence: sighting.evidence,
      reading: sighting.reading,
      region: regionWords(sighting),
      treeNote: opts.treeNote,
      probes,
    }),
    screenStateQuestions,
    {
      // What the code would have concluded without the seat, so agreement
      // and eventual promotion stay measurable.
      incumbent: { holds: sighting.reading === "yes" ? 1 : 0 },
      features: { model: sighting.model, region: sighting.shot.region.height <= 40 ? "menubar" : "window" },
    },
  )

  if (!seat) {
    // No seat: the vision model's reading is all there is, and it is not
    // calibrated. `unclear` must not become a pass.
    const outcome: Outcome =
      sighting.reading === "yes" ? "confirmed" : sighting.reading === "no" ? "refuted" : "unknown"
    return {
      claim, outcome, ok: outcome === "confirmed",
      observable: null, holds: null, calibrated: false,
      reason: uncalibratedReason(outcome, sighting),
      sighting, probes,
    }
  }

  const { observable, holds } = toVerdict(seat.answers)
  if (observable < floor) {
    return {
      claim, outcome: "unknown", ok: false,
      observable, holds, calibrated: true,
      reason:
        `Could not tell from the screenshot or the system checks (${pct(observable)} that the evidence settles it). ` +
        `Seen: ${sighting.observation || "nothing conclusive"}`,
      sighting, probes,
    }
  }

  const outcome: Outcome = holds >= HOLDS_TRUE ? "confirmed" : holds <= HOLDS_FALSE ? "refuted" : "unknown"
  return {
    claim, outcome, ok: outcome === "confirmed",
    observable, holds, calibrated: true,
    reason: calibratedReason(outcome, holds, sighting),
    sighting, probes,
  }
}

function calibratedReason(outcome: Outcome, holds: number, s: Sighting): string {
  const detail = s.evidence || s.observation || "no specific detail"
  if (outcome === "confirmed") return `Confirmed (${pct(holds)}). ${detail}`
  if (outcome === "refuted") return `Not true (${pct(1 - holds)} it is false). ${detail}`
  return `Inconclusive (${pct(holds)}, between the thresholds). ${detail}`
}

function uncalibratedReason(outcome: Outcome, s: Sighting): string {
  const detail = s.evidence || s.observation || "no specific detail"
  const caveat = " — uncalibrated, the screen-state seat is off"
  if (outcome === "unknown") return `Could not tell${caveat}. ${detail}`
  return `${outcome === "confirmed" ? "Looks true" : "Looks false"}${caveat}. ${detail}`
}

function regionWords(s: Sighting): string {
  const r = s.shot.region
  if (r.y <= 1 && r.height <= 40) return "the macOS menu bar"
  return `a ${Math.round(r.width)}x${Math.round(r.height)} region of the screen`
}

const pct = (p: number) => `${Math.round(p * 100)}%`
