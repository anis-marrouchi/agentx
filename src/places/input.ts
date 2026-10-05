import type { PlaceInput, PlaceTransition, ReminderInput } from "./store"

// --- Checking what the phone, the dashboard and the CLI send (#676) ---
//
// One set of rules for every way a place or a place reminder is made, so a
// circle the phone can't register as a geofence is refused up front.

/** The `places` settings that bound what may be saved (config.ts). */
export interface PlaceLimits {
  defaultRadiusMeters: number
  minRadiusMeters: number
  maxRadiusMeters: number
  maxPlaces: number
}

export const PLACE_NAME_MAX = 60
export const REMINDER_TEXT_MAX = 500

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** A new place, or with `partial` the fields of an edit. */
export function parsePlace(body: Record<string, unknown>, limits: PlaceLimits, partial = false): Result<Partial<PlaceInput>> {
  const out: Partial<PlaceInput> = {}
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : ""
    if (!name) return fail("give the place a name")
    if ([...name].length > PLACE_NAME_MAX) return fail(`a place name is at most ${PLACE_NAME_MAX} characters`)
    out.name = name
  }
  if (body.lat !== undefined || body.lon !== undefined || !partial) {
    const lat = num(body.lat)
    const lon = num(body.lon)
    if (lat === null || lat < -90 || lat > 90) return fail("lat must be a number from -90 to 90")
    if (lon === null || lon < -180 || lon > 180) return fail("lon must be a number from -180 to 180")
    out.lat = round(lat)
    out.lon = round(lon)
  }
  if (body.radiusMeters !== undefined || !partial) {
    const r = body.radiusMeters === undefined || body.radiusMeters === null || body.radiusMeters === ""
      ? limits.defaultRadiusMeters
      : num(body.radiusMeters)
    if (r === null || r < limits.minRadiusMeters || r > limits.maxRadiusMeters) {
      return fail(`radiusMeters must be from ${limits.minRadiusMeters} to ${limits.maxRadiusMeters}`)
    }
    out.radiusMeters = Math.round(r)
  }
  return { ok: true, value: out }
}

export function parseReminder(body: Record<string, unknown>): Result<Omit<ReminderInput, "placeId">> {
  const on = body.on ?? "enter"
  if (!isTransition(on)) return fail('on must be "enter" or "exit"')
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return fail("say what to remind you of")
  if ([...text].length > REMINDER_TEXT_MAX) return fail(`a reminder is at most ${REMINDER_TEXT_MAX} characters`)
  let agent: string | null = null
  if (body.agent !== undefined && body.agent !== null && body.agent !== "") {
    if (typeof body.agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(body.agent)) return fail("agent must be an agent id")
    agent = body.agent
  }
  if (body.repeat !== undefined && typeof body.repeat !== "boolean") return fail("repeat must be true or false")
  return { ok: true, value: { on, text, agent, repeat: body.repeat === true } }
}

export function isTransition(v: unknown): v is PlaceTransition {
  return v === "enter" || v === "exit"
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** About 1 cm: more digits only describe the phone's noise. */
function round(n: number): number {
  return Math.round(n * 1e7) / 1e7
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}
