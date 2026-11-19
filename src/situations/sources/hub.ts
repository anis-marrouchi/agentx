import type { Signal } from "./types"

// --- The node's signal hub (#1892 phase 3) ---
//
// Push sources (a channel's "someone left", a call that ended) publish
// here, from the event they already handle: no poll loop, no timer.
//
// In-process only, on purpose. The event bus forwards every event to the
// ring buffer and to mesh peers; signals must stay on the node that owns
// the channel (design 2.3: a peer gets the phase only, never raw
// signals). A phase change a signal causes goes out as the store's own
// `situation:phase` event, which carries no subject.
//
// Interest: a source that has to do extra work to complete a signal (a
// live group read to count who is left) first asks `wantsSignal(key)`,
// so a leave in a chat with no open talk costs nothing.

type Listener = (s: Signal) => void

const listeners = new Set<Listener>()
let interest: ((key: string) => boolean) | null = null

/** Subscribe. Returns the unsubscribe function. */
export function onSignal(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Publish one signal to this node's listeners. Never throws. */
export function publishSignal(s: Signal): void {
  for (const fn of [...listeners]) {
    try { fn(s) } catch { /* one listener must not stop another */ }
  }
}

/** Who wants signals about which chat (the daemon: chats in `during`).
 *  Null: nobody. */
export function setSignalInterest(fn: ((key: string) => boolean) | null): void {
  interest = fn
}

/** Is a signal about this chat of use to anyone here? False when unsure. */
export function wantsSignal(key: string | undefined): boolean {
  if (!key || !interest) return false
  try { return interest(key) === true } catch { return false }
}
