import { readFocus, focusLabel, flushHeld, NotificationQueue, type Sender } from "@/notify"

// Delivering what Focus held, the moment Focus ends.
//
// Without this the queue is a hole rather than a delay: `agentx notify`
// puts a message aside during Focus and nothing ever takes it out again.
// Holding a notification is only defensible if something is watching for
// the moment it becomes welcome.
//
// Polling, not a subscription. macOS publishes Focus changes to processes
// that adopt the private DoNotDisturb framework, which a daemon like this
// cannot do from outside a signed app bundle; the state lives in a JSON
// file instead. A poll of a small local file every thirty seconds costs
// nothing measurable, and thirty seconds is well inside the time it takes
// a person to notice they have come back.
//
// Only the TRANSITION fires, never the steady state. Flushing on every
// tick while Focus happens to be off would re-deliver anything that
// arrived in the meantime, and a notification that repeats until dismissed
// is worse than one that never came.

const POLL_MS = 30_000

export function attachFocusWatcher(
  send: Sender,
  log: (msg: string) => void,
  opts: { pollMs?: number; queue?: NotificationQueue } = {},
): () => void {
  const queue = opts.queue ?? new NotificationQueue()
  // Seed from the CURRENT state rather than assuming Focus is off. Starting
  // the daemon while Focus is on would otherwise look like a transition the
  // moment it is switched off — which is right — but starting while Focus
  // is off must not look like one immediately.
  let wasActive = readFocus().active

  const timer = setInterval(() => {
    let state
    try {
      state = readFocus()
    } catch {
      return // reading it is best-effort; never take the daemon down for this
    }

    if (state.active) {
      if (!wasActive) log(`[notify] Focus began (${focusLabel(state)}) — holding notifications`)
      wasActive = true
      return
    }

    if (!wasActive) return
    wasActive = false

    void flushHeld(send, { queue })
      .then((n) => {
        if (n > 0) log(`[notify] Focus ended — delivered ${n} held notification(s)`)
      })
      .catch((e: any) => {
        // The queue survives a failed send — flushHeld clears only after
        // delivery — so the next transition tries again.
        log(`[notify] failed to deliver held notifications: ${e?.message ?? e}`)
      })
  }, opts.pollMs ?? POLL_MS)

  // Node keeps the process alive for pending timers; this one should not
  // be the reason a daemon refuses to exit.
  timer.unref?.()
  return () => clearInterval(timer)
}
