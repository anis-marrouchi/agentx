import { isTransition } from "./input"
import { newId, type PlaceReminder, type PlaceStore, type PlaceTransition } from "./store"

// --- A phone entered or left a place: fire its reminders (#676) ---
//
// The Android shell sends { id, place, transition, at } and nothing else.
// This records the event and claims the reminders it fires. Delivery (a
// push, or an agent turn whose answer is pushed) runs after the phone has
// its answer, so a slow agent never holds the phone's background job open.
//
// Three things keep one arrival from firing twice: the event id (the phone
// retries with the same one), the cooldown (geofences can bounce at the
// edge of a circle) and the claim, which marks a one-time reminder done in
// the same transaction that reads it.

export interface PlaceEventSettings {
  /** Same place, same phone, same transition within this: ignored. */
  cooldownMinutes: number
  /** Events the phone saw longer ago than this are kept, not fired. */
  staleMinutes: number
  keepEvents: number
}

export interface PlaceDelivery {
  /** Sends a notification to one phone. Throws when it was not sent. */
  push: (deviceId: string, title: string, body: string) => Promise<void>
  /** Runs one agent turn and returns its answer. Throws on failure. */
  ask: (agent: string, prompt: string) => Promise<string>
  log?: (line: string) => void
}

export type EventResult =
  | { status: 400 | 404; error: string }
  | { status: 200; fired: number; duplicate?: true; note?: string; delivered: Promise<void> }

export function receivePlaceEvent(
  store: PlaceStore,
  deviceId: string,
  body: Record<string, unknown>,
  settings: PlaceEventSettings,
  delivery: PlaceDelivery,
  now = Date.now(),
): EventResult {
  const done = Promise.resolve()
  const placeId = typeof body.place === "string" ? body.place : ""
  const transition = body.transition
  if (!placeId) return { status: 400, error: "place is required" }
  if (!isTransition(transition)) return { status: 400, error: 'transition must be "enter" or "exit"' }
  const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.id) ? body.id : newId("pe")
  const atRaw = typeof body.at === "string" ? Date.parse(body.at) : typeof body.at === "number" ? body.at : NaN
  // A phone clock ahead of ours can't put an event in the future.
  const at = Number.isFinite(atRaw) ? Math.min(atRaw, now) : now

  if (store.hasEvent(id)) return { status: 200, fired: 0, duplicate: true, delivered: done }
  const place = store.getPlace(placeId)
  if (!place) return { status: 404, error: "no such place; it may have been removed (the phone updates its list on its next sync)" }

  const base = { id, placeId, placeName: place.name, deviceId, transition, at }
  const last = store.lastEvent(placeId, deviceId, transition)
  if (last && Math.abs(at - last.at) < settings.cooldownMinutes * 60_000) {
    store.logEvent({ ...base, fired: 0, note: "repeat within the cooldown" }, settings.keepEvents)
    return { status: 200, fired: 0, note: "repeat within the cooldown", delivered: done }
  }
  if (now - at > settings.staleMinutes * 60_000) {
    store.logEvent({ ...base, fired: 0, note: "arrived too late to remind" }, settings.keepEvents)
    return { status: 200, fired: 0, note: "arrived too late to remind", delivered: done }
  }

  const due = store.claimReminders(placeId, transition, deviceId)
  store.logEvent({ ...base, fired: due.length, note: null }, settings.keepEvents)
  const delivered = Promise.all(due.map((r) => deliver(r, place.name, transition, at, deviceId, delivery))).then(() => undefined)
  return { status: 200, fired: due.length, delivered }
}

async function deliver(
  r: PlaceReminder,
  placeName: string,
  transition: PlaceTransition,
  at: number,
  deviceId: string,
  d: PlaceDelivery,
): Promise<void> {
  const title = `${transition === "enter" ? "Arrived at" : "Left"} ${placeName}`
  let body = r.text
  if (r.agent) {
    try {
      const answer = (await d.ask(r.agent, agentPrompt(r, placeName, transition, at))).trim()
      if (answer) body = answer
    } catch (e: any) {
      d.log?.(`[places] agent ${r.agent} did not answer reminder ${r.id}: ${e?.message || e}`)
    }
  }
  try {
    await d.push(deviceId, title, body)
  } catch (e: any) {
    d.log?.(`[places] reminder ${r.id} not delivered: ${e?.message || e}`)
  }
}

/** The turn an agent gets for a place reminder. */
export function agentPrompt(r: PlaceReminder, placeName: string, transition: PlaceTransition, at: number): string {
  const verb = transition === "enter" ? "just arrived at" : "just left"
  return [
    `Place reminder: the owner ${verb} "${placeName}" (${new Date(at).toISOString()}).`,
    `They asked for this then: ${r.text}`,
    "Do what it asks. Your reply is shown as a short phone notification, so keep it to a few sentences.",
  ].join("\n")
}
