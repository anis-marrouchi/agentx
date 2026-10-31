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
//
// An event can carry a deadline (`expiresIn` or `expiresAt`, #1596): a
// "restarts in 1 minute" warning is useless 20 minutes later, so a wake
// that has not started by then is dropped instead of run late.

/** Event names: a letter or digit, then letters, digits and `:._-`. */
export const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/i
/** Longest summary accepted; the envelope summary is capped further. */
export const EMIT_SUMMARY_MAX_INPUT = 2000
export const EMIT_REF_MAX = 200
/** Longest an emitted event may stay worth acting on (#1596). */
export const EMIT_EXPIRES_MAX_MS = 7 * 24 * 60 * 60 * 1000

/** A duration as milliseconds: a number of seconds, or text such as
 *  `90`, `90s`, `5m`, `2h` or `1d`. Undefined when it is not one. */
export function parseDuration(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : undefined
  if (typeof v !== "string") return undefined
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i)
  if (!m) return undefined
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || "s").toLowerCase() as "s" | "m" | "h" | "d"]
  const ms = Math.round(Number(m[1]) * unit)
  return ms > 0 ? ms : undefined
}

/** The event's deadline from `expiresIn` (a duration) or `expiresAt` (an
 *  ISO time); `{}` when neither is given. */
function readExpiry(body: Record<string, unknown>, now: number): { expiresAt?: string; error?: string } {
  const hasIn = body.expiresIn !== undefined && body.expiresIn !== null && body.expiresIn !== ""
  const hasAt = typeof body.expiresAt === "string" && body.expiresAt.trim() !== ""
  if (hasIn && hasAt) return { error: "give expiresIn or expiresAt, not both" }
  let at: number | undefined
  if (hasIn) {
    const ms = parseDuration(body.expiresIn)
    if (ms === undefined) return { error: "expiresIn must be a duration such as 90s, 5m or 2h" }
    at = now + ms
  } else if (hasAt) {
    at = Date.parse((body.expiresAt as string).trim())
    if (Number.isNaN(at)) return { error: "expiresAt must be an ISO time" }
    if (at <= now) return { error: "expiresAt is already past" }
  } else {
    return {}
  }
  if (at - now > EMIT_EXPIRES_MAX_MS) return { error: "an event can expire at most 7 days ahead" }
  return { expiresAt: new Date(at).toISOString() }
}

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
  now: number = Date.now(),
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
  const expiry = readExpiry(body, now)
  if (expiry.error) return { ok: false, error: expiry.error }
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
    ...(expiry.expiresAt ? { expiresAt: expiry.expiresAt } : {}),
  })
  return { ok: true, event }
}
