import { choice } from "@/decisions/questions"
import { askSeat } from "@/decisions/seat"
import { render } from "../template"
import type { StateValue } from "@/decisions/types"
import type { NodeHandler } from "./types"

// A classification node that classifies.
//
// The pattern the editor has taught until now is an `agent` node whose
// prompt ends "reply on one line: RESULT: a|b|c", parsed back out with
// a regex. That runs a full agent turn — on this fleet, Opus 5 — to
// produce one token, and it has three problems beyond the cost.
//
// It returns no probabilities, so a `switch` downstream can only ask
// which label came back, never how sure the model was. It cannot say "I
// don't know": every input is forced into a label. And when the token
// is missing or malformed the parser yields nothing and the run takes
// the default port silently, which is the worst possible failure for a
// branch — indistinguishable from a real decision.
//
// This asks the decision seat instead. One call, a distribution back,
// and the node is its own branch: it fires the port named after the
// winning label, or `unsure` when nothing clears the threshold. That
// last port is the whole point. A workflow can now escalate the 10% it
// should not have guessed at, which is the same confidence-gated
// routing classifier.dev built on top of Jev to gain 2.5 points on AG
// News — except here the uncertain branch is a first-class edge an
// author can wire to a human.

export const CLASSIFY_SEAT = "workflow-classify"

/** Ports a classify node can fire beyond its labels. */
export const UNSURE_PORT = "unsure"

export const classifyHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const vars = ctx.run.context as unknown as Record<string, unknown>
  const opts = { envAllow: ctx.workflow.envAllow }

  const input = render(String(cfg.input ?? ""), vars, opts).trim()
  if (!input) return { error: `classify node "${ctx.node.id}" missing config.input` }

  // Labels may be given as a map (label → description, which is what the
  // model actually needs) or as a bare list for quick authoring.
  const raw = cfg.labels
  const labels: Record<string, string | null> = Array.isArray(raw)
    ? Object.fromEntries(raw.map((l) => [String(l), null]))
    : typeof raw === "object" && raw
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>)
          .map(([k, v]) => [k, v == null ? null : String(v)]))
      : {}

  const names = Object.keys(labels)
  if (names.length < 2) {
    return { error: `classify node "${ctx.node.id}" needs at least two labels` }
  }
  if (names.includes(UNSURE_PORT)) {
    // Otherwise a low-confidence answer and a confident "unsure" fire the
    // same port and the distinction the node exists for is erased.
    return { error: `classify node "${ctx.node.id}": "${UNSURE_PORT}" is reserved for the low-confidence port` }
  }

  const minConfidence = typeof cfg.minConfidence === "number" ? cfg.minConfidence : 0.7
  const instructions = cfg.instructions ? render(String(cfg.instructions), vars, opts) : undefined

  const state: Record<string, StateValue> = { input }
  if (cfg.state && typeof cfg.state === "object") {
    for (const [k, v] of Object.entries(cfg.state as Record<string, unknown>)) {
      // Anything a template can produce is JSON; anything else is the
      // author's mistake and is better dropped than stringified into
      // "[object Object]" for the model to puzzle over.
      const rendered = typeof v === "string" ? render(v, vars, opts) : v
      if (rendered === null || ["string", "number", "boolean"].includes(typeof rendered)) {
        state[k] = rendered as StateValue
      }
    }
  }

  const res = await askSeat(
    CLASSIFY_SEAT,
    state,
    { label: choice(labels, instructions) },
    { features: { workflow: ctx.workflow.id, node: ctx.node.id } },
  )

  // The seat is off, or the backend failed. Fail the node rather than
  // guessing a port: a branch that silently picks a direction when its
  // decision procedure is unavailable is how a workflow does the wrong
  // thing confidently.
  if (!res) {
    return { error: `classify node "${ctx.node.id}": decision seat unavailable (set decisions.seats.${CLASSIFY_SEAT}.mode)` }
  }

  const answer = res.answers.label as { choice: string; confidence: number; probabilities: Record<string, number> }
  const confident = answer.confidence >= minConfidence
  const port = confident ? answer.choice : UNSURE_PORT

  ctx.log(`[node:${ctx.node.id}] classify → ${answer.choice} (${answer.confidence.toFixed(2)})${confident ? "" : ` — below ${minConfidence}, routing to ${UNSURE_PORT}`}`)

  return {
    output: {
      // `result` keeps the name the RESULT-token pattern used, so an
      // existing workflow can swap the node kind without rewriting the
      // {{node.result}} references downstream.
      result: answer.choice,
      label: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      unsure: !confident,
      port,
    },
    port,
  }
}
