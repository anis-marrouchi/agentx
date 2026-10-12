import type { TraceRecord } from "@/storage/traces"
import { TokenTracker, CACHE_AWARE_PRICING } from "@/daemon/token-tracker"
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

/** Result token a pilot step returns to hand the case back. */
export const HAND_BACK_RESULT = "fallback"

export type Pricing = typeof CACHE_AWARE_PRICING

/** One trace row priced. */
export function traceCostUsd(t: TraceRecord, pricing: Pricing = CACHE_AWARE_PRICING): number {
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
  }, t.model ?? undefined, pricing)
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
  traceIds: string[]
}

function runCost(run: WorkflowRun, traces: TraceRecord[], pricing: Pricing): RunCost {
  const mine = traces.filter((t) => t.workflowRunId === run.id && isModelCall(t))
  const cost = mine.reduce((s, t) => s + traceCostUsd(t, pricing), 0)
  return {
    runId: run.id,
    workflowId: run.workflowId,
    startedAt: run.createdAt,
    status: run.status,
    costUsd: round(cost),
    calls: mine.length,
    failedCalls: mine.filter((t) => t.status === "error" || t.status === "canceled").length,
    traceIds: mine.map((t) => t.taskId),
  }
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
}): PilotComparison {
  const pricing = args.pricing ?? CACHE_AWARE_PRICING
  const liveRuns = args.runs
    .filter((r) => r.workflowId === args.liveWorkflow)
    .map((r) => runCost(r, args.traces, pricing))
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

  const pairs: PilotPair[] = liveRuns.map((live) => {
    const run = pilotByLive.get(live.runId)
    if (!run) return { live, pilot: null, handedBack: null, pilotPathCostUsd: null }
    const pilot = runCost(run, args.traces, pricing)
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
    unpairedLive: liveRuns.length - paired.length,
    orphanPilot: orphan,
    pairs,
  }
}
