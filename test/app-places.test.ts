import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { handlePlacesPanel } from "../src/daemon/places-panel"
import type { AppPlacesDeps } from "../src/daemon/app-places"
import { PlaceStore } from "../src/places/store"
import { daemonConfigSchema } from "../src/daemon/config"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { renderPlacesPage } from "../src/daemon/ui/pages/places"

// /api/app/places* sits behind the phone app's device-token gate; the
// dashboard's /api/admin/places edits the same list (#676).

let dir: string
let tokens: TokenStore
let db: Database.Database
let server: Server
let base: string
let enabled = true
const pushes: Array<{ deviceId: string; title: string; body: string }> = []
const deliveries: Promise<void>[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-places-"))
  tokens = new TokenStore(dir)
  db = new Database(join(dir, "db.sqlite"))
  const settings = () => daemonConfigSchema.shape.places.parse({ enabled })
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const places: AppPlacesDeps = {
      store: () => new PlaceStore(db),
      settings: settings(),
      delivery: { push: async (deviceId, title, body) => { pushes.push({ deviceId, title, body }) }, ask: async () => "" },
      delivering: (p) => { deliveries.push(p) },
    }
    if (await handleAppRequest(req, res, path, req.method || "GET", { tokens, places })) return
    if (await handlePlacesPanel(req, res, path, { db: () => db, settings: settings() })) return
    res.writeHead(418); res.end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(() => {
  server.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function phone(name: string) {
  const { token, record } = tokens.create({ name, scopes: ["app"] })
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json() as any }
  }
  return { id: record.id, call }
}

describe("phone app places", () => {
  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/places`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/places/events`, { method: "POST", body: "{}" })).status).toBe(401)
  })

  it("saves a place, fires its reminder on enter, and pushes to that phone only", async () => {
    const a = phone("Phone A")
    const add = await a.call("POST", "/api/app/places", { name: "School", lat: 48.85, lon: 2.29 })
    expect(add).toMatchObject({ status: 200, body: { place: { name: "School", radiusMeters: 150 } } })
    const placeId = add.body.place.id
    expect((await a.call("POST", "/api/app/places/reminders", { place: placeId, text: "Pick up Sam" })).status).toBe(200)

    const list = await a.call("GET", "/api/app/places")
    expect(list.body).toMatchObject({ enabled: true, places: [{ id: placeId }], reminders: [{ text: "Pick up Sam" }], settings: { responsivenessSeconds: 60, syncMinutes: 360 } })
    expect(typeof list.body.version).toBe("string")

    const ev = await a.call("POST", "/api/app/places/events", { id: "evt-app-0001", place: placeId, transition: "enter", at: new Date().toISOString() })
    expect(ev).toEqual({ status: 200, body: { ok: true, fired: 1 } })
    await Promise.all(deliveries)
    expect(pushes).toEqual([{ deviceId: a.id, title: "Arrived at School", body: "Pick up Sam" }])
    expect((await a.call("GET", "/api/app/places")).body.events).toMatchObject([{ placeName: "School", transition: "enter", fired: 1 }])
  })

  it("answers a removed place with 404 and a bad body with 400", async () => {
    const a = phone("Phone B")
    expect((await a.call("POST", "/api/app/places/events", { place: "pl_gone", transition: "enter" })).status).toBe(404)
    expect((await a.call("POST", "/api/app/places", { name: "", lat: 0, lon: 0 })).status).toBe(400)
    expect((await a.call("POST", "/api/app/places/nope", {})).status).toBe(404)
  })

  it("tells the phone to drop its geofences when place reminders are off", async () => {
    const a = phone("Phone C")
    enabled = false
    try {
      expect((await a.call("GET", "/api/app/places")).body).toMatchObject({ enabled: false, places: [], version: "off" })
      expect((await a.call("POST", "/api/app/places/events", { place: "x", transition: "enter" })).status).toBe(409)
    } finally {
      enabled = true
    }
  })
})

describe("dashboard places", () => {
  const admin = (method: string, path: string, body?: unknown, xrw = true) => fetch(`${base}${path}`, {
    method,
    headers: { ...(xrw ? { "X-Requested-With": "agentx-board" } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

  it("serves the page and edits the same list", async () => {
    const page = await admin("GET", "/places")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("Add a place")
    expect((await admin("POST", "/api/admin/places", { name: "Gym", lat: 1, lon: 1 }, false)).status).toBe(400)
    const r = await admin("POST", "/api/admin/places", { name: "Gym", lat: 1, lon: 1, radiusMeters: 300 })
    expect(r.status).toBe(200)
    const body = await (await admin("GET", "/api/admin/places")).json() as any
    expect(body.places.map((p: any) => p.name)).toContain("Gym")
    expect(body.events.length).toBeGreaterThan(0)
  })
})

describe("pages", () => {
  it("inlines the Places card into the phone app without breaking its scripts", () => {
    const html = renderAppPage()
    expect(html).toContain("pl-card")
    expect(html).toContain("/api/app/places")
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow()
    for (const m of renderPlacesPage().matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow()
  })
})
