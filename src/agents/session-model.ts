import { CACHE_TTL_MS, type RouteResult } from "./routing"
import { jobModelFor, type EdgeRouteResult } from "./edge-routing"

// One model per session (#2001).
//
// A native session (Claude Code, Codex, OpenCode) is fixed to the model it
// started on. The model is stored beside the session id (sessions.ts
// `sessionModel`) and read once, in the registry's rotation block, where
// these rules decide whether the session goes on or a new one starts:
//
//   1. No stored session: fresh. The routing seats choose as before.
//   2. A model named on the task that differs from the stored one: new
//      session, warm or cold.
//   3. Warm resume (idle under the cache lifetime): keep the stored model.
//      A confident edge answer is held, unless the session sits on a cheap
//      or triage model: then a new session starts on the edge model.
//   4. Cold resume: the seats are asked. When they answered, the model is
//      `jobModelFor(...) ?? agent model`, and a new session starts if it
//      differs. Any failure keeps the stored model.
//
// A model change is therefore always a rotation (reason "model"), with the
// memo and the history block, never a switch under a live transcript.
// Pure functions only: the registry does the I/O.

/** Models the CLIs accept as short names. The billed id spells them out. */
const ALIASES = new Set(["opus", "sonnet", "haiku", "fable"])

/**
 * Whether two model names are the same model. The CLI reports the billed
 * model as a full id ("claude-opus-5-5-20261001") or with a context suffix
 * ("claude-opus-5-5[1m]"), and config may name an alias ("opus"). Anything
 * else counts as different: "gpt-5" and "gpt-5-mini" are two models.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (new RegExp(`^${esc}(-\\d{8})?(\\[[^\\]]*\\])?$`).test(long)) return true
  return ALIASES.has(short) && new RegExp(`^claude-${esc}(-\\d+)*(\\[[^\\]]*\\])?$`).test(long)
}

/** Whether the session's cache is still warm after `idleMs`. */
export function isWarm(idleMs: number | null | undefined, ttlMs: number = CACHE_TTL_MS): boolean {
  return (idleMs ?? 0) < ttlMs
}

/** Condition 1 of the review: a resumed turn names the session's model.
 *  A session stored before #2001 has none and runs as it did before. */
export function resumeModel(
  stored: string | undefined,
  jobModel: string | undefined,
  agentModel: string | undefined,
): string | undefined {
  return stored ?? jobModel ?? agentModel
}

/** Rule 2: a model named on the task (`exec -m`, `schedule --model`) that
 *  differs from the session's starts a new session. */
export function namedModelRotates(stored: string | undefined, named: string | undefined): boolean {
  return Boolean(stored && named && !sameModel(stored, named))
}

export interface ColdResumeInput {
  stored: string
  agentModel: string | undefined
  /** The triage rule's result. A triage downgrade is a fixed rule, so it
   *  counts as an answer. */
  triage?: RouteResult
  /** The downgrade seat's result. */
  routed?: RouteResult
  /** The task-edge seat's result. */
  edge?: EdgeRouteResult
}

/**
 * Rule 4 (condition 2 of the review): the model for a cold resume. A seat
 * that answered picks `jobModelFor(...) ?? agent model`, and the session
 * rotates when that differs from the stored model. A seat that failed (threw
 * or timed out) keeps the stored model, and so does no answer at all (seat
 * off or in shadow). `jobModelFor` alone cannot tell "no change" from "no
 * answer", which is why the seats now report their outcome.
 */
export function coldResumeChoice(input: ColdResumeInput): { rotate: boolean; model: string } {
  const keep = { rotate: false, model: input.stored }
  if (input.triage?.downgraded && input.triage.model) {
    return sameModel(input.triage.model, input.stored) ? keep : { rotate: true, model: input.triage.model }
  }
  if (input.routed?.seat === "failed" || input.edge?.seat === "failed") return keep
  if (input.routed?.seat !== "answered" && input.edge?.seat !== "answered") return keep
  const routedModel = input.routed?.downgraded ? input.routed.model : undefined
  const model = jobModelFor(input.edge, routedModel) ?? input.agentModel
  if (!model || sameModel(model, input.stored)) return keep
  return { rotate: true, model }
}

/** Condition 3: a warm session may hold an edge upgrade only when it runs
 *  on the agent's own model or the edge model. */
export function canHoldUpgrade(
  stored: string,
  agentModel: string | undefined,
  edgeModel: string | undefined,
): boolean {
  return sameModel(stored, agentModel) || sameModel(stored, edgeModel)
}

/** Condition 3: the model a warm session on a cheap or triage model moves
 *  to, when the edge seat answered and is sure. Undefined: stay. */
export function warmEdgeRotates(
  stored: string,
  agentModel: string | undefined,
  edgeModel: string | undefined,
  edge: EdgeRouteResult | undefined,
): string | undefined {
  if (canHoldUpgrade(stored, agentModel, edgeModel)) return undefined
  if (edge?.seat !== "answered" || !edge.model) return undefined
  return sameModel(edge.model, stored) ? undefined : edge.model
}

/** An edge answer with its model dropped: the implied-work line and the
 *  sub-agent hint stay, the session keeps its model. */
export function heldEdgeRoute(route: EdgeRouteResult): EdgeRouteResult {
  const { model: _model, ...rest } = route
  return { ...rest, upgraded: false }
}

/**
 * The model to store for a session after a turn: the one the turn asked
 * for. Never the billed model: that is the most expensive entry of the
 * CLI's usage report, which can be a side or sub-agent model, and storing
 * it would pin every warm turn of the session to that model. `sameModel`
 * handles dated ids and aliases where models are compared. Nothing is
 * stored for an agent with no model named: the engine default runs, as
 * before.
 */
export function modelToStore(asked: string | undefined, _billed?: string): string | undefined {
  return asked || undefined
}
