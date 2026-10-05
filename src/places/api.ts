import type { DaemonConfig } from "@/daemon/config"
import { parsePlace, parseReminder, type PlaceLimits } from "./input"
import type { PlaceInput, PlaceStore } from "./store"

// --- Place and reminder writes shared by the phone app and the dashboard ---
//
// Both surfaces send the same bodies and get the same answers; only who is
// asking differs (a paired phone, or the dashboard owner). Each function
// returns a status and a JSON body for the caller to send.

export type PlacesSettings = DaemonConfig["places"]

export interface ApiAnswer { status: number; body: Record<string, unknown> }

export const PLACES_OFF = "Place reminders are off on this computer. To turn them on, set places.enabled to true in agentx.json."

export function limitsOf(s: PlacesSettings): PlaceLimits {
  return {
    defaultRadiusMeters: s.defaultRadiusMeters,
    minRadiusMeters: s.minRadiusMeters,
    maxRadiusMeters: Math.max(s.minRadiusMeters, s.maxRadiusMeters),
    maxPlaces: s.maxPlaces,
  }
}

/** Everything a place list screen shows, and what the phone registers. */
export function placesOverview(store: PlaceStore, s: PlacesSettings): Record<string, unknown> {
  const limits = limitsOf(s)
  if (!s.enabled) {
    return { enabled: false, reason: PLACES_OFF, version: "off", places: [], reminders: [], settings: { ...limits, responsivenessSeconds: s.responsivenessSeconds, syncMinutes: s.syncMinutes } }
  }
  return {
    enabled: true,
    version: store.version(),
    places: store.listPlaces(),
    reminders: store.listReminders(),
    settings: { ...limits, responsivenessSeconds: s.responsivenessSeconds, syncMinutes: s.syncMinutes },
  }
}

export function addPlace(store: PlaceStore, s: PlacesSettings, body: Record<string, unknown>): ApiAnswer {
  if (!s.enabled) return { status: 409, body: { error: PLACES_OFF } }
  if (store.listPlaces().length >= s.maxPlaces) return { status: 409, body: { error: `at most ${s.maxPlaces} places (places.maxPlaces)` } }
  const p = parsePlace(body, limitsOf(s))
  if (!p.ok) return { status: 400, body: { error: p.error } }
  if (store.findPlace(p.value.name!)) return { status: 409, body: { error: `a place named "${p.value.name}" already exists` } }
  return { status: 200, body: { ok: true, place: store.addPlace(p.value as PlaceInput) } }
}

export function updatePlace(store: PlaceStore, s: PlacesSettings, body: Record<string, unknown>): ApiAnswer {
  if (!s.enabled) return { status: 409, body: { error: PLACES_OFF } }
  const id = typeof body.id === "string" ? body.id : ""
  if (!store.getPlace(id)) return { status: 404, body: { error: "no such place" } }
  const p = parsePlace(body, limitsOf(s), true)
  if (!p.ok) return { status: 400, body: { error: p.error } }
  const clash = p.value.name ? store.findPlace(p.value.name) : null
  if (clash && clash.id !== id) return { status: 409, body: { error: `a place named "${p.value.name}" already exists` } }
  return { status: 200, body: { ok: true, place: store.updatePlace(id, p.value) } }
}

export function removePlace(store: PlaceStore, body: Record<string, unknown>): ApiAnswer {
  const id = typeof body.id === "string" ? body.id : ""
  return store.removePlace(id) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "no such place" } }
}

/** `deviceId` set: the reminder fires only for that phone. */
export function addReminder(store: PlaceStore, s: PlacesSettings, body: Record<string, unknown>, deviceId: string | null = null): ApiAnswer {
  if (!s.enabled) return { status: 409, body: { error: PLACES_OFF } }
  const place = typeof body.place === "string" ? store.findPlace(body.place) : null
  if (!place) return { status: 404, body: { error: "no such place" } }
  const r = parseReminder(body)
  if (!r.ok) return { status: 400, body: { error: r.error } }
  return { status: 200, body: { ok: true, reminder: store.addReminder({ ...r.value, placeId: place.id, deviceId }) } }
}

export function removeReminder(store: PlaceStore, body: Record<string, unknown>): ApiAnswer {
  const id = typeof body.id === "string" ? body.id : ""
  return store.removeReminder(id) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "no such reminder" } }
}
