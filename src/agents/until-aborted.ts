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
