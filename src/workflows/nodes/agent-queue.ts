import type { NodeContext, NodeResult } from "./types"

// --- An agent step waiting for room on the node (#2334) ---
//
// A workflow agent step goes through the node's admission queue like any
// run. On 11-26 a WhatsApp answer step waited there 35+ minutes behind
// normal work, held by low disk, past its 15-minute timeout (which only
// counted once the turn started), and nobody was told. Three settings on
// the `agent` node fix that:
//
//   priority: "critical"      a person waits on it: ahead of normal work,
//                             past swap and load holds (low disk, low
//                             memory and the session cap still hold it).
//   queueTimeoutMinutes: n    how long it may wait to start; default its
//                             timeoutMinutes. Past it the step fails with
//                             kind queue_timeout.
//   heldNoticeMinutes: n      after n minutes held by the node (default 10,
//                             0 = never), the run logs it and the
//                             workflow's ownerAgent gets one notice.
//   onError: "continue"       a failed turn does not fail the run: the step
//                             outputs { reply: "", error, errorKind } and
//                             its next step routes it (e.g. a branch whose
//                             default goes to the failure report).

export const DEFAULT_HELD_NOTICE_MINUTES = 10

export interface StepQueueConfig {
  priority?: "critical"
  /** Undefined: no limit of the step's own. */
  queueLimitMs?: number
  /** 0: never. */
  heldNoticeMs: number
  onError?: "continue"
}

const minutes = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** Reads the node's queue settings. An unknown value is an error, so a
 *  typo never runs the step at a priority or with a limit nobody asked for. */
export function queueConfigOf(cfg: Record<string, unknown>, timeoutMinutes: number | undefined): StepQueueConfig | { error: string } {
  if (cfg.priority !== undefined && cfg.priority !== null && cfg.priority !== "critical") {
    return { error: `has invalid priority "${String(cfg.priority)}" (only "critical"; leave it out for normal)` }
  }
  if (cfg.onError !== undefined && cfg.onError !== null && cfg.onError !== "continue" && cfg.onError !== "fail") {
    return { error: `has invalid onError "${String(cfg.onError)}" (expected continue or fail)` }
  }
  const queueMin = cfg.queueTimeoutMinutes === undefined ? timeoutMinutes : minutes(cfg.queueTimeoutMinutes)
  if (cfg.queueTimeoutMinutes !== undefined && (queueMin === undefined || queueMin <= 0)) {
    return { error: `has invalid queueTimeoutMinutes "${String(cfg.queueTimeoutMinutes)}" (a number of minutes above 0)` }
  }
  const noticeMin = cfg.heldNoticeMinutes === undefined ? DEFAULT_HELD_NOTICE_MINUTES : minutes(cfg.heldNoticeMinutes)
  if (noticeMin === undefined || noticeMin < 0) {
    return { error: `has invalid heldNoticeMinutes "${String(cfg.heldNoticeMinutes)}" (a number of minutes, 0 = never)` }
  }
  return {
    ...(cfg.priority === "critical" ? { priority: "critical" as const } : {}),
    ...(queueMin !== undefined && queueMin > 0 ? { queueLimitMs: queueMin * 60_000 } : {}),
    heldNoticeMs: noticeMin * 60_000,
    ...(cfg.onError === "continue" ? { onError: "continue" as const } : {}),
  }
}

/** The step's queue clock: aborts its signal when the step has not started
 *  within the limit. `stop()` once the turn starts (or the step ends). */
export class StepWait {
  readonly signal?: AbortSignal
  timedOut = false
  started = false
  private readonly ac?: AbortController
  private timer: ReturnType<typeof setTimeout> | null = null
  private onTimeout: Array<() => void> = []

  constructor(limitMs: number | undefined) {
    if (limitMs === undefined) return
    this.ac = new AbortController()
    this.signal = this.ac.signal
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.started) return
      this.timedOut = true
      this.ac!.abort(new Error("the step's queue time ran out"))
      for (const f of this.onTimeout) f()
    }, limitMs)
  }

  /** The turn started (or the step is over): the clock no longer runs. */
  stop(): void {
    this.started = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Waits for `p` unless the clock runs out first: true when `p` won. */
  race(p: Promise<void>): Promise<boolean> {
    if (this.timedOut) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let done = false
      this.onTimeout.push(() => { if (!done) { done = true; resolve(false) } })
      void p.then(() => {
        if (done) return
        done = true
        resolve(true)
      })
    })
  }
}

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000))

export function heldText(nodeId: string, agentId: string, waitedMs: number, w: { blockedBy: string[]; position?: number; of?: number }): string {
  const where = w.position ? `, queue position ${w.position} of ${w.of ?? "?"}` : ""
  return `Workflow step "${nodeId}" (agent ${agentId}) has waited ${mins(waitedMs)} min to start, held by: ${w.blockedBy.join("; ") || "no room on the node"}${where}.`
}

export function queueTimeoutText(nodeId: string, waitedMs: number, limitMs: number | undefined, blockedBy: string[]): string {
  const limit = limitMs !== undefined ? ` (limit ${mins(limitMs)} min)` : ""
  return `step "${nodeId}" did not start: waited ${mins(waitedMs)} min in the queue${limit}, held by: ${blockedBy.join("; ") || "no room on the node"}`
}

/** A failed turn: the run fails, or with onError "continue" the step ends
 *  with the error in its output so the next step can route it. */
export function failOrContinue(ctx: NodeContext, agentId: string, onError: "continue" | undefined, kind: string, error: string): NodeResult {
  if (kind === "queue_timeout") ctx.log(`[node:${ctx.node.id}] agent "${agentId}" ${error}`)
  if (onError === "continue") {
    ctx.log(`[node:${ctx.node.id}] continuing after the failed turn (onError: continue)`)
    return { output: { reply: "", error: `[${kind}] ${error}`, errorKind: kind } }
  }
  return { error: `[${kind}] ${error}` }
}
