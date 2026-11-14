import { askSeat, getSeatMode } from "@/decisions/seat"
import { PRE_SPAWN_SEAT_TIMEOUT_MS } from "@/decisions/limits"
import {
  TASK_EDGE_SEAT,
  taskEdgeQuestions,
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
// The edge model is set on the task, not on the agent, so there is no
// "switch back" step to forget: the next job is built from the agent's
// own model again. A warm process is respawned when the model differs
// (process-registry.ts staleHandleReason), in both directions.
//
// Follow-ups are not excluded, unlike the downgrade in routing.ts. The
// prompt cache is per model, so the edge model reads the session once at
// the uncached price. That is the cost of a job the seat is sure about,
// and the downgrade's arithmetic (save money or do nothing) does not
// apply to a move made for quality.
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
  /** The edge model for this job, or undefined to leave the model alone. */
  model?: string
  /** True when this call moved the job up. */
  upgraded: boolean
  /** True when the turn should ask for sub-agents. */
  subagents: boolean
  /** P(needs the edge model), or null when nothing was asked. */
  needsEdge: number | null
  /** P(sub-agents help), or null when nothing was asked. */
  subagentsHelp: number | null
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
}

/**
 * Decide whether this job moves to the edge model and whether it should
 * use sub-agents. Never throws: this decision must not be able to stop a
 * task from running.
 */
export async function routeTaskEdge(opts: EdgeRouteOptions): Promise<EdgeRouteResult> {
  const keep = (reason: string, pEdge: number | null = null, pSub: number | null = null): EdgeRouteResult => ({
    upgraded: false, subagents: false, needsEdge: pEdge, subagentsHelp: pSub, reason,
  })

  if (channelKeepsConfiguredModel(opts.channel)) {
    return keep(`${opts.channel} requests retain the configured model`)
  }

  let result
  try {
    result = await askSeat(
      TASK_EDGE_SEAT,
      taskEdgeState(opts),
      taskEdgeQuestions,
      {
        // The incumbent is "never move up, never ask for sub-agents".
        incumbent: { needsEdge: 0, subagentsHelp: 0 },
        features: { agent: opts.agent, channel: opts.channel ?? "unknown" },
        timeoutMs: PRE_SPAWN_SEAT_TIMEOUT_MS,
      },
    )
  } catch {
    return keep("edge seat threw — keeping the agent's model")
  }
  if (!result) return keep("edge seat unavailable — keeping the agent's model")

  const answers = result.answers as Record<string, { noul?: unknown } | undefined>
  const pEdge = probability(answers.needsEdge?.noul)
  const pSub = probability(answers.subagentsHelp?.noul)
  const upgradeAt = opts.upgradeAt ?? UPGRADE_AT
  const subagentsAt = opts.subagentsAt ?? SUBAGENTS_AT
  const wantsEdge = pEdge !== null && pEdge >= upgradeAt
  const wantsSubagents = opts.tier === "claude-code" && pSub !== null && pSub >= subagentsAt
  const shown = `edge ${show(pEdge)}, sub-agents ${show(pSub)}`

  // Shadow records the answer and changes nothing.
  if (result.mode !== "active") {
    return keep(`shadow — would ${wantsEdge ? "move up" : "keep the model"}${wantsSubagents ? " and ask for sub-agents" : ""} (${shown})`, pEdge, pSub)
  }

  const canUpgrade = wantsEdge && Boolean(opts.edgeModel) && opts.edgeModel !== opts.currentModel
  if (!canUpgrade && !wantsSubagents) {
    const why = !wantsEdge
      ? "the agent's model is enough"
      : !opts.edgeModel
        ? "needs the edge model, but none is configured"
        : "already on the edge model"
    return keep(`${why} (${shown})`, pEdge, pSub)
  }

  return {
    ...(canUpgrade ? { model: opts.edgeModel! } : {}),
    upgraded: canUpgrade,
    subagents: wantsSubagents,
    needsEdge: pEdge,
    subagentsHelp: pSub,
    reason: [
      canUpgrade ? `hard task → ${opts.edgeModel} for this job` : "",
      wantsSubagents ? "sub-agents advised" : "",
    ].filter(Boolean).join(", ") + ` (${shown})`,
  }
}

export interface EdgePlan {
  /** Per-job model override, when the job moved up. */
  model?: string
  /** Model for the job's sub-agents, when the job moved up. */
  subagentModel?: string
  /** Line added to the turn, when sub-agents are advised and available. */
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
  return {
    ...(route.upgraded && route.model ? { model: route.model } : {}),
    ...(route.upgraded && route.model && canUseSubagents ? { subagentModel: route.model } : {}),
    ...(route.subagents && canUseSubagents ? { turnNote: SUBAGENT_NOTE } : {}),
  }
}

function probability(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function show(p: number | null): string {
  return p === null ? "-" : p.toFixed(2)
}
