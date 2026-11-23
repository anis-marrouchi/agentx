// --- Which cold runs go first when the Claude plan fills up (#2161) ---
//
// Every cold claude-code run gets a class. Past a class's threshold on the
// plan's 5-hour or weekly window, its cold runs are held; open
// conversations (warm sessions) always pass, and a person writing is never
// held here. Highest first:
//
//   person      a person writing: chat apps, the phone app, the dashboard,
//               a mention a person posted on GitHub/GitLab
//   work        workflow steps, and hand-offs in a chain a person started
//   agent       agent-to-agent wakes and hand-offs in a chain an agent started
//   background  cron jobs, reminders, heartbeats, sensors
//
// Person-vs-agent comes from a2a/initiator.ts, the one place that answers
// it; this module only adds the work/background split.

import { classifyInitiator, isHumanFacingTurn, isInsideDelegation, propagatedRootOf, type InitiatorContext } from "@/a2a/initiator"
import { isPersonChannel } from "./work-lane"

export type RunPriority = "person" | "work" | "agent" | "background"

export const RUN_PRIORITIES: readonly RunPriority[] = ["person", "work", "agent", "background"]

/** Channels whose runs nobody waits on: scheduled and sensed work. */
const BACKGROUND_CHANNELS = new Set(["cron", "reminder", "heartbeat", "sensor", "bench", "selftest"])

export interface PrioritySource {
  context?: InitiatorContext
  workflowRunId?: string
}

export function priorityOfTask(task: PrioritySource): RunPriority {
  const ctx = task.context
  if (!isInsideDelegation(ctx) && (isHumanFacingTurn(ctx) || isPersonChannel(ctx?.channel))) return "person"
  // A callback turn carries its chain's root on the delegation it answers.
  const root = propagatedRootOf(ctx) ?? propagatedRootOf({ initiator: (ctx?.delegation as { root?: unknown } | undefined)?.root })
  const rootChannel = String(root?.channel ?? ctx?.channel ?? "").toLowerCase()
  if (BACKGROUND_CHANNELS.has(rootChannel)) return "background"
  if (task.workflowRunId || rootChannel === "workflow") return "work"
  return (root?.kind ?? classifyInitiator(ctx)) === "human" ? "work" : "agent"
}

// --- Thresholds ---

/** Percent of a window (0-100) past which a class is held. */
export interface WindowThresholds { fiveHour?: number; weekly?: number }

export interface PlanPriorityConfig {
  enabled: boolean
  work: WindowThresholds
  agent: WindowThresholds
  background: WindowThresholds
}

export const DEFAULT_PLAN_PRIORITY: PlanPriorityConfig = {
  enabled: true,
  work: { fiveHour: 95, weekly: 95 },
  agent: { fiveHour: 85, weekly: 85 },
  background: { fiveHour: 80, weekly: 70 },
}

let current: PlanPriorityConfig = DEFAULT_PLAN_PRIORITY

export function setPlanPriority(next: Partial<PlanPriorityConfig> | undefined): void {
  current = {
    enabled: next?.enabled ?? DEFAULT_PLAN_PRIORITY.enabled,
    work: { ...DEFAULT_PLAN_PRIORITY.work, ...next?.work },
    agent: { ...DEFAULT_PLAN_PRIORITY.agent, ...next?.agent },
    background: { ...DEFAULT_PLAN_PRIORITY.background, ...next?.background },
  }
}

export function getPlanPriority(): PlanPriorityConfig {
  return { ...current, work: { ...current.work }, agent: { ...current.agent }, background: { ...current.background } }
}

export interface WindowUse { window: string; utilization: number; resetsAt?: number }

export interface PriorityHold {
  priority: RunPriority
  window: string
  usedPercent: number
  thresholdPercent: number
  resetsAt?: number
}

/** A model's weekly window ("seven_day_fable") only concerns runs on that model. */
function concernsModel(window: string, model: string | undefined): boolean {
  const family = /^seven_day_([a-z]+)$/.exec(window)?.[1]
  return !family || !model || model.toLowerCase().includes(family)
}

/** The window that holds a cold run of `priority`, or null when it may go. */
export function planPriorityHold(
  priority: RunPriority,
  windows: WindowUse[],
  model?: string,
  cfg: PlanPriorityConfig = current,
): PriorityHold | null {
  if (!cfg.enabled || priority === "person") return null
  const t = cfg[priority]
  let worst: PriorityHold | null = null
  for (const w of windows) {
    if (!concernsModel(w.window, model)) continue
    const threshold = w.window === "five_hour" ? t.fiveHour : w.window.startsWith("seven_day") ? t.weekly : undefined
    if (threshold === undefined) continue
    const used = Math.round(w.utilization * 100)
    if (used < threshold) continue
    if (!worst || used - threshold > worst.usedPercent - worst.thresholdPercent) {
      worst = { priority, window: w.window, usedPercent: used, thresholdPercent: threshold, ...(w.resetsAt && { resetsAt: w.resetsAt }) }
    }
  }
  return worst
}
