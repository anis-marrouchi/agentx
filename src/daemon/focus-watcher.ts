import { readHold, focusLabel, flushHeld, NotificationQueue, type FocusState, type LocalAlert, type Sender } from "@/notify"

// Delivering what Focus held, the moment Focus ends. A call holds the
// same way (#394): the hold is Focus or a call, and it ends when neither is on.
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
// Flush whenever the hold is off and something is waiting — not only on a
// transition this watcher saw itself (#1668). A call hold can open and close
// between two polls: the widget's busy flag turns on and off with each Talk
// turn, and `agentx notify` reads the hold file directly, so it holds a
// message the watcher never saw the hold for. Waiting for a seen
// active→free edge left that message queued until some unrelated later
// hold ended.
//
// This does not deliver anything twice: flushHeld clears exactly what it
// sent, after it sent it, so once the queue is empty a tick does nothing.
// One flush at a time, so a slow send is not overlapped by the next tick.

const POLL_MS = 30_000

export function attachFocusWatcher(
  send: Sender,
  log: (msg: string) => void,
  opts: {
    pollMs?: number
    queue?: NotificationQueue
    alert?: LocalAlert | false
    /** The hold to read. Defaults to Focus or a call. */
    hold?: () => FocusState
  } = {},
): () => void {
  const queue = opts.queue ?? new NotificationQueue()
  const hold = opts.hold ?? readHold
  // Seeded from the current state, so the "began" line is logged only for
  // a hold that starts while the daemon runs.
  let wasActive = safeRead(hold)?.active ?? false
  let flushing = false
  // The last failure logged, so a channel that stays down is reported once,
  // not every thirty seconds.
  let lastError: string | null = null

  const timer = setInterval(() => {
    const state = safeRead(hold)
    if (!state) return // reading it is best-effort; never take the daemon down for this

    if (state.active) {
      if (!wasActive) log(`[notify] Focus began (${focusLabel(state)}) — holding notifications`)
      wasActive = true
      return
    }

    const ended = wasActive
    wasActive = false
    if (flushing) return
    let waiting = 0
    try { waiting = queue.list().length } catch { return }
    if (waiting === 0) return

    flushing = true
    void flushHeld(send, { queue, alert: opts.alert })
      .then((n) => {
        lastError = null
        if (n > 0) log(`[notify] ${ended ? "Focus ended" : "Not held"} — delivered ${n} held notification(s)`)
      })
      .catch((e: any) => {
        // The queue survives a failed send — flushHeld clears only after
        // delivery — so the next tick tries again.
        const msg = String(e?.message ?? e)
        if (msg !== lastError) log(`[notify] failed to deliver held notifications: ${msg}`)
        lastError = msg
      })
      .finally(() => { flushing = false })
  }, opts.pollMs ?? POLL_MS)

  // Node keeps the process alive for pending timers; this one should not
  // be the reason a daemon refuses to exit.
  timer.unref?.()
  return () => clearInterval(timer)
}

function safeRead(hold: () => FocusState): FocusState | null {
  try { return hold() } catch { return null }
}
