import type { TraceRecord } from "@/storage/traces"
import { TokenTracker, CACHE_AWARE_PRICING, getModelFamily } from "@/daemon/token-tracker"
import type { WorkflowRun } from "@/workflows/types"

// --- Workflow pilot report (#928) ---
//
// Read-only. Compares a live workflow's agent work with a pilot workflow
// that ran beside it, in dry-run, on the same input. Cost is the trace
// table's tokens priced with the token tracker's table (long-context
// requests at 1.5x), so both sides are priced by the same meter. A pilot
// run that hands the case back to the full agent costs its own tokens plus
// the live run's: that is what the job would pay if the pilot went live.
//
// Pairing: a pilot run belongs to the live run that started it, read from
// its `parentRunId` (a subProcess step) or from a `liveRunId` input on its
// trigger. Code steps make no trace rows and so count as zero.
//
// Model: each row is priced at its own model, read from the trace row, else
// from the agent's configured model. Older rows carry no model, an agent
// may have none configured, and a model may be one the price table does not
// know (getModelFamily maps any unknown name to Sonnet); such rows are priced
// at the fallback rate and counted, so the report says how much rests on a guess.

/** Result token a pilot step returns to hand the case back. */
export const HAND_BACK_RESULT = "fallback"

export type Pricing = typeof CACHE_AWARE_PRICING

/** Model a row with no known model is priced at (TokenTracker's default). */
export const FALLBACK_PRICING_MODEL = "claude-sonnet"

/** Configured model per agent id, for rows that do not carry one. */
export type AgentModels = Record<string, string | undefined>

/** The model a trace row ran on: the row's own, else its agent's
 *  configured model. Null when neither is known. */
export function traceModel(t: Pick<TraceRecord, "model" | "agentId">, agentModels: AgentModels = {}): string | null {
  return t.model || agentModels[t.agentId] || null
}

/** Whether the price table has a rate for `model`. getModelFamily maps
 *  any name it does not recognise to Sonnet, so only a Claude family name
 *  counts as known. */
export function isPricedModel(model: string, pricing: Pricing = CACHE_AWARE_PRICING): boolean {
  return /fable|mythos|opus|sonnet|haiku/i.test(model) && getModelFamily(model) in pricing
}

/** One trace row priced at `model`, or at the fallback rate without one. */
export function traceCostUsd(t: TraceRecord, pricing: Pricing = CACHE_AWARE_PRICING, model: string | null = t.model): number {
  return TokenTracker.calculateCost({
    inputTokens: t.inputTokens ?? 0,
    outputTokens: t.outputTokens ?? 0,
    cacheReadTokens: t.cacheReadTokens ?? 0,
    cacheCreateTokens: t.cacheCreateTokens ?? 0,
    tier2InputTokens: t.tier2InputTokens ?? 0,
    tier2OutputTokens: t.tier2OutputTokens ?? 0,
    tier2CacheReadTokens: t.tier2CacheReadTokens ?? 0,
    tier2CacheCreateTokens: t.tier2CacheCreateTokens ?? 0,
    tasks: 1, totalDuration: 0, errors: 0,
  }, model ?? FALLBACK_PRICING_MODEL, pricing)
}

/** A model call: an agent turn. The engine's own rows for code steps
 *  (agent id `workflow:<type>`) carry no tokens. */
export function isModelCall(t: Pick<TraceRecord, "agentId">): boolean {
  return !t.agentId.startsWith("workflow:")
}

export interface RunCost {
  runId: string
  workflowId: string
  startedAt: string
  status: string
  costUsd: number
  /** Model calls in the run. */
  calls: number
  /** Model calls that failed or were cancelled. */
  failedCalls: number
  /** Model calls with no known model, or a model the price table does
   *  not know, priced at the fallback rate. */
  fallbackPricedCalls: number
  /** Models seen on this run that the price table does not know. */
  unpricedModels: string[]
  traceIds: string[]
}

function runCost(run: WorkflowRun, traces: TraceRecord[], pricing: Pricing, agentModels: AgentModels): RunCost {
  const mine = traces.filter((t) => t.workflowRunId === run.id && isModelCall(t))
  const models = mine.map((t) => traceModel(t, agentModels))
  const cost = mine.reduce((s, t, i) => s + traceCostUsd(t, pricing, models[i]), 0)
  return {
    runId: run.id,
    workflowId: run.workflowId,
    startedAt: run.createdAt,
    status: run.status,
    costUsd: round(cost),
    calls: mine.length,
    failedCalls: mine.filter((t) => t.status === "error" || t.status === "canceled").length,
    fallbackPricedCalls: models.filter((m) => !m || !isPricedModel(m, pricing)).length,
    unpricedModels: [...new Set(models.filter((m): m is string => !!m && !isPricedModel(m, pricing)))],
    traceIds: mine.map((t) => t.taskId),
  }
}

/** Whether a run has ended. A run that ran out of steps without an end
 *  step stays "running" with nothing pending. */
export function runEnded(run: Pick<WorkflowRun, "status" | "pending">): boolean {
  return run.status !== "paused" && (run.status !== "running" || run.pending.length === 0)
}

/** Why a pilot run handed its case back, or null when it answered. */
export function handBackReason(run: Pick<WorkflowRun, "status" | "history" | "pending">): string | null {
  for (let i = run.history.length - 1; i >= 0; i--) {
    const r = run.history[i].output?.result
    if (typeof r === "string" && r.trim().toLowerCase() === HAND_BACK_RESULT) return `step "${run.history[i].nodeId}" handed back`
  }
  if (run.status === "completed") return null
  // A run that ran out of steps without an end step stays "running".
  if (run.status === "running" && run.pending.length === 0) return null
  return `run ${run.status}`
}

/** The live run a pilot run belongs to. */
export function liveRunIdOf(run: Pick<WorkflowRun, "parentRunId" | "context">): string | null {
  if (run.parentRunId) return run.parentRunId
  for (const out of Object.values(run.context ?? {})) {
    const v = (out as Record<string, unknown>)?.liveRunId
    if (typeof v === "string" && v) return v
  }
  return null
}

export interface SideSummary {
  runs: number
  failed: number
  totalCostUsd: number
  costPerRunUsd: number | null
  medianCostUsd: number | null
}

export interface PilotPair {
  live: RunCost
  pilot: RunCost | null
  handedBack: string | null
  /** What the job would pay on the pilot path: pilot cost, plus the live
   *  cost when the pilot handed the case back. */
  pilotPathCostUsd: number | null
}

export interface PilotComparison {
  liveWorkflow: string
  pilotWorkflow: string
  /** Live runs that reached a model (runs that ended at a code step cost
   *  nothing on either path and are left out). */
  live: SideSummary
  /** Paired runs only, so both sides cover the same cases. */
  paired: {
    runs: number
    handedBack: number
    handBackShare: number
    live: SideSummary
    pilotPath: SideSummary
    /** 1 - pilot path / live, over the paired runs. Null with no pairs. */
    saving: number | null
  }
  /** Live runs with no pilot run, and pilot runs with no live run. */
  unpairedLive: number
  orphanPilot: number
  /** Paired live runs whose pilot run has not ended yet: left out until
   *  it does, so a run in progress is not read as a hand-back. */
  pilotInProgress: number
  /** Model calls priced at the fallback rate because no model was known
   *  or the price table has no rate for it, out of all model calls counted,
   *  per side. `unpricedModels` names the models with no rate. */
  fallbackPriced: { live: number; pilot: number; calls: number; unpricedModels: string[] }
  pairs: PilotPair[]
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function summarise(costs: number[], failed: number): SideSummary {
  const sorted = [...costs].sort((a, b) => a - b)
  const total = round(costs.reduce((s, c) => s + c, 0))
  const mid = sorted.length >> 1
  return {
    runs: costs.length,
    failed,
    totalCostUsd: total,
    costPerRunUsd: costs.length ? round(total / costs.length) : null,
    medianCostUsd: !sorted.length ? null : round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
  }
}

const failedRun = (c: RunCost) => c.status === "failed" || c.status === "canceled" || c.failedCalls > 0

export function comparePilot(args: {
  liveWorkflow: string
  pilotWorkflow: string
  runs: WorkflowRun[]
  traces: TraceRecord[]
  pricing?: Pricing
  agentModels?: AgentModels
}): PilotComparison {
  const pricing = args.pricing ?? CACHE_AWARE_PRICING
  const agentModels = args.agentModels ?? {}
  const liveRuns = args.runs
    .filter((r) => r.workflowId === args.liveWorkflow)
    .map((r) => runCost(r, args.traces, pricing, agentModels))
    .filter((c) => c.calls > 0)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const pilotRuns = args.runs.filter((r) => r.workflowId === args.pilotWorkflow)
  const pilotByLive = new Map<string, WorkflowRun>()
  let orphan = 0
  for (const p of pilotRuns) {
    const live = liveRunIdOf(p)
    if (!live || !liveRuns.some((l) => l.runId === live)) { orphan++; continue }
    // The first pilot run for a live run counts; a re-run does not.
    const prev = pilotByLive.get(live)
    if (!prev || p.createdAt < prev.createdAt) pilotByLive.set(live, p)
  }

  let inProgress = 0
  const pairs: PilotPair[] = liveRuns.map((live) => {
    const run = pilotByLive.get(live.runId)
    if (run && !runEnded(run)) inProgress++
    if (!run || !runEnded(run)) return { live, pilot: null, handedBack: null, pilotPathCostUsd: null }
    const pilot = runCost(run, args.traces, pricing, agentModels)
    const handedBack = handBackReason(run)
    return { live, pilot, handedBack, pilotPathCostUsd: round(pilot.costUsd + (handedBack ? live.costUsd : 0)) }
  })
  const paired = pairs.filter((p) => p.pilot)
  const pairedLive = summarise(paired.map((p) => p.live.costUsd), paired.filter((p) => failedRun(p.live)).length)
  // A hand-back is not an error: it is counted in the share and the cost.
  const pilotPath = summarise(paired.map((p) => p.pilotPathCostUsd as number), paired.filter((p) => !p.handedBack && failedRun(p.pilot!)).length)
  const handedBack = paired.filter((p) => p.handedBack).length
  return {
    liveWorkflow: args.liveWorkflow,
    pilotWorkflow: args.pilotWorkflow,
    live: summarise(liveRuns.map((c) => c.costUsd), liveRuns.filter(failedRun).length),
    paired: {
      runs: paired.length,
      handedBack,
      handBackShare: paired.length ? handedBack / paired.length : 0,
      live: pairedLive,
      pilotPath,
      saving: paired.length && pairedLive.totalCostUsd > 0 ? round(1 - pilotPath.totalCostUsd / pairedLive.totalCostUsd) : null,
    },
    unpairedLive: liveRuns.length - paired.length - inProgress,
    orphanPilot: orphan,
    pilotInProgress: inProgress,
    fallbackPriced: {
      live: liveRuns.reduce((s, c) => s + c.fallbackPricedCalls, 0),
      pilot: paired.reduce((s, p) => s + p.pilot!.fallbackPricedCalls, 0),
      calls: liveRuns.reduce((s, c) => s + c.calls, 0) + paired.reduce((s, p) => s + p.pilot!.calls, 0),
      unpricedModels: [...new Set([...liveRuns, ...paired.map((p) => p.pilot!)].flatMap((c) => c.unpricedModels))].sort(),
    },
    pairs,
  }
}
