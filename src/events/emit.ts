import type { TypedEventBus } from "./bus"
import { newEventId, type EventEnvelope } from "./envelope"

// --- Named events (#1284) ---
//
// Any agent or script can publish a named event (`render:ready`,
// `build:done`) with `agentx events emit`, the agentx_emit MCP tool or
// POST /events. It is published on this node as a `kind: "custom"`
// envelope whose `type` is the name, so a subscription with
// `kinds: ["render:ready"]` matches it and, with `delivery: "wake"`,
// starts a turn (src/events/wake.ts). Peers see it through their feed
// like any other local event.
//
// Emitted from inside an agent's turn, the event carries that agent and
// that turn's root, so the loop guard holds: an agent woken by an event
// that it caused, directly or through another agent, is not woken again.
// Emitted from outside a turn (a script, a person), it is its own root.

/** Event names: a letter or digit, then letters, digits and `:._-`. */
export const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/i
/** Longest summary accepted; the envelope summary is capped further. */
export const EMIT_SUMMARY_MAX_INPUT = 2000
export const EMIT_REF_MAX = 200

/** The emitting turn, when the request came from one. */
export interface EmitCaller {
  agentId: string
  rootId?: string
  /** The event that woke the emitting turn, when a wake started it: the
   *  Hub files this event as a reply to that one (#1648). */
  parentId?: string
}

export type EmitResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; error: string }

export function publishNamedEvent(
  bus: TypedEventBus,
  body: Record<string, unknown>,
  agentIds: ReadonlySet<string>,
  caller: EmitCaller | null = null,
): EmitResult {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return { ok: false, error: "name is required" }
  if (!EVENT_NAME_PATTERN.test(name)) {
    return { ok: false, error: "name must be 1-64 letters, digits or : . _ - and start with a letter or digit" }
  }
  const text = typeof body.summary === "string" ? body.summary.trim() : ""
  if (text.length > EMIT_SUMMARY_MAX_INPUT) return { ok: false, error: `summary is longer than ${EMIT_SUMMARY_MAX_INPUT} characters` }
  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined
  if (ref && ref.length > EMIT_REF_MAX) return { ok: false, error: `ref is longer than ${EMIT_REF_MAX} characters` }
  // The running turn names the author; otherwise `by`, when it is an agent
  // here, does. Anyone else is named in the summary.
  const by = typeof body.by === "string" ? body.by.trim().slice(0, 100) : ""
  const agentId = caller?.agentId ?? (by && agentIds.has(by) ? by : undefined)
  const said = text || name
  const summary = by && !agentId ? `${by}: ${said}` : said
  const id = newEventId()
  const event = bus.publish({
    id,
    rootId: caller?.rootId ?? id,
    ...(caller?.parentId ? { parentId: caller.parentId } : {}),
    kind: "custom",
    type: name,
    summary,
    agentId,
    ...(ref ? { ref } : {}),
  })
  return { ok: true, event }
}
