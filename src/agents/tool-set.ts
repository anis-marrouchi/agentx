// The tool-set seat on the live path (shadow only). See
// src/decisions/seats/tool-set.ts for the question and the policy.
//
// Asked once per fresh claude-code session, alongside the run: nothing
// waits for the answer, so shadow mode adds no time before the agent
// starts (the lesson of the #637 review). When the run ends, the built-in
// tools it called become the label, so every shadow row grades itself.

import { askSeat, getSeatMode, labelSeatCall } from "@/decisions/seat"
import {
  TOOL_SET_SEAT,
  bundleFor,
  isMiss,
  labelForTools,
  toolSetQuestions,
  toolSetState,
  type ToolBundle,
  type ToolSetAnswers,
  type ToolSetInput,
} from "@/decisions/seats/tool-set"

export interface ToolSetGuess {
  callId: string | null
  /** The bundle the session would have started with. */
  bundle: ToolBundle
  probabilities: Record<string, number>
}

let warnedActive = false

/** Ask the seat without blocking. Resolves to null when the seat is off,
 *  fails or times out; never rejects. */
export function startToolSetShadow(
  input: ToolSetInput & { taskId: string },
  log: (msg: string) => void,
): Promise<ToolSetGuess | null> | undefined {
  const mode = getSeatMode(TOOL_SET_SEAT)
  if (mode === "off") return undefined
  if (mode === "active" && !warnedActive) {
    warnedActive = true
    log(`[decisions] seat "${TOOL_SET_SEAT}" is set to active, but only shadow is built: it records and changes nothing`)
  }
  return askSeat(TOOL_SET_SEAT, toolSetState(input), toolSetQuestions, {
    incumbent: { bundle: "full" },
    links: [{ kind: "task", id: input.taskId }],
    features: { agent: input.agent, channel: input.channel ?? "unknown" },
  })
    .then((result): ToolSetGuess | null => {
      if (!result) return null
      const answers = result.answers as ToolSetAnswers
      const bundle = bundleFor(answers)
      const probabilities = ((answers.bundle as any)?.probabilities ?? {}) as Record<string, number>
      return { callId: result.callId, bundle, probabilities }
    })
    .catch(() => null)
}

/** Label the shadow call with the smallest bundle the run actually needed.
 *  Skipped when the run errored (its tool list is incomplete) or streamed
 *  no events (no tool list was captured at all). */
export function labelToolSetRun(
  pending: Promise<ToolSetGuess | null>,
  run: { toolUses: Map<string, number>; eventsSeen: boolean; error?: string; agentId: string },
  log: (msg: string) => void,
): Promise<void> {
  return pending.then((guess) => {
    if (!guess) return
    if (run.error || !run.eventsSeen) return
    const used = [...run.toolUses.keys()]
    const needed = labelForTools(used)
    labelSeatCall(guess.callId, "bundle", needed, { kind: "outcome", labeledBy: "tool-use" })
    const p = (k: string) => (typeof guess.probabilities[k] === "number" ? guess.probabilities[k].toFixed(2) : "-")
    log(
      `[${run.agentId}] tool-set shadow: would start with ${guess.bundle} ` +
        `(answer ${p("answer")}, code ${p("code")}, full ${p("full")}); ` +
        `run used ${used.filter((n) => !n.startsWith("mcp__")).join(", ") || "no built-in tool"} → needed ${needed}` +
        (isMiss(guess.bundle, needed) ? " — MISS" : ""),
    )
  }).catch(() => { /* observability never breaks the run */ })
}
