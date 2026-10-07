import { currentStep, waitingOn } from "./follow-up"
import type { WorkflowRun } from "./types"

// --- The floating progress widget: what each followed run shows (#796) ---
//
// One row per follow-up run still going: its title, the step it is on, who
// that step is waiting for, and whether it waits on the owner. The
// dashboard widget (/workflows/widget) and the phone app's Activity tab
// both draw these rows, so the two views say the same thing.
//
// Pure functions: no I/O, so the dashboard, the phone routes and tests use
// them alike.

export type WidgetCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left"
export const WIDGET_CORNERS: readonly WidgetCorner[] = ["top-right", "top-left", "bottom-right", "bottom-left"]

export interface WidgetSettings {
  enabled: boolean
  /** Only runs carrying one of these tags; empty: every followed run. */
  tags: string[]
  /** Where the small window opens when the browser lets the page choose. */
  position: WidgetCorner
  width: number
  height: number
  /** How often the widget reads again when no live event arrives. */
  refreshSeconds: number
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  enabled: true,
  tags: [],
  position: "top-right",
  width: 360,
  height: 420,
  refreshSeconds: 10,
}

/**
 * waiting-on-you  a decision card from the run waits for the owner's answer
 * blocked         an agent step says it cannot go on without the owner
 * waiting         a person, a timer, a signal or an agent is still at it
 * running         a step is running now
 */
export type WidgetState = "waiting-on-you" | "blocked" | "waiting" | "running"

/** How the owner answers a row from the widget, when it waits on them. */
export type WidgetAnswer =
  /** `choices`: the card offers more than yes or no, so it is answered
   *  in the Approvals inbox (or the phone's Choose…), not with Yes/No. */
  | { kind: "card"; key: string; choices?: boolean }
  | { kind: "reply"; agentId: string }

export interface WidgetRow {
  runId: string
  workflowId: string
  /** The daemon the run lives on, so an answer goes to the right node. */
  node: string
  nodeName: string
  title: string
  step: string
  /** Who the step waits for: "you", an agent id, a person or "timer". */
  owner: string
  state: WidgetState
  waitingOn: string
  since: string
  tags: string[]
  answer: WidgetAnswer | null
}

export interface NodeRun {
  node: string
  nodeName: string
  run: WorkflowRun
}

export interface WidgetRowOptions {
  /** The workflow's own title, for a run that has none. */
  title?: (workflowId: string) => string | undefined
  /** The agent a step belongs to, when the workflow is known here. */
  stepAgent?: (workflowId: string, nodeId: string) => string | undefined
  /** Does this owner.ask step offer choices? Unknown (a peer's workflow): no. */
  hasChoices?: (workflowId: string, nodeId: string) => boolean
  /** Only runs with one of these tags; empty or unset: all. */
  tags?: string[]
}

const ORDER: Record<WidgetState, number> = { "waiting-on-you": 0, blocked: 1, waiting: 2, running: 3 }

/** Who a step waits for, what state that is, and how the owner answers. */
export function stepOwnership(run: WorkflowRun, opts: Pick<WidgetRowOptions, "stepAgent" | "hasChoices"> = {}): Pick<WidgetRow, "owner" | "state" | "answer"> {
  const p = run.pausedAt
  if (run.status === "running" || !p) {
    const step = currentStep(run)
    return { owner: opts.stepAgent?.(run.workflowId, step) ?? "AgentX", state: "running", answer: null }
  }
  switch (p.kind) {
    case "ownerDecision": {
      const choices = p.purpose === "ask" && !!opts.hasChoices?.(run.workflowId, p.nodeId)
      return { owner: "you", state: "waiting-on-you", answer: { kind: "card", key: `card:${p.cardId}`, ...(choices ? { choices } : {}) } }
    }
    case "agentStep":
      return p.blocked
        ? { owner: p.agentId, state: "blocked", answer: { kind: "reply", agentId: p.agentId } }
        : { owner: p.agentId, state: "waiting", answer: null }
    case "replyWait":
      return { owner: p.from ?? p.chatId, state: "waiting", answer: null }
    case "timerWait":
      return { owner: "timer", state: "waiting", answer: null }
    default:
      return { owner: "AgentX", state: "waiting", answer: null }
  }
}

/** The widget's rows: followed runs still going, the ones that wait on the
 *  owner first, then oldest first. A run seen on two nodes shows once. */
export function widgetRows(runs: NodeRun[], opts: WidgetRowOptions = {}): WidgetRow[] {
  const want = (opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  const seen = new Set<string>()
  const rows: WidgetRow[] = []
  for (const { node, nodeName, run } of runs) {
    if (seen.has(run.id)) continue
    if (!run.meta?.followUp || run.parentRunId || (run.status !== "running" && run.status !== "paused")) continue
    const tags = run.meta.tags ?? []
    if (want.length && !tags.some((t) => want.includes(t))) continue
    seen.add(run.id)
    rows.push({
      runId: run.id,
      workflowId: run.workflowId,
      node,
      nodeName,
      title: run.meta.title ?? opts.title?.(run.workflowId) ?? run.workflowId,
      step: currentStep(run),
      ...stepOwnership(run, opts),
      waitingOn: waitingOn(run),
      since: run.updatedAt,
      tags,
    })
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.since.localeCompare(b.since))
}

/** The note a blocked agent step gets when the owner answers it. */
export function ownerReplyText(run: Pick<WorkflowRun, "id" | "meta">, nodeId: string, reply: string): string {
  const name = run.meta?.title ? `"${run.meta.title}"` : `run ${run.id}`
  return [
    `[Workflow ${name}, step "${nodeId}"] The owner answered your blocked step:`,
    reply,
    `Carry on with the step. When it is finished, report it with agentx_workflow {action:"done", runId:"${run.id}", step:"${nodeId}", evidence:"<what shows it>"}; if you still cannot go on, use action "blocked" with the reason.`,
  ].join("\n")
}

/** Where a small window opens for a corner, inside the screen's usable
 *  area, 16px from its edges. Shipped to the page with injectFns: no
 *  imports, no closures. */
export function widgetPlacement(position: string, width: number, height: number, screen: { availLeft?: number; availTop?: number; availWidth: number; availHeight: number }): { left: number; top: number } {
  const gap = 16
  const x0 = screen.availLeft || 0
  const y0 = screen.availTop || 0
  const right = position === "top-right" || position === "bottom-right"
  const bottom = position === "bottom-left" || position === "bottom-right"
  return {
    left: Math.max(x0, Math.round(right ? x0 + screen.availWidth - width - gap : x0 + gap)),
    top: Math.max(y0, Math.round(bottom ? y0 + screen.availHeight - height - gap : y0 + gap)),
  }
}

/** The words a row's state shows as. Shipped to the page with injectFns. */
export function widgetStateLabel(state: string): string {
  return state === "waiting-on-you" ? "Needs you" : state === "blocked" ? "Blocked" : state === "running" ? "Running" : "Waiting"
}
