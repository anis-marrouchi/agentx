import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// The guard-risk seat.
//
// Deterministic rules catch the destructive commands somebody already
// thought to write a rule for. This seat exists for the ones nobody did:
// the novel phrasing, the unfamiliar tool, the pipeline that resolves to a
// deletion three substitutions deep.
//
// WHY THIS SEAT CANNOT MAKE THE GUARD PROBABILISTIC.
//
// A safety gate whose decisions depend on a model is not a safety gate.
// The property that has to hold is: *the set of operations that run
// without asking is decided entirely by deterministic rules.* This seat is
// allowed to REMOVE operations from that set and never to add one.
//
//   deterministic rules say deny      -> deny.      Seat not consulted.
//   deterministic rules say ask       -> ask.       Seat cannot downgrade.
//   deterministic rules say allow     -> seat may raise it to ask.
//   seat unavailable / errors / null  -> ask, on any mutating operation.
//
// So Jev can cost you an extra confirmation dialog. It can never cost you
// a database. The worst a compromised, broken or hallucinating model can
// do here is make the tool more annoying, which is the only kind of
// failure a guard is allowed to have.
//
// Same one-directional shape as the session-continuity seat, for the same
// reason: the two error directions have wildly different costs, so the
// cheap one is the only one the model is permitted to cause.
//
// NOTE ON NONDETERMINISM. Jev's answers vary run to run (measured at about
// ±0.05 on repeated identical calls). That varies the FRICTION — whether a
// borderline command prompts this time — not the SAFETY, because nothing
// the model returns can produce an allow. Do not "fix" this by letting a
// low score skip a deterministic ask.

export const GUARD_RISK_SEAT = "guard-risk"

// Phrased against the state's own field names, with the boundary stated in
// criteria rather than implied. An earlier seat in this codebase asked
// "is this part of the same piece of work" with no criteria and the two
// populations came out the wrong way round — a vague question gives the
// probability nothing stable to mean.
export const guardRiskQuestions = {
  destroys: noul(
    "Running this command would destroy or overwrite data that cannot be trivially recovered.",
    {
      true:
        "Deletes, truncates, overwrites or drops files, tables, volumes, branches or remote state — including indirectly, e.g. a redirect that clobbers a file, a force-push, a reset --hard, a migration that drops a column, or a script whose purpose is cleanup.",
      false:
        "Reads, lists, inspects, builds, tests, or writes somewhere scratch and reversible — a new file, a temp directory, a log, an append that loses nothing.",
    },
  ),
  production: noul(
    "The data this command would affect belongs to a live production system rather than a local or scratch environment.",
    {
      true:
        "Names a production host, a live database, a deployed service, a shared remote, or a path under a production data directory.",
      false:
        "Local working copy, a container, a test fixture, a scratch directory, or an environment explicitly marked dev, staging, test or sandbox.",
    },
  ),
}

export type GuardRiskAnswers = AnswersFor<typeof guardRiskQuestions>

export interface GuardRiskInput {
  tool: string
  command: string
  filePath?: string | null
  /** What the deterministic layer already resolved, when it resolved
   *  anything — the model should see the same target the rules saw. */
  resolvedTarget?: string | null
  agentId?: string | null
  cwd?: string | null
}

export function guardRiskState(input: GuardRiskInput): StateValue {
  return {
    tool: input.tool,
    command: clip(input.command, 4000),
    filePath: input.filePath ?? null,
    resolvedTarget: input.resolvedTarget ?? null,
    agent: input.agentId ?? null,
    workingDirectory: input.cwd ?? null,
  }
}

/** Thresholds for RAISING an allow to an ask. There is no threshold for
 *  lowering anything, because nothing here may be lowered. */
export interface RiskPolicy {
  /** Either noul at or above this asks for confirmation. */
  askAbove?: number
}

/**
 * Should a would-be-allowed operation be escalated to a confirmation?
 *
 * Returns true to ASK. There is deliberately no return value meaning
 * "allow" — the caller's default when this returns false is whatever the
 * deterministic rules already decided, not an approval from this seat.
 *
 * `answers` being null (seat off, backend down, timeout, malformed reply)
 * is a caller-side concern and MUST be treated as ask for any mutating
 * operation. askSeat is fail-open by contract; a guard is not.
 */
export function shouldAskForConfirmation(
  answers: GuardRiskAnswers,
  policy: RiskPolicy = {},
): boolean {
  // 0.35, not 0.5. The costs are not symmetric: a false ask costs one
  // click, a false allow can cost a database, so the threshold sits well
  // below "more likely than not".
  const askAbove = policy.askAbove ?? 0.35
  const destroys = (answers.destroys as NoulAnswer).noul
  const production = (answers.production as NoulAnswer).noul

  // Either alone is enough. A destructive command in a scratch directory
  // still deserves a look, and anything touching production does too —
  // requiring both would let each excuse the other.
  return destroys >= askAbove || production >= askAbove
}

function clip(value: string, max: number): string {
  const text = String(value ?? "")
  return text.length > max ? text.slice(0, max) : text
}
