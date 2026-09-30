/**
 * Settle with `work`, or reject `graceMs` after `signal` aborts — whichever
 * comes first. A run step that ignores cancellation (a hung fetch, a lock
 * that never frees) must not hold the run's slot forever: the rejection
 * lets the run's own cleanup fire even though `work` never settles.
 *
 * With `graceMs` 0 an already-aborted signal rejects at once. A step that
 * owns a subprocess gets a grace so its own abort handling can reap the
 * child before the slot is handed to the next run.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal, graceMs = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      timer = setTimeout(() => reject(abortReason(signal)), graceMs)
    }
    const done = () => {
      signal.removeEventListener("abort", onAbort)
      if (timer) clearTimeout(timer)
    }
    work.then(
      (value) => { done(); resolve(value) },
      (error) => { done(); reject(error) },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === "string" ? reason : "task cancelled")
}

/** Thrown by `withBudget` when a pre-spawn step runs past its own limit.
 *  The step's caller decides what the run does without that step. */
export class StepBudgetExceeded extends Error {
  constructor(readonly step: string, readonly budgetMs: number) {
    super(`step "${step}" exceeded its ${Math.round(budgetMs / 1000)}s budget`)
    this.name = "StepBudgetExceeded"
  }
}

/**
 * Race `work` against a per-step limit. The run's pre-spawn deadline
 * (minutes) was the only bound on preparation steps, so a step whose own
 * timeout failed to fire, such as a request that never settled, held the
 * whole run until that deadline and the message was dropped. The work
 * keeps running in the background when it loses; nothing waits for it.
 */
export function withBudget<T>(work: Promise<T>, budgetMs: number, step: string): Promise<T> {
  if (!(budgetMs > 0)) return work
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepBudgetExceeded(step, budgetMs)), budgetMs)
    timer.unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
