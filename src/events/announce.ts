import type { TypedEventBus } from "./bus"
import { newEventId, type EventEnvelope } from "./envelope"

// --- Mesh announcements (#166) ---
//
// A rare note to the whole mesh, written by a person or an agent:
// `agentx mesh announce "…"` or POST /mesh/announce. It is published once,
// on this node, as a `kind: "announce"` envelope; peers pick it up through
// their feed like any other local event. It is stored in the ring and shown
// in feeds, and it wakes no agent on its own.

/** Longest text accepted; the envelope summary is capped further. */
export const ANNOUNCE_MAX_INPUT = 2000

export type AnnounceResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; error: string }

export function publishAnnouncement(
  bus: TypedEventBus,
  body: Record<string, unknown>,
  agentIds: ReadonlySet<string>,
): AnnounceResult {
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return { ok: false, error: "text is required" }
  if (text.length > ANNOUNCE_MAX_INPUT) return { ok: false, error: `text is longer than ${ANNOUNCE_MAX_INPUT} characters` }
  const by = typeof body.by === "string" ? body.by.trim().slice(0, 100) : ""
  // An agent author is the event's agentId; anyone else is named in the text.
  const agentId = by && agentIds.has(by) ? by : undefined
  const summary = by && !agentId ? `${by}: ${text}` : text
  // Its own root: an announcement is an entry point, not part of whatever
  // request carried it.
  const id = newEventId()
  const event = bus.publish({ id, rootId: id, kind: "announce", type: "announce", summary, agentId })
  return { ok: true, event }
}
