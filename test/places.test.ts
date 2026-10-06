import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { assetLinks, handleDashboardPlaces, type PlacesDeps } from "../src/daemon/app-places"
import { PlaceStore, parsePlaceEvent, parsePlaceInput, parseRuleInput, type PlaceLimits } from "../src/places/store"
import { fireRules, placeTitle, taskMessage, type FireDeps } from "../src/places/fire"
import { daemonConfigSchema } from "../src/daemon/config"
import { APP_PLACES_SCRIPT } from "../src/daemon/ui/pages/app-places.client"
import { locationErrorText } from "../src/daemon/ui/pages/app-places-logic"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { renderPlacesPage } from "../src/daemon/ui/pages/places"

const LIMITS: PlaceLimits = {
  minRadiusMeters: 100, maxRadiusMeters: 5000, defaultRadiusMeters: 150,
  maxPlaces: 3, maxRulesPerPlace: 2, cooldownMinutes: 10, maxEventAgeMinutes: 30,
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-places-")) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function freshStore(now: () => number = Date.now) {
  return new PlaceStore(join(dir, `places-${++n}.json`), now)
}

describe("parsePlaceInput", () => {
  it("accepts a place and rounds coordinates", () => {
    const r = parsePlaceInput({ name: " School ", lat: "48.12345678", lng: 2.5, radius: "200" }, LIMITS)
    expect(r).toEqual({ ok: true, value: { name: "School", lat: 48.123457, lng: 2.5, radius: 200 } })
  })
  it("uses the default radius when none is given", () => {
    const r = parsePlaceInput({ name: "Gym", lat: 1, lng: 2 }, LIMITS)
    expect(r.ok && r.value.radius).toBe(150)
  })
  it("refuses bad names, coordinates and radii", () => {
    expect(parsePlaceInput({ name: "", lat: 1, lng: 2 }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "x".repeat(61), lat: 1, lng: 2 }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "A", lat: 91, lng: 2 }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "A", lat: 1, lng: "east" }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "A", lat: "", lng: 2 }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "A", lat: 1, lng: 2, radius: 20 }, LIMITS).ok).toBe(false)
    expect(parsePlaceInput({ name: "A", lat: 1, lng: 2, radius: 9000 }, LIMITS).ok).toBe(false)
  })
})

describe("parseRuleInput", () => {
  const has = (id: string) => id === "helper"
  it("accepts a reminder and a task", () => {
    expect(parseRuleInput({ placeId: "pl_abcdef12", text: "Buy bread" }, has))
      .toEqual({ ok: true, value: { placeId: "pl_abcdef12", on: "enter", text: "Buy bread", repeat: false } })
    expect(parseRuleInput({ placeId: "pl_abcdef12", on: "exit", text: "Summarise", agent: "helper", repeat: true }, has))
      .toEqual({ ok: true, value: { placeId: "pl_abcdef12", on: "exit", text: "Summarise", agent: "helper", repeat: true } })
  })
  it("refuses an unknown agent, a bad direction and empty text", () => {
    expect(parseRuleInput({ placeId: "pl_abcdef12", text: "x", agent: "nobody" }, has).ok).toBe(false)
    expect(parseRuleInput({ placeId: "pl_abcdef12", text: "x", on: "near" }, has).ok).toBe(false)
    expect(parseRuleInput({ placeId: "pl_abcdef12", text: "  " }, has).ok).toBe(false)
    expect(parseRuleInput({ placeId: "../etc", text: "x" }, has).ok).toBe(false)
  })
})

describe("parsePlaceEvent", () => {
  it("reads only id, place, transition and time", () => {
    const r = parsePlaceEvent({ id: "evt-12345678", place: "pl_abcdef12", transition: "enter", time: 1000, lat: 1, lng: 2 })
    expect(r).toEqual({ ok: true, value: { id: "evt-12345678", place: "pl_abcdef12", transition: "enter", time: 1000 } })
  })
  it("refuses malformed events", () => {
    expect(parsePlaceEvent({ id: "short", place: "pl_abcdef12", transition: "enter", time: 1 }).ok).toBe(false)
    expect(parsePlaceEvent({ id: "evt-12345678", place: "pl_abcdef12", transition: "dwell", time: 1 }).ok).toBe(false)
    expect(parsePlaceEvent({ id: "evt-12345678", place: "pl_abcdef12", transition: "exit", time: "soon" }).ok).toBe(false)
  })
})

describe("PlaceStore", () => {
  it("adds, limits and removes places with their rules", () => {
    const s = freshStore()
    const a = s.addPlace({ name: "A", lat: 1, lng: 1, radius: 150 }, LIMITS)
    expect(a.ok).toBe(true)
    expect(s.addPlace({ name: "a", lat: 1, lng: 1, radius: 150 }, LIMITS).ok).toBe(false)
    s.addPlace({ name: "B", lat: 1, lng: 1, radius: 150 }, LIMITS)
    s.addPlace({ name: "C", lat: 1, lng: 1, radius: 150 }, LIMITS)
    expect(s.addPlace({ name: "D", lat: 1, lng: 1, radius: 150 }, LIMITS).ok).toBe(false)
    const id = a.ok ? a.place.id : ""
    s.addRule({ placeId: id, on: "enter", text: "x", repeat: false }, LIMITS)
    s.addRule({ placeId: id, on: "enter", text: "y", repeat: false }, LIMITS)
    expect(s.addRule({ placeId: id, on: "enter", text: "z", repeat: false }, LIMITS).ok).toBe(false)
    expect(s.removePlace(id)).toBe(true)
    expect(s.read().rules).toEqual([])
    expect(s.read().places.map((p) => p.name)).toEqual(["B", "C"])
  })

  it("fires a one-time rule once, and a retried report not at all", () => {
    let now = 1_000_000_000
    const s = freshStore(() => now)
    const p = s.addPlace({ name: "School", lat: 1, lng: 1, radius: 150 }, LIMITS)
    const place = p.ok ? p.place.id : ""
    s.addRule({ placeId: place, on: "enter", text: "Pick up", repeat: false }, LIMITS)
    s.addRule({ placeId: place, on: "exit", text: "Bye", repeat: false }, LIMITS)
    const ev = { id: "evt-00000001", place, transition: "enter" as const, time: now }
    const first = s.accept(ev, LIMITS)
    expect(first.status).toBe("fired")
    expect(first.status === "fired" && first.rules.map((r) => r.text)).toEqual(["Pick up"])
    expect(s.accept(ev, LIMITS).status).toBe("duplicate")
    now += 3_600_000
    expect(s.accept({ ...ev, id: "evt-00000002", time: now }, LIMITS).status).toBe("no-rules")
    expect(s.read().rules.find((r) => r.text === "Pick up")!.enabled).toBe(false)
  })

  it("keeps a repeating rule on, with a cooldown", () => {
    let now = 2_000_000_000
    const s = freshStore(() => now)
    const p = s.addPlace({ name: "Home", lat: 1, lng: 1, radius: 150 }, LIMITS)
    const place = p.ok ? p.place.id : ""
    s.addRule({ placeId: place, on: "enter", text: "Water plants", repeat: true }, LIMITS)
    expect(s.accept({ id: "evt-r0000001", place, transition: "enter", time: now }, LIMITS).status).toBe("fired")
    now += 5 * 60_000
    expect(s.accept({ id: "evt-r0000002", place, transition: "enter", time: now }, LIMITS).status).toBe("no-rules")
    now += 6 * 60_000
    expect(s.accept({ id: "evt-r0000003", place, transition: "enter", time: now }, LIMITS).status).toBe("fired")
  })

  it("drops reports that are too old or name an unknown place", () => {
    const now = 3_000_000_000
    const s = freshStore(() => now)
    const p = s.addPlace({ name: "Office", lat: 1, lng: 1, radius: 150 }, LIMITS)
    const place = p.ok ? p.place.id : ""
    s.addRule({ placeId: place, on: "enter", text: "x", repeat: true }, LIMITS)
    expect(s.accept({ id: "evt-o0000001", place, transition: "enter", time: now - 31 * 60_000 }, LIMITS).status).toBe("too-old")
    expect(s.accept({ id: "evt-o0000002", place: "pl_missing00", transition: "enter", time: now }, LIMITS).status).toBe("unknown-place")
  })

  it("keeps the file private to the user", () => {
    const s = freshStore()
    s.addPlace({ name: "A", lat: 1, lng: 1, radius: 150 }, LIMITS)
    const path = join(dir, `places-${n}.json`)
    expect(JSON.parse(readFileSync(path, "utf-8")).places).toHaveLength(1)
  })
})

describe("fireRules", () => {
  const place = { id: "pl_abcdef12", name: "School", lat: 1, lng: 1, radius: 150, createdAt: "" }
  const rule = (over: object = {}) => ({ id: "pr_abcdef12", placeId: place.id, on: "enter" as const, text: "Pick up the kids", repeat: false, enabled: true, createdAt: "", ...over })

  it("pushes the reminder text to the phone that crossed", async () => {
    const pushed: unknown[] = []
    const deps: FireDeps = { push: async (...a) => { pushed.push(a) }, task: async () => "unused", log: () => {} }
    await fireRules("tok_phone", place, [rule()], 0, deps)
    expect(pushed).toEqual([["tok_phone", "Arrived at School", "Pick up the kids"]])
  })

  it("runs a task and pushes the agent's answer, or the failure", async () => {
    const pushed: unknown[] = []
    const tasks: unknown[] = []
    const ok: FireDeps = { push: async (...a) => { pushed.push(a) }, task: async (...a) => { tasks.push(a); return " Traffic is light. " }, log: () => {} }
    await fireRules("tok_phone", place, [rule({ agent: "helper", on: "exit" })], Date.UTC(2026, 0, 1, 8, 5), ok)
    expect(pushed).toEqual([["tok_phone", "Left School", "Traffic is light."]])
    expect((tasks[0] as unknown[])[0]).toBe("helper")
    expect((tasks[0] as unknown[])[1]).toContain("the owner left School · 2026-01-01 08:05 UTC")
    const bad: FireDeps = { ...ok, task: async () => { throw new Error("budget cap") } }
    pushed.length = 0
    await fireRules("tok_phone", place, [rule({ agent: "helper" })], 0, bad)
    expect((pushed[0] as string[])[2]).toContain("helper couldn't run this: budget cap")
  })

  it("titles and task text name the place and direction", () => {
    expect(placeTitle(place, "exit")).toBe("Left School")
    expect(taskMessage(place, rule(), 0)).toContain("Pick up the kids")
  })
})

describe("/api/app/places and /api/places", () => {
  let tokens: TokenStore
  let server: Server
  let base: string
  let deps: PlacesDeps
  let fired: unknown[]

  beforeAll(async () => {
    tokens = new TokenStore(dir)
    server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname
      const handled = await handleAppRequest(req, res, path, req.method || "GET", { tokens, places: deps, assetLinks: () => null })
        || await handleDashboardPlaces(req, res, path, req.method || "GET", deps)
      if (!handled) { res.writeHead(418); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => server.close())
  beforeEach(() => {
    fired = []
    deps = {
      enabled: true, limits: LIMITS, syncMinutes: 60, store: freshStore(), agents: () => ["helper"],
      fire: { push: async (...a) => { fired.push(a) }, task: async () => "answer", log: () => {} },
      androidPackage: "dev.agentx.phone", log: () => {},
    }
  })

  function phone() {
    const { token, record } = tokens.create({ name: "Test phone", scopes: ["app"] })
    const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { id: record.id, call }
  }

  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/places`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/places/event`, { method: "POST", body: "{}" })).status).toBe(401)
  })

  it("adds a place and a reminder, and an event pushes it to that phone", async () => {
    const p = phone()
    const add = await (await p.call("POST", "/api/app/places/add", { name: "School", lat: 48.85, lng: 2.35 })).json()
    expect(add.place.radius).toBe(150)
    const rule = await p.call("POST", "/api/app/places/rules/add", { placeId: add.place.id, text: "Pick up the parcel" })
    expect(rule.status).toBe(200)
    const state = await (await p.call("GET", "/api/app/places")).json()
    expect(state).toMatchObject({ enabled: true, pushAvailable: true, syncMinutes: 60, android: { packageName: "dev.agentx.phone" }, agents: ["helper"] })
    expect(state.places).toHaveLength(1)
    const ev = await p.call("POST", "/api/app/places/event", { id: "evt-http0001", place: add.place.id, transition: "enter", time: Date.now() })
    expect(ev.status).toBe(202)
    expect(await ev.json()).toEqual({ ok: true, status: "fired", fired: 1 })
    await new Promise((r) => setTimeout(r, 20))
    expect(fired).toEqual([[p.id, "Arrived at School", "Pick up the parcel"]])
    const again = await (await p.call("POST", "/api/app/places/event", { id: "evt-http0001", place: add.place.id, transition: "enter", time: Date.now() })).json()
    expect(again.status).toBe("duplicate")
  })

  it("refuses a malformed event and an unknown agent", async () => {
    const p = phone()
    expect((await p.call("POST", "/api/app/places/event", { id: "evt-http0002", place: "pl_abcdef12", transition: "near", time: 1 })).status).toBe(400)
    const add = await (await p.call("POST", "/api/app/places/add", { name: "Gym", lat: 1, lng: 1 })).json()
    expect((await p.call("POST", "/api/app/places/rules/add", { placeId: add.place.id, text: "x", agent: "nobody" })).status).toBe(400)
  })

  it("says when places are off, and refuses changes", async () => {
    deps.enabled = false
    const p = phone()
    const state = await (await p.call("GET", "/api/app/places")).json()
    expect(state.enabled).toBe(false)
    expect(state.reason).toContain("app.places.enabled")
    expect((await p.call("POST", "/api/app/places/add", { name: "A", lat: 1, lng: 1 })).status).toBe(403)
  })

  it("serves the same store to the dashboard, without the event route", async () => {
    const r = await fetch(`${base}/api/places/add`, { method: "POST", body: JSON.stringify({ name: "Library", lat: 10, lng: 20, radius: 300 }) })
    expect(r.status).toBe(200)
    const state = await (await fetch(`${base}/api/places`)).json()
    expect(state.places[0]).toMatchObject({ name: "Library", radius: 300 })
    const ev = await fetch(`${base}/api/places/event`, { method: "POST", body: JSON.stringify({ id: "evt-dash0001", place: state.places[0].id, transition: "enter", time: Date.now() }) })
    expect(ev.status).toBe(404)
  })

  it("answers assetlinks.json with 404 when no fingerprint is set", async () => {
    expect((await fetch(`${base}/.well-known/assetlinks.json`)).status).toBe(404)
  })
})

describe("assetLinks", () => {
  it("vouches for the configured package and fingerprints only", () => {
    const fp = Array.from({ length: 32 }, () => "ab").join(":")
    const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, app: { android: { packageName: "org.example.phone", certFingerprints: [fp] } } })
    expect(assetLinks(config)).toEqual([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "org.example.phone", sha256_cert_fingerprints: [fp.toUpperCase()] },
    }])
    expect(assetLinks(daemonConfigSchema.parse({ node: { id: "n", name: "n" } }))).toBeNull()
  })
  it("refuses a malformed fingerprint", () => {
    expect(() => daemonConfigSchema.parse({ node: { id: "n", name: "n" }, app: { android: { certFingerprints: ["AB:CD"] } } })).toThrow()
  })
})

describe("location error text (#708)", () => {
  it("in the Android app, a refusal while the permission reads prompt means Chrome hasn't linked the app", () => {
    expect(locationErrorText(1, true, "prompt")).toContain("Force stop Chrome")
    expect(locationErrorText(1, true, "granted")).toContain("Force stop Chrome")
    expect(locationErrorText(1, true, "")).toContain("Force stop Chrome")
    // "Don't allow" can leave the state at prompt, so the text covers it too.
    expect(locationErrorText(1, true, "prompt")).toContain("If you tapped Don’t allow")
  })
  it("a real denial, or a refusal in a browser, says the location is blocked", () => {
    expect(locationErrorText(1, true, "denied")).toContain("Location is blocked")
    expect(locationErrorText(1, false, "prompt")).toContain("Location is blocked")
  })
  it("other failures say the position wasn't found", () => {
    expect(locationErrorText(2, true, "prompt")).toContain("Could not find where you are")
    expect(locationErrorText(3, false, "")).toContain("Could not find where you are")
  })
})

describe("pages", () => {
  it("the phone app carries the Places card", () => {
    const html = renderAppPage()
    expect(html).toContain(APP_PLACES_SCRIPT)
    expect(() => new Function(APP_PLACES_SCRIPT)).not.toThrow()
    // The card calls the helper; it must ship in the same script.
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((js) => js.includes("pl-here"))!
    expect(script).toContain("const locationErrorText=")
    expect(() => new Function(script)).not.toThrow()
  })
  it("the dashboard page renders with a parseable script", () => {
    const html = renderPlacesPage({})
    expect(html).toContain("Add a place")
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((js) => js.includes("pl-msg"))!
    expect(() => new Function(script)).not.toThrow()
  })
})
