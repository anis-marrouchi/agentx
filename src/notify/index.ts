import { readFocus, focusLabel, type FocusState } from "./focus"
import { NotificationQueue, digest, byDestination, type PendingNotification } from "./queue"
import { localAlert, DEFAULT_LOCAL, type LocalAlert } from "./local"

export { readFocus, focusLabel, type FocusState } from "./focus"
export { NotificationQueue, digest, byDestination, type PendingNotification } from "./queue"
export { localAlert, localSettings, DEFAULT_LOCAL, type LocalAlert, type LocalSettings } from "./local"

// Telling the person something, at a moment they have agreed to be told.
//
// Three things happen here and they are deliberately in this order:
//
//   1. Ask whether they are in Focus. If they are, the message is HELD,
//      not dropped and not sent anyway.
//   2. Otherwise hand it to the channel router, which already knows how to
//      push (ntfy), so this adds no new delivery path.
//   3. Show a banner and play a sound locally, because a push to a phone
//      in another room is not a notification to someone sitting at the
//      machine. A held message gets neither: Focus holds all of it.
//
// The local alert is its own step rather than a property of the push for
// a reason: ntfy's sound plays on the phone, and the person this is for is
// usually in front of the Mac that raised the event.

export type Sender = (msg: {
  title: string
  message: string
  priority?: number
  /** Where to deliver. Omitted means the caller's own default. */
  channel?: string
  chatId?: string
}) => Promise<void>

export interface NotifyInput {
  message: string
  /** Who is speaking. Shown in a digest so a backlog is attributable. */
  from?: string
  title?: string
  /** 1 (min) … 5 (max), matching ntfy. */
  priority?: number
  /** Deliver even in Focus. For things that genuinely cannot wait. */
  urgent?: boolean
  /** Where it is going, so a held message reaches the same place later. */
  channel?: string
  chatId?: string
}

export interface NotifyResult {
  delivered: boolean
  /** True when it went to the queue instead. */
  held: boolean
  reason: string
}

/** What a caller passes to control the local step: its own alert, or
 *  false for none. Omitted means the defaults (banner and Glass). */
type AlertOption = LocalAlert | false

function alertFor(opt: AlertOption | undefined): LocalAlert | null {
  if (opt === false) return null
  return opt ?? localAlert(DEFAULT_LOCAL)
}

export async function notify(
  input: NotifyInput,
  send: Sender,
  opts: { queue?: NotificationQueue; alert?: AlertOption; focus?: FocusState } = {},
): Promise<NotifyResult> {
  const queue = opts.queue ?? new NotificationQueue()
  const state = opts.focus ?? readFocus()
  const title = input.title ?? "AgentX"

  if (state.active && !input.urgent) {
    const entry: PendingNotification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      from: input.from ?? "agentx",
      title,
      message: input.message,
      priority: input.priority,
      heldBecause: focusLabel(state),
      channel: input.channel,
      chatId: input.chatId,
    }
    queue.add(entry)
    return { delivered: false, held: true, reason: `held — ${focusLabel(state)}` }
  }

  await send({
    title, message: input.message, priority: input.priority,
    channel: input.channel, chatId: input.chatId,
  })
  await alertFor(opts.alert)?.(title, input.message)
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
  opts: { queue?: NotificationQueue; alert?: AlertOption } = {},
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
  if (waiting.length === 0) return 0

  // One digest per destination. A held Telegram message and a held push
  // are not interchangeable — the Telegram one carries a reply the
  // workflow depends on — so they are delivered where each was addressed.
  for (const group of byDestination(waiting)) {
    const folded = digest(group.entries)
    if (!folded) continue
    await send({
      title: folded.title, message: folded.message, priority: 4,
      channel: group.channel, chatId: group.chatId,
    })
  }
  queue.drain()
  // One banner for the whole backlog, whatever channels it went to.
  const all = digest(waiting)
  if (all) await alertFor(opts.alert)?.(all.title, all.message)
  return waiting.length
}
