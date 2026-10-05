import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { randomBytes } from "crypto"

// --- Places and the reminders that fire on them (#676) ---
//
// A place is a name, a centre and a radius. The Android shell registers each
// one as an OS geofence (the phone, not the computer, watches the location)
// and reports only "{place, enter|exit, time}" when the phone crosses one.
// The computer never receives coordinates from the phone: the centre of a
// place is whatever the owner typed or picked when saving it.
//
// A rule says what to do on a crossing: push a short reminder to the phone
// that crossed, or hand a task to an agent and push its answer. A rule fires
// once by default and then switches itself off ("remind me when I arrive"),
// or on every crossing when `repeat` is set.
//
// Everything sits in one small JSON file, written atomically, next to the
// rest of the node's state in .agentx/.

export type Transition = "enter" | "exit"

export interface Place {
  id: string
  name: string
  lat: number
  lng: number
  /** Metres. */
  radius: number
  createdAt: string
}

export interface PlaceRule {
  id: string
  placeId: string
  on: Transition
  /** The reminder text, or the task for `agent`. */
  text: string
  /** Agent that gets `text` as a task; its answer is pushed. Unset: the
   *  text itself is pushed. */
  agent?: string
  /** Fire on every crossing; otherwise the rule switches off after once. */
  repeat: boolean
  enabled: boolean
  createdAt: string
  lastFiredAt?: string
}

export interface PlacesFile {
  places: Place[]
  rules: PlaceRule[]
  /** Ids of recent phone events, so a retried report fires nothing twice. */
  seen: string[]
}

/** The `app.places` settings this module reads. */
export interface PlaceLimits {
  minRadiusMeters: number
  maxRadiusMeters: number
  defaultRadiusMeters: number
  maxPlaces: number
  maxRulesPerPlace: number
  cooldownMinutes: number
  maxEventAgeMinutes: number
}

export const PLACE_NAME_MAX = 60
export const RULE_TEXT_MAX = 500
const SEEN_MAX = 200
const ID = /^[a-z]{2,5}_[a-z0-9]{6,32}$/
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/
const AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/

export function placesFile(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, file)
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`
}

function emptyFile(): PlacesFile {
  return { places: [], rules: [], seen: [] }
}

/** Validates a place from the phone app or the dashboard. */
export function parsePlaceInput(body: Record<string, unknown>, limits: PlaceLimits): { ok: true; value: Omit<Place, "id" | "createdAt"> } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return { ok: false, error: "Give the place a name." }
  if ([...name].length > PLACE_NAME_MAX) return { ok: false, error: `Keep the name under ${PLACE_NAME_MAX} characters.` }
  const lat = Number(body.lat)
  const lng = Number(body.lng)
  if (body.lat === undefined || body.lat === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: "Latitude must be a number from -90 to 90." }
  if (body.lng === undefined || body.lng === "" || !Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: "Longitude must be a number from -180 to 180." }
  const radius = body.radius === undefined || body.radius === "" ? limits.defaultRadiusMeters : Math.round(Number(body.radius))
  if (!Number.isFinite(radius) || radius < limits.minRadiusMeters || radius > limits.maxRadiusMeters) {
    return { ok: false, error: `The radius must be from ${limits.minRadiusMeters} to ${limits.maxRadiusMeters} metres.` }
  }
  // Six decimals is about 10 cm: plenty, and no false precision is stored.
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return { ok: true, value: { name, lat: round(lat), lng: round(lng), radius } }
}

/** Validates a rule. `hasAgent` says whether an agent id exists here. */
export function parseRuleInput(
  body: Record<string, unknown>,
  hasAgent: (id: string) => boolean,
): { ok: true; value: Omit<PlaceRule, "id" | "createdAt" | "enabled"> } | { ok: false; error: string } {
  const placeId = typeof body.placeId === "string" ? body.placeId : ""
  if (!ID.test(placeId)) return { ok: false, error: "Pick a place." }
  const on = body.on === undefined ? "enter" : body.on
  if (on !== "enter" && on !== "exit") return { ok: false, error: "on must be enter or exit." }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return { ok: false, error: "Write what to remind you of." }
  if ([...text].length > RULE_TEXT_MAX) return { ok: false, error: `Keep it under ${RULE_TEXT_MAX} characters.` }
  const agentRaw = typeof body.agent === "string" ? body.agent.trim() : ""
  if (agentRaw && (!AGENT_ID.test(agentRaw) || !hasAgent(agentRaw))) return { ok: false, error: `There is no agent called ${agentRaw.slice(0, 64)} on this computer.` }
  if (body.repeat !== undefined && typeof body.repeat !== "boolean") return { ok: false, error: "repeat must be true or false." }
  return { ok: true, value: { placeId, on, text, ...(agentRaw ? { agent: agentRaw } : {}), repeat: body.repeat === true } }
}

/** What a phone reports. Nothing else is read from its body: no position. */
export interface PlaceEvent {
  id: string
  place: string
  transition: Transition
  /** When the phone crossed, ms since the epoch. */
  time: number
}

export function parsePlaceEvent(body: Record<string, unknown>): { ok: true; value: PlaceEvent } | { ok: false; error: string } {
  const id = typeof body.id === "string" ? body.id : ""
  if (!EVENT_ID.test(id)) return { ok: false, error: "id must be 8 to 64 letters, digits, - or _" }
  const place = typeof body.place === "string" ? body.place : ""
  if (!ID.test(place)) return { ok: false, error: "place must be a place id" }
  const transition = body.transition
  if (transition !== "enter" && transition !== "exit") return { ok: false, error: "transition must be enter or exit" }
  const time = typeof body.time === "number" ? body.time : typeof body.time === "string" ? Date.parse(body.time) : NaN
  if (!Number.isFinite(time)) return { ok: false, error: "time must be a timestamp" }
  return { ok: true, value: { id, place, transition, time } }
}

export type EventOutcome =
  | { status: "fired"; place: Place; rules: PlaceRule[] }
  | { status: "duplicate" | "unknown-place" | "too-old" | "no-rules" }

export class PlaceStore {
  constructor(private path: string, private now: () => number = Date.now) {}

  read(): PlacesFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"))
      if (!raw || typeof raw !== "object") return emptyFile()
      return {
        places: Array.isArray(raw.places) ? raw.places : [],
        rules: Array.isArray(raw.rules) ? raw.rules : [],
        seen: Array.isArray(raw.seen) ? raw.seen.filter((s: unknown) => typeof s === "string") : [],
      }
    } catch {
      return emptyFile()
    }
  }

  private write(data: PlacesFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  addPlace(input: Omit<Place, "id" | "createdAt">, limits: PlaceLimits): { ok: true; place: Place } | { ok: false; error: string } {
    const data = this.read()
    if (data.places.length >= limits.maxPlaces) return { ok: false, error: `You already have ${limits.maxPlaces} places, the most allowed (app.places.maxPlaces). Remove one first.` }
    if (data.places.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) return { ok: false, error: `You already have a place called ${input.name}.` }
    const place: Place = { id: newId("pl"), ...input, createdAt: new Date(this.now()).toISOString() }
    data.places.push(place)
    this.write(data)
    return { ok: true, place }
  }

  /** Removes the place and every rule on it. */
  removePlace(id: string): boolean {
    const data = this.read()
    const before = data.places.length
    data.places = data.places.filter((p) => p.id !== id)
    if (data.places.length === before) return false
    data.rules = data.rules.filter((r) => r.placeId !== id)
    this.write(data)
    return true
  }

  addRule(input: Omit<PlaceRule, "id" | "createdAt" | "enabled">, limits: PlaceLimits): { ok: true; rule: PlaceRule } | { ok: false; error: string } {
    const data = this.read()
    if (!data.places.some((p) => p.id === input.placeId)) return { ok: false, error: "That place doesn't exist any more." }
    if (data.rules.filter((r) => r.placeId === input.placeId).length >= limits.maxRulesPerPlace) {
      return { ok: false, error: `That place already has ${limits.maxRulesPerPlace} reminders, the most allowed (app.places.maxRulesPerPlace).` }
    }
    const rule: PlaceRule = { id: newId("pr"), ...input, enabled: true, createdAt: new Date(this.now()).toISOString() }
    data.rules.push(rule)
    this.write(data)
    return { ok: true, rule }
  }

  setRuleEnabled(id: string, enabled: boolean): PlaceRule | null {
    const data = this.read()
    const rule = data.rules.find((r) => r.id === id)
    if (!rule) return null
    rule.enabled = enabled
    this.write(data)
    return rule
  }

  removeRule(id: string): boolean {
    const data = this.read()
    const before = data.rules.length
    data.rules = data.rules.filter((r) => r.id !== id)
    if (data.rules.length === before) return false
    this.write(data)
    return true
  }

  /** Records a phone's report and returns the rules it fires. A one-time
   *  rule is switched off here, before anything is delivered, so a crash or
   *  a retried report never fires it twice. */
  accept(ev: PlaceEvent, limits: PlaceLimits): EventOutcome {
    const data = this.read()
    if (data.seen.includes(ev.id)) return { status: "duplicate" }
    data.seen = [...data.seen, ev.id].slice(-SEEN_MAX)
    const now = this.now()
    const place = data.places.find((p) => p.id === ev.place)
    let outcome: EventOutcome
    if (!place) outcome = { status: "unknown-place" }
    // A report that waited too long (the phone was offline) is about
    // somewhere the owner has already left; reminding them now would be wrong.
    else if (ev.time < now - limits.maxEventAgeMinutes * 60_000) outcome = { status: "too-old" }
    else {
      const cooldown = limits.cooldownMinutes * 60_000
      const due = data.rules.filter((r) =>
        r.placeId === place.id && r.on === ev.transition && r.enabled &&
        !(r.lastFiredAt && Date.parse(r.lastFiredAt) > now - cooldown))
      for (const r of due) {
        r.lastFiredAt = new Date(now).toISOString()
        if (!r.repeat) r.enabled = false
      }
      outcome = due.length ? { status: "fired", place, rules: due.map((r) => ({ ...r })) } : { status: "no-rules" }
    }
    this.write(data)
    return outcome
  }
}
