import { execFile } from "child_process"
import { existsSync } from "fs"
import { readFocus, focusLabel, type FocusState } from "./focus"
import { NotificationQueue, digest, type PendingNotification } from "./queue"

export { readFocus, focusLabel, type FocusState } from "./focus"
export { NotificationQueue, digest, type PendingNotification } from "./queue"

// Telling the person something, at a moment they have agreed to be told.
//
// Three things happen here and they are deliberately in this order:
//
//   1. Ask whether they are in Focus. If they are, the message is HELD,
//      not dropped and not sent anyway.
//   2. Otherwise hand it to the channel router, which already knows how to
//      push (ntfy), so this adds no new delivery path.
//   3. Play a sound locally, because a push to a phone in another room is
//      not a notification to someone sitting at the machine.
//
// The sound is its own step rather than a property of the push for a
// reason: ntfy's sound plays on the phone, and the person this is for is
// usually in front of the Mac that raised the event.

export type Sender = (msg: { title: string; message: string; priority?: number }) => Promise<void>

export interface NotifyInput {
  message: string
  /** Who is speaking. Shown in a digest so a backlog is attributable. */
  from?: string
  title?: string
  /** 1 (min) … 5 (max), matching ntfy. */
  priority?: number
  /** Deliver even in Focus. For things that genuinely cannot wait. */
  urgent?: boolean
}

export interface NotifyResult {
  delivered: boolean
  /** True when it went to the queue instead. */
  held: boolean
  reason: string
}

/** macOS system sounds, by name. Glass is the gentlest of the set that is
 *  still audible over a keyboard — Basso and Sosumi are alerts, Funk and
 *  Frog are jokes, and Ping is the one every other app already uses. */
const DEFAULT_SOUND = "Glass"

export async function notify(
  input: NotifyInput,
  send: Sender,
  opts: { queue?: NotificationQueue; sound?: string | false; focus?: FocusState } = {},
): Promise<NotifyResult> {
  const queue = opts.queue ?? new NotificationQueue()
  const state = opts.focus ?? readFocus()
  const title = input.title ?? "Secretary"

  if (state.active && !input.urgent) {
    const entry: PendingNotification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      from: input.from ?? "agentx",
      title,
      message: input.message,
      priority: input.priority,
      heldBecause: focusLabel(state),
    }
    queue.add(entry)
    return { delivered: false, held: true, reason: `held — ${focusLabel(state)}` }
  }

  await send({ title, message: input.message, priority: input.priority })
  if (opts.sound !== false) playSound(typeof opts.sound === "string" ? opts.sound : DEFAULT_SOUND)
  return { delivered: true, held: false, reason: state.active ? "urgent, sent during Focus" : "sent" }
}

/**
 * Deliver everything that was held, as ONE message.
 *
 * Called when Focus ends. Returns how many were folded in, or 0 when there
 * was nothing waiting.
 */
export async function flushHeld(
  send: Sender,
  opts: { queue?: NotificationQueue; sound?: string | false } = {},
): Promise<number> {
  const queue = opts.queue ?? new NotificationQueue()
  // Read, send, THEN clear.
  //
  // Draining first is the obvious order and it is wrong: a transient
  // network failure would take the whole backlog with it, which is exactly
  // the loss this queue exists to prevent. Holding a notification is only
  // defensible if nothing between here and the person can drop it.
  //
  // The cost of this order is a possible duplicate — sent, then the clear
  // fails — and a message arriving twice is plainly better than one that
  // never arrives.
  const waiting = queue.list()
  const folded = digest(waiting)
  if (!folded) return 0

  await send({ title: folded.title, message: folded.message, priority: 4 })
  queue.drain()
  if (opts.sound !== false) playSound(typeof opts.sound === "string" ? opts.sound : DEFAULT_SOUND)
  return waiting.length
}

/**
 * Play a short sound on this machine.
 *
 * Fire-and-forget and never fatal: a notification that failed to make a
 * noise still arrived, and a caller should not have to handle an audio
 * error to tell someone their build finished.
 */
export function playSound(name = DEFAULT_SOUND): void {
  const path = `/System/Library/Sounds/${name}.aiff`
  if (!existsSync(path)) return
  try {
    execFile("/usr/bin/afplay", ["-v", "0.4", path], () => {})
  } catch {
    /* no audio on this machine, or no afplay — not worth reporting */
  }
}
