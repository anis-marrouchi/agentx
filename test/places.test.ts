import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { PlaceStore } from "../src/places/store"
import { parsePlace, parseReminder } from "../src/places/input"
import { agentPrompt, receivePlaceEvent, type PlaceDelivery } from "../src/places/events"
import { addPlace, addReminder, placesOverview, updatePlace } from "../src/places/api"
import { daemonConfigSchema } from "../src/daemon/config"
import { assetLinks } from "../src/daemon/places-panel"

// Places, place reminders and the enter/exit events the Android shell
// sends (#676): what is saved, what fires, and what never fires twice.

const LIMITS = { defaultRadiusMeters: 150, minRadiusMeters: 100, maxRadiusMeters: 5000, maxPlaces: 3 }
const SETTINGS = { cooldownMinutes: 10, staleMinutes: 60, keepEvents: 50 }
const places = (p: Record<string, unknown> = {}) => daemonConfigSchema.shape.places.parse(p)

let dir: string
let db: Database.Database
let clock: number
let store: PlaceStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-places-"))
  db = new Database(join(dir, "db.sqlite"))
  clock = Date.parse("2026-10-05T08:00:00Z")
  store = new PlaceStore(db, () => clock)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function fakeDelivery() {
  const pushes: Array<{ deviceId: string; title: string; body: string }> = []
  const asks: Array<{ agent: string; prompt: string }> = []
  let answer: string | Error = "Bring the permission slip."
  const d: PlaceDelivery = {
    push: async (deviceId, title, body) => { pushes.push({ deviceId, title, body }) },
    ask: async (agent, prompt) => {
      asks.push({ agent, prompt })
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { d, pushes, asks, answer: (a: string | Error) => { answer = a } }
}

describe("place input", () => {
  it("takes the default radius and refuses circles a phone can't watch", () => {
    expect(parsePlace({ name: " School  gate ", lat: "48.1", lon: 2.2 }, LIMITS)).toEqual({ ok: true, value: { name: "School gate", lat: 48.1, lon: 2.2, radiusMeters: 150 } })
    expect(parsePlace({ name: "x", lat: 91, lon: 0 }, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("lat") })
    expect(parsePlace({ name: "x", lat: 1, lon: 0, radiusMeters: 20 }, LIMITS)).toMatchObject({ ok: false, error: "radiusMeters must be from 100 to 5000" })
    expect(parsePlace({ lat: 1, lon: 1 }, LIMITS)).toMatchObject({ ok: false })
    expect(parsePlace({ radiusMeters: 300 }, LIMITS, true)).toEqual({ ok: true, value: { radiusMeters: 300 } })
  })

  it("checks reminders", () => {
    expect(parseReminder({ text: "Buy bread" })).toEqual({ ok: true, value: { on: "enter", text: "Buy bread", agent: null, repeat: false } })
    expect(parseReminder({ text: "x", on: "leave" })).toMatchObject({ ok: false })
    expect(parseReminder({ text: "x", agent: "rm -rf" })).toMatchObject({ ok: false })
    expect(parseReminder({ text: " " })).toMatchObject({ ok: false })
  })
})

describe("place store and API", () => {
  it("adds, renames, caps and removes places with their reminders", () => {
    const s = { ...places(), maxPlaces: 2 }
    const a = addPlace(store, s, { name: "School", lat: 48.1, lon: 2.2 })
    expect(a.status).toBe(200)
    expect(addPlace(store, s, { name: "school", lat: 1, lon: 1 }).status).toBe(409)
    addPlace(store, s, { name: "Gym", lat: 1, lon: 1, radiusMeters: 200 })
    expect(addPlace(store, s, { name: "Shop", lat: 1, lon: 1 })).toMatchObject({ status: 409, body: { error: expect.stringContaining("at most 2") } })

    const id = (a.body.place as any).id
    const v1 = store.version()
    clock += 1000
    expect(updatePlace(store, s, { id, radiusMeters: 400 }).status).toBe(200)
    expect(store.version()).not.toBe(v1)
    expect(addReminder(store, s, { place: "SCHOOL", text: "Pick up Sam" }).status).toBe(200)
    expect(store.listReminders()).toHaveLength(1)
    expect(store.removePlace(id)).toBe(true)
    expect(store.listReminders()).toHaveLength(0)
  })

  it("lists nothing to watch when place reminders are off", () => {
    const s = places({ enabled: false })
    store.addPlace({ name: "School", lat: 1, lon: 1, radiusMeters: 150 })
    expect(placesOverview(store, s)).toMatchObject({ enabled: false, places: [], version: "off" })
    expect(addPlace(store, s, { name: "Gym", lat: 1, lon: 1 }).status).toBe(409)
  })
})

describe("place events", () => {
  it("fires a one-time reminder once, as a push to the phone that arrived", async () => {
    const p = store.addPlace({ name: "School", lat: 1, lon: 1, radiusMeters: 150 })
    store.addReminder({ placeId: p.id, on: "enter", text: "Pick up Sam" })
    store.addReminder({ placeId: p.id, on: "exit", text: "Not now" })
    const { d, pushes } = fakeDelivery()

    const r = receivePlaceEvent(store, "tok_a", { id: "evt-000001", place: p.id, transition: "enter", at: new Date(clock).toISOString() }, SETTINGS, d, clock)
    expect(r).toMatchObject({ status: 200, fired: 1 })
    await (r as any).delivered
    expect(pushes).toEqual([{ deviceId: "tok_a", title: "Arrived at School", body: "Pick up Sam" }])

    // The phone retries with the same id: nothing again.
    expect(receivePlaceEvent(store, "tok_a", { id: "evt-000001", place: p.id, transition: "enter" }, SETTINGS, d, clock)).toMatchObject({ fired: 0, duplicate: true })
    // A later arrival: the one-time reminder is done.
    clock += 3600_000
    const again = receivePlaceEvent(store, "tok_a", { id: "evt-000002", place: p.id, transition: "enter", at: clock }, SETTINGS, d, clock)
    expect(again).toMatchObject({ status: 200, fired: 0 })
    expect(store.listReminders({ includeDone: true }).find((x) => x.on === "enter")).toMatchObject({ done: true, lastFiredAt: clock - 3600_000 })
  })

  it("ignores a bounce within the cooldown and a stale event, but logs both", async () => {
    const p = store.addPlace({ name: "Gym", lat: 1, lon: 1, radiusMeters: 150 })
    store.addReminder({ placeId: p.id, on: "enter", text: "Stretch", repeat: true })
    const { d, pushes } = fakeDelivery()
    const first = receivePlaceEvent(store, "tok_a", { id: "evt-100001", place: p.id, transition: "enter", at: clock }, SETTINGS, d, clock)
    expect(first).toMatchObject({ fired: 1 })
    clock += 5 * 60_000
    expect(receivePlaceEvent(store, "tok_a", { id: "evt-100002", place: p.id, transition: "enter", at: clock }, SETTINGS, d, clock))
      .toMatchObject({ fired: 0, note: "repeat within the cooldown" })
    // Another phone is its own: not in its cooldown.
    expect(receivePlaceEvent(store, "tok_b", { id: "evt-100003", place: p.id, transition: "enter", at: clock }, SETTINGS, d, clock)).toMatchObject({ fired: 1 })
    clock += 3 * 3600_000
    expect(receivePlaceEvent(store, "tok_a", { id: "evt-100004", place: p.id, transition: "enter", at: clock - 2 * 3600_000 }, SETTINGS, d, clock))
      .toMatchObject({ fired: 0, note: "arrived too late to remind" })
    await new Promise((r) => setTimeout(r, 0))
    expect(pushes.map((x) => x.deviceId)).toEqual(["tok_a", "tok_b"])
    expect(store.recentEvents(10)).toHaveLength(4)
  })

  it("fires a reminder kept for one phone only for that phone", () => {
    const p = store.addPlace({ name: "Home", lat: 1, lon: 1, radiusMeters: 150 })
    store.addReminder({ placeId: p.id, on: "exit", text: "Lock the door", deviceId: "tok_a" })
    const { d } = fakeDelivery()
    expect(receivePlaceEvent(store, "tok_b", { place: p.id, transition: "exit" }, SETTINGS, d, clock)).toMatchObject({ fired: 0 })
    expect(receivePlaceEvent(store, "tok_a", { place: p.id, transition: "exit" }, SETTINGS, d, clock)).toMatchObject({ fired: 1 })
  })

  it("hands an agent reminder to the agent and pushes its answer, or the text when it fails", async () => {
    const p = store.addPlace({ name: "Office", lat: 1, lon: 1, radiusMeters: 150 })
    store.addReminder({ placeId: p.id, on: "enter", text: "What is on my calendar?", agent: "secretary", repeat: true })
    const f = fakeDelivery()
    const r = receivePlaceEvent(store, "tok_a", { place: p.id, transition: "enter", at: clock }, { ...SETTINGS, cooldownMinutes: 0 }, f.d, clock) as any
    await r.delivered
    expect(f.asks[0].agent).toBe("secretary")
    expect(f.asks[0].prompt).toContain('just arrived at "Office"')
    expect(f.pushes[0].body).toBe("Bring the permission slip.")

    f.answer(new Error("agent offline"))
    clock += 1000
    const r2 = receivePlaceEvent(store, "tok_a", { place: p.id, transition: "enter", at: clock }, { ...SETTINGS, cooldownMinutes: 0 }, f.d, clock) as any
    await r2.delivered
    expect(f.pushes[1].body).toBe("What is on my calendar?")
  })

  it("refuses an unknown place or direction", () => {
    const { d } = fakeDelivery()
    expect(receivePlaceEvent(store, "tok_a", { place: "pl_nope", transition: "enter" }, SETTINGS, d)).toMatchObject({ status: 404 })
    expect(receivePlaceEvent(store, "tok_a", { place: "pl_nope", transition: "dwell" }, SETTINGS, d)).toMatchObject({ status: 400 })
    expect(receivePlaceEvent(store, "tok_a", {}, SETTINGS, d)).toMatchObject({ status: 400 })
  })

  it("words the agent prompt for leaving", () => {
    const r = store.addReminder({ placeId: "pl_x", on: "exit", text: "Text Sam" })
    expect(agentPrompt(r, "Home", "exit", 0)).toContain('just left "Home"')
  })
})

describe("places config", () => {
  it("has defaults and builds asset links only with a fingerprint", () => {
    const s = places()
    expect(s).toMatchObject({ enabled: true, defaultRadiusMeters: 150, syncMinutes: 360, android: { packageName: "dev.agentx.phone", sha256CertFingerprints: [] } })
    expect(assetLinks(s)).toBeNull()
    const fp = Array.from({ length: 32 }, () => "ab").join(":")
    const withFp = places({ android: { sha256CertFingerprints: [fp] } })
    expect(assetLinks(withFp)).toEqual([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "dev.agentx.phone", sha256_cert_fingerprints: [fp.toUpperCase()] },
    }])
    expect(() => places({ android: { sha256CertFingerprints: ["nope"] } })).toThrow()
  })
})
