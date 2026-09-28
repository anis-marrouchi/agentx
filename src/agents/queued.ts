// The registry's "queued" answer.
//
// When an agent is busy on a chat, registry.execute puts the message in the
// chat's queue and returns `error: "__queued__:<mode>:<pending>"`. The
// message was ACCEPTED: the queue flush runs it once the current turn ends
// and posts the reply on the original channel. It is not a failure.
//
// The marker travels in the `error` field, so every caller that reads an
// error has to recognise it first. A mesh hop wraps it on the way back
// (`Peer "p" /task error: 500: __queued__:collect:1`, possibly nested inside
// a `mesh fallback failed:` chain), so matching with startsWith on the local
// answer alone missed it and the router posted "I couldn't complete that —
// queued:collect:1" on the thread (#282). This is the one place that knows
// the marker's shape.

export const QUEUED_MARKER = "__queued__"

export interface QueuedAnswer {
  /** The queue mode that took the message: "collect" or "followup". */
  mode: string
  /** Messages waiting on that chat, this one included. */
  pending: number
}

/** The marker registry.execute returns for a message it queued. */
export function queuedMarker(mode: string, pending: number): string {
  return `${QUEUED_MARKER}:${mode}:${pending}`
}

// The marker either opens the text (local answer) or follows a ": " left by
// a mesh wrapper. Anchored at the end so a reply that merely quotes the
// marker mid-sentence is not mistaken for one.
const QUEUED_RE = /(?:^|:\s*)__queued__(?::([A-Za-z-]+))?(?::(\d+))?\s*$/

/** The queued answer inside `text` (a registry error or a mesh error
 *  message), or null when it is anything else. */
export function parseQueued(text: string | null | undefined): QueuedAnswer | null {
  if (!text) return null
  const m = QUEUED_RE.exec(text.trim())
  if (!m) return null
  return { mode: m[1] || "collect", pending: m[2] ? Number(m[2]) : 1 }
}

/** True when `text` is the queued answer, local or wrapped by a mesh hop. */
export function isQueued(text: string | null | undefined): boolean {
  return parseQueued(text) !== null
}
