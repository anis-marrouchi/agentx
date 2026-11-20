import { askSeat, getSeatMode } from "@/decisions/seat"
import { PRE_SPAWN_SEAT_TIMEOUT_MS } from "@/decisions/limits"
import {
  TASK_EDGE_SEAT,
  impliedWork,
  taskEdgeQuestionsFor,
  taskEdgeState,
  type TaskEdgeInput,
} from "@/decisions/seats/task-edge"
import { channelKeepsConfiguredModel } from "./routing"

// Moving one job UP to the edge model, and telling it to use sub-agents.
//
// The policy, in one line: the job keeps the agent's own model and gets no
// sub-agent hint unless the task-edge seat is ACTIVE and confidently says
// otherwise. Seat off, seat in shadow, backend unreachable, an answer
// under the threshold, no edge model named: all of them change nothing.
//
// One model per session (#2001): the model is fixed when a session starts
// and stored with it (sessions.ts sessionModel). On a warm resume this
// seat is still asked, for the implied-work line and the sub-agent hint,
// but its model answer is held: the session keeps its model and the
// registry logs "edge upgrade held". The move up happens only when a new
// session starts: a fresh chat, a cold resume (idle past the cache
// lifetime) where the seat answered, or a warm session that sits on a
// cheap or triage model. The registry decides that in its rotation block
// (session-model.ts); this file only answers the question.
//
// Sub-agents: Claude Code can already start them, and AgentX never asked
// it to. When the seat says the job splits into independent parts, the
// turn carries one line asking for them. On an edge job the sub-agents
// also run on the edge model (CLAUDE_CODE_SUBAGENT_MODEL), so a hard job
// is not handed to a smaller model one level down.

/** At or above this P(needs the edge model), the job moves up. On ten
 *  sample tasks (2026-11-14, Jev) routine work scored 0.24 or less and
 *  hard work 0.64 or more; the line sits in the upper part of that gap
 *  because the edge model costs more and uses the same weekly quota. */
export const UPGRADE_AT = 0.7

/** At or above this P(sub-agents help), the turn asks for them. */
export const SUBAGENTS_AT = 0.7

/** At or above this P(work is implied, not asked), the message is read as
 *  a job. Higher than the others: a remark taken for a job starts work
 *  nobody asked for. Live Jev gave 0.98 and 0.99 on the two samples. */
export const IMPLIED_AT = 0.8

/** At or above this P(the fix needs a design change), implied work moves
 *  up to the edge model. Samples: 0.85 and 0.86 against 0.10 and 0.30. */
export const DESIGN_AT = 0.7

/** How implied work is handled (`decisions.routing.impliedWork`). */
export type ImpliedWorkMode = "off" | "shadow" | "active"

/** The one line a turn carries when work is implied. The agent states the
 *  job, so the person sees the reading and can correct it. */
export const IMPLIED_WORK_NOTE =
  "[Implied request] This message describes a problem and does not say what to do. Start your reply with one sentence that states the job as you understand it, then do that job. If it could mean two different jobs, or the work cannot be undone, ask one question first."

export { SUBAGENT_MODEL_ENV } from "./process-registry"

/** The one line an advised turn carries. */
export const SUBAGENT_NOTE =
  "[Sub-agents] This job has parts that do not depend on each other. Start sub-agents (the Agent tool, named Task in older Claude Code) for those parts in one message so they run at the same time, give each a complete brief, and check their results yourself before you report."

/** Whether the task-edge seat is asked at all. False when it is off, so a
 *  node that does not use it adds no step to a run. */
export function edgeSeatOn(): boolean {
  try {
    return getSeatMode(TASK_EDGE_SEAT) !== "off"
  } catch {
    return false
  }
}

/** The edge model for an agent's CLI engine, or undefined when none is
 *  named or the name does not belong to that engine. */
export function edgeModelForEngine(
  tier: string,
  routing?: { edgeModels?: { "claude-code"?: string; "codex-cli"?: string } },
): string | undefined {
  if (tier === "claude-code") {
    const model = routing?.edgeModels?.[tier]
    return model && /^(claude-|fable$|opus$|sonnet$)/.test(model) ? model : undefined
  }
  if (tier === "codex-cli") {
    const model = routing?.edgeModels?.[tier]
    return model && /^(gpt-|o\d)/.test(model) ? model : undefined
  }
  return undefined
}

/** Whether a `claude` flag list leaves the sub-agent tool in. No `--tools`
 *  flag means every built-in tool. */
export function subagentToolAvailable(claudeArgs: readonly string[] | undefined): boolean {
  const at = claudeArgs?.indexOf("--tools") ?? -1
  if (at < 0) return true
  const tools = (claudeArgs![at + 1] ?? "").split(",").map((t) => t.trim())
  return tools.includes("Agent") || tools.includes("Task")
}

export interface EdgeRouteResult {
  /** The edge model, when the seat is sure this job needs it and one is
   *  configured. Set even when the agent already runs on it, so a
   *  downgrade routed for the same job is dropped (jobModelFor). */
  model?: string
  /** True when this call moved the job up from the agent's own model. */
  upgraded: boolean
  /** True when the turn should ask for sub-agents. */
  subagents: boolean
  /** P(needs the edge model), or null when nothing was asked. */
  needsEdge: number | null
  /** P(sub-agents help), or null when nothing was asked. */
  subagentsHelp: number | null
  /** True when the turn should carry the implied-request line. */
  impliedWork?: boolean
  /** P(work is implied, not asked), or null when not asked. */
  impliedP?: number | null
  /** P(the fix needs a design change), or null when not asked. */
  designChange?: number | null
  /** "answered": an active seat gave an answer. "failed": the seat was
   *  asked and threw or timed out. Unset: not asked, or in shadow (#2001). */
  seat?: "answered" | "failed"
  reason: string
}

export interface EdgeRouteOptions extends TaskEdgeInput {
  /** The agent's CLI engine. Sub-agents are a Claude Code feature. */
  tier: string
  /** The model to move up to. Usually from config; no upgrade without it. */
  edgeModel?: string | null
  /** The model the job would run on otherwise. */
  currentModel?: string | null
  upgradeAt?: number
  subagentsAt?: number
  /** Whether a message that only describes a problem is read as a job.
   *  The caller passes "off" for turns no person wrote. */
  impliedWork?: ImpliedWorkMode
}

/**
 * Decide whether this job moves to the edge model and whether it should
 * use sub-agents. Never throws: this decision must not be able to stop a
 * task from running.
 */
export async function routeTaskEdge(opts: EdgeRouteOptions): Promise<EdgeRouteResult> {
  let pImplied: number | null = null
  let pDesign: number | null = null
  const keep = (reason: string, pEdge: number | null = null, pSub: number | null = null, seat?: "answered" | "failed"): EdgeRouteResult => ({
    upgraded: false, subagents: false, needsEdge: pEdge, subagentsHelp: pSub,
    ...(seat ? { seat } : {}),
    ...(pImplied !== null || pDesign !== null ? { impliedWork: false, impliedP: pImplied, designChange: pDesign } : {}),
    reason,
  })
  const impliedMode: ImpliedWorkMode = opts.impliedWork ?? "off"
  const askImplied = impliedMode !== "off"

  if (channelKeepsConfiguredModel(opts.channel)) {
    return keep(`${opts.channel} requests retain the configured model`)
  }

  let result
  try {
    result = await askSeat(
      TASK_EDGE_SEAT,
      taskEdgeState(opts),
      taskEdgeQuestionsFor(askImplied),
      {
        // The incumbent is "never move up, never ask for sub-agents", and
        // "every message asks for what it says".
        incumbent: { needsEdge: 0, subagentsHelp: 0, ...(askImplied ? { workAsked: "asked", designChange: 0 } : {}) },
        features: { agent: opts.agent, channel: opts.channel ?? "unknown" },
        timeoutMs: PRE_SPAWN_SEAT_TIMEOUT_MS,
      },
    )
  } catch {
    return keep("edge seat threw — keeping the agent's model", null, null, "failed")
  }
  if (!result) return keep("edge seat unavailable — keeping the agent's model", null, null, "failed")

  const answers = result.answers as Record<string, { noul?: unknown } | undefined>
  const pEdge = probability(answers.needsEdge?.noul)
  const pSub = probability(answers.subagentsHelp?.noul)
  const upgradeAt = opts.upgradeAt ?? UPGRADE_AT
  const subagentsAt = opts.subagentsAt ?? SUBAGENTS_AT
  if (askImplied) {
    pImplied = impliedWork(result.answers as Record<string, unknown>)
    pDesign = probability(answers.designChange?.noul)
  }
  // Implied work: the message describes a problem and asks for nothing.
  // A problem that needs a design change is edge work even though the
  // sentence itself reads as a remark.
  const implied = pImplied !== null && pImplied >= IMPLIED_AT
  const impliedHard = implied && pDesign !== null && pDesign >= DESIGN_AT
  const impliedActs = impliedMode === "active"
  const askedEdge = pEdge !== null && pEdge >= upgradeAt
  const wantsEdge = askedEdge || (impliedActs && impliedHard)
  const wantsNote = impliedActs && implied
  const wantsSubagents = opts.tier === "claude-code" && pSub !== null && pSub >= subagentsAt
  const shown = `edge ${show(pEdge)}, sub-agents ${show(pSub)}`
    + (askImplied ? `, implied ${show(pImplied)}, design ${show(pDesign)}` : "")
  const impliedShadow = impliedMode === "shadow" && implied
    ? ` — implied work (shadow): would state the job${impliedHard && !askedEdge ? " and move up" : ""}`
    : ""

  // Shadow records the answer and changes nothing.
  if (result.mode !== "active") {
    const would = wantsEdge || (implied && impliedHard)
    return keep(`shadow — would ${would ? "move up" : "keep the model"}${wantsSubagents ? " and ask for sub-agents" : ""}${implied ? " and state the implied job" : ""} (${shown})`, pEdge, pSub)
  }

  // `currentModel` is the agent's configured model. The job may have been
  // routed below it at the same time (routing.ts), so "already on the edge
  // model" still names the edge model: jobModelFor uses it to drop that
  // downgrade.
  const edgeModel = wantsEdge && opts.edgeModel ? opts.edgeModel : undefined
  const canUpgrade = Boolean(edgeModel) && edgeModel !== opts.currentModel
  if (!edgeModel && !wantsSubagents && !wantsNote) {
    const why = !wantsEdge
      ? "the agent's model is enough"
      : "needs the edge model, but none is configured"
    return keep(`${why} (${shown})${impliedShadow}`, pEdge, pSub, "answered")
  }

  return {
    seat: "answered",
    ...(edgeModel ? { model: edgeModel } : {}),
    upgraded: canUpgrade,
    subagents: wantsSubagents,
    needsEdge: pEdge,
    subagentsHelp: pSub,
    ...(askImplied ? { impliedWork: wantsNote, impliedP: pImplied, designChange: pDesign } : {}),
    reason: [
      canUpgrade ? `${askedEdge ? "hard task" : "implied hard task"} → ${edgeModel} for this job` : "",
      edgeModel && !canUpgrade ? `${askedEdge ? "hard task" : "implied hard task"}${alreadyOnEdge(edgeModel)}` : "",
      wantsSubagents ? "sub-agents advised" : "",
      wantsNote ? "implied work: the agent states the job" : "",
    ].filter(Boolean).join(", ") + ` (${shown})${impliedShadow}`,
  }
}

/**
 * The per-job model override, given the edge route and the downgrade that
 * task-tier routing picked (if any). A confident "needs the edge model"
 * wins over a downgrade: the two seats disagree only when one of them is
 * wrong, and the cheaper mistake is the stronger model.
 *
 * When the agent already runs on the edge model there is nothing to move
 * up to, and the answer is no override at all, so the job runs on the
 * agent's own model and a warm process is not respawned.
 */
export function jobModelFor(
  route: EdgeRouteResult | undefined,
  routedModel: string | undefined,
): string | undefined {
  if (!route?.model) return routedModel
  return route.upgraded ? route.model : undefined
}

/** The part of a route reason that says the agent's configured model is
 *  already the edge model. edgeRouteLog rewrites it when a downgrade was
 *  routed for the same job, so it is built in one place. */
function alreadyOnEdge(model: string): string {
  return `, already on the edge model (${model})`
}

/**
 * The line the registry logs for a route, once the downgrade is known.
 * The seat only sees the agent's configured model, so its reason says
 * "already on the edge model" even when task-tier routing had sent the
 * job down. When a confident answer drops that downgrade, the line says
 * the job runs on the edge model and names the downgrade it dropped
 * (#1864).
 */
export function edgeRouteLog(route: EdgeRouteResult, routedModel: string | undefined): string {
  const jobModel = jobModelFor(route, routedModel)
  const dropped = Boolean(routedModel) && jobModel !== routedModel
  if (!dropped || !route.model) return route.reason
  const reason = route.upgraded
    ? route.reason
    : route.reason.replace(alreadyOnEdge(route.model), ` → ${route.model} for this job (the agent's own model)`)
  return `${reason} — downgrade to ${routedModel} dropped`
}

export interface EdgePlan {
  /** Per-job model override, when the job moved up. */
  model?: string
  /** Model for the job's sub-agents, when the job moved up. */
  subagentModel?: string
  /** Lines added to the turn: the implied-request line, and the
   *  sub-agent line when sub-agents are advised and available. */
  turnNote?: string
}

/** What a route result changes on the task. A sub-agent hint is dropped
 *  when the session's tool list leaves the sub-agent tool out: the
 *  operator shortened that list on purpose. */
export function edgePlanFor(
  route: EdgeRouteResult | undefined,
  opts: { tier: string; claudeArgs?: readonly string[] },
): EdgePlan {
  if (!route) return {}
  const claude = opts.tier === "claude-code"
  const canUseSubagents = claude && subagentToolAvailable(opts.claudeArgs)
  const notes = [
    route.impliedWork ? IMPLIED_WORK_NOTE : "",
    route.subagents && canUseSubagents ? SUBAGENT_NOTE : "",
  ].filter(Boolean)
  return {
    ...(route.upgraded && route.model ? { model: route.model } : {}),
    ...(route.upgraded && route.model && canUseSubagents ? { subagentModel: route.model } : {}),
    ...(notes.length ? { turnNote: notes.join("\n") } : {}),
  }
}

function probability(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function show(p: number | null): string {
  return p === null ? "-" : p.toFixed(2)
}
