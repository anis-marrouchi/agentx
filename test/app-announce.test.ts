import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { ANNOUNCE_LIST_MAX, ANNOUNCE_TEXT_MAX, toAnnouncements, type AppAnnounceDeps } from "../src/daemon/app-announce"
import { openDb, closeDb } from "../src/storage/sqlite"
import { PushStore } from "../src/channels/push-store"
import { PushPrefs } from "../src/channels/push-prefs"
import { ANNOUNCE_PREF, ANNOUNCE_PUSH_MAX, attachAnnouncePush } from "../src/channels/push-announce"
import { TypedEventBus } from "../src/events/bus"
import type { OutgoingMessage } from "../src/channels/types"
import { APP_ANNOUNCE_SCRIPT } from "../src/daemon/ui/pages/app-announce.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"

let dir: string
let tokens: TokenStore
let store: PushStore
let prefs: PushPrefs
let server: Server
let base: string
let events: unknown[] = []
let recentFails = false
let prefsOn = true

beforeAll(async () => {
  closeDb()
  dir = mkdtempSync(join(tmpdir(), "agentx-app-announce-"))
  tokens = new TokenStore(dir)
  const db = openDb({ path: join(dir, "db.sqlite") })!
  store = new PushStore(db)
  prefs = new PushPrefs(db)
  const announce: AppAnnounceDeps = {
    recent: async () => { if (recentFails) throw new Error("daemon down"); return events },
    prefs: () => (prefsOn ? prefs : null),
  }
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleAppRequest(req, res, path, req.method || "GET", { tokens, announce })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(() => {
  server.close()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function phone(name: string) {
  const { token, record } = tokens.create({ name, scopes: ["app"] })
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { id: record.id, call }
}

const env = (i: number, over: Record<string, unknown> = {}) => ({
  id: `ev${i}`, rootId: `ev${i}`, node: "node-a", kind: "announce", type: "announce",
  at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), summary: `note ${i}`, ...over,
})

describe("GET /api/app/announcements", () => {
  beforeEach(() => { events = []; recentFails = false; prefsOn = true })

  it("needs a paired phone, and not a token without the app scope", async () => {
    expect((await fetch(`${base}/api/app/announcements`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/announcements/notify`, { method: "POST", body: "{\"on\":false}" })).status).toBe(401)
    const { token } = tokens.create({ name: "dash", scopes: ["dashboard:read"] })
    expect((await fetch(`${base}/api/app/announcements`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it("lists newest first, at most 50, with only short fields", async () => {
    events = Array.from({ length: 70 }, (_, i) => env(i, { agentId: i === 69 ? "helper" : undefined, ref: "secret-trace" }))
    events.push({ ...env(99), kind: "agent" })
    const b = await (await phone("A").call("GET", "/api/app/announcements")).json()
    expect(b.items).toHaveLength(ANNOUNCE_LIST_MAX)
    expect(b.items[0]).toEqual({ id: "ev69", text: "note 69", by: "helper", node: "node-a", at: env(69).at })
    expect(b.items[1].by).toBeNull()
    expect(b.items.some((it: any) => it.id === "ev99")).toBe(false)
    expect(JSON.stringify(b)).not.toContain("secret-trace")
    expect(b).toMatchObject({ error: null, notify: true, notifyAvailable: true })
  })

  it("caps the text", () => {
    const [it] = toAnnouncements([env(1, { summary: "x".repeat(5000) })])
    expect([...it.text].length).toBe(ANNOUNCE_TEXT_MAX)
    expect(it.text.endsWith("…")).toBe(true)
  })

  it("reports an unreachable daemon without failing the tab", async () => {
    recentFails = true
    const r = await phone("B").call("GET", "/api/app/announcements")
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ items: [], error: "daemon down" })
  })
})

describe("notify toggle", () => {
  beforeEach(() => { prefsOn = true })

  it("defaults to on and is kept per phone", async () => {
    const a = phone("C")
    const b = phone("D")
    expect((await (await a.call("GET", "/api/app/announcements")).json()).notify).toBe(true)
    expect(await (await a.call("POST", "/api/app/announcements/notify", { on: false })).json()).toEqual({ ok: true, notify: false })
    expect((await (await a.call("GET", "/api/app/announcements")).json()).notify).toBe(false)
    expect((await (await b.call("GET", "/api/app/announcements")).json()).notify).toBe(true)
    expect(prefs.get(a.id, ANNOUNCE_PREF, true)).toBe(false)
  })

  it("refuses a bad body, and is unavailable where push isn't hosted", async () => {
    const a = phone("E")
    expect((await a.call("POST", "/api/app/announcements/notify", { on: "yes" })).status).toBe(400)
    prefsOn = false
    expect((await a.call("POST", "/api/app/announcements/notify", { on: true })).status).toBe(503)
    expect(await (await a.call("GET", "/api/app/announcements")).json()).toMatchObject({ notify: false, notifyAvailable: false })
  })
})

describe("attachAnnouncePush", () => {
  const START = Date.UTC(2026, 5, 1, 12, 0)
  let bus: TypedEventBus
  let sent: OutgoingMessage[]
  let now: number

  function setup(devices: string[]) {
    closeDb()
    const d = mkdtempSync(join(tmpdir(), "agentx-announce-push-"))
    const db = openDb({ path: join(d, "db.sqlite") })!
    const s = new PushStore(db)
    const p = new PushPrefs(db)
    devices.forEach((id, i) => s.subscribe({ endpoint: `https://push.example.com/${i}`, p256dh: "k", auth: "a", deviceId: id, deviceName: id, publicKey: "pub" }))
    // A second browser on the same phone still gets one push per phone.
    if (devices[0]) s.subscribe({ endpoint: "https://push.example.com/extra", p256dh: "k", auth: "a", deviceId: devices[0], deviceName: devices[0], publicKey: "pub" })
    bus = new TypedEventBus().configure({ node: "host" })
    sent = []
    now = START + 60_000
    attachAnnouncePush({
      bus, store: s, prefs: p, startedAt: START, now: () => now,
      send: async (m) => { sent.push(m) },
    })
    return { prefs: p, cleanup: () => { closeDb(); rmSync(d, { recursive: true, force: true }) } }
  }
  const peer = (id: string, atMs: number, over: Record<string, unknown> = {}) => ({
    id, rootId: id, node: "peer", kind: "announce", type: "announce", at: new Date(atMs).toISOString(), summary: "deploy at noon", ...over,
  })

  it("pushes a new announcement once to each phone, local or from a peer", async () => {
    const { cleanup } = setup(["tok_a", "tok_b"])
    bus.publish({ kind: "announce", type: "announce", summary: "maintenance tonight", at: new Date(now).toISOString() })
    expect(sent.map((m) => m.chatId).sort()).toEqual(["tok_a", "tok_b"])
    expect(sent[0].text).toBe("Announcement\nmaintenance tonight")
    sent = []
    bus.ingest(peer("p1", now, { agentId: "helper" }) as any)
    bus.ingest(peer("p1", now, { agentId: "helper" }) as any)
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toBe("Announcement\nhelper: deploy at noon")
    cleanup()
  })

  it("dedups by node and id even when the event arrives twice", async () => {
    const { cleanup } = setup(["tok_a"])
    const e = peer("p2", now)
    bus.publish({ ...e, node: undefined } as any)
    bus.publish({ id: "p2", kind: "announce", type: "announce", summary: "again", at: e.at })
    expect(sent).toHaveLength(1)
    cleanup()
  })

  it("respects the per-phone toggle", async () => {
    const { prefs: p, cleanup } = setup(["tok_a", "tok_b"])
    p.set("tok_b", ANNOUNCE_PREF, false)
    bus.ingest(peer("p3", now) as any)
    expect(sent.map((m) => m.chatId)).toEqual(["tok_a"])
    cleanup()
  })

  it("skips replays from before start and stale catch-up", async () => {
    const { cleanup } = setup(["tok_a"])
    bus.ingest(peer("old", START - 1000) as any)
    now = START + 60 * 60_000
    bus.ingest(peer("stale", START + 5 * 60_000) as any)
    bus.ingest(peer("bad", 0, { at: "not a date" }) as any)
    bus.publish({ kind: "agent", type: "task:started", summary: "x", at: new Date(now).toISOString() })
    expect(sent).toHaveLength(0)
    bus.ingest(peer("fresh", now - 1000) as any)
    expect(sent).toHaveLength(1)
    cleanup()
  })

  it("caps the body and keeps going when one phone fails", async () => {
    const { cleanup } = setup([])
    closeDb()
    const d = mkdtempSync(join(tmpdir(), "agentx-announce-push2-"))
    const db = openDb({ path: join(d, "db.sqlite") })!
    const s = new PushStore(db)
    for (const id of ["tok_x", "tok_y"]) s.subscribe({ endpoint: `https://push.example.com/${id}`, p256dh: "k", auth: "a", deviceId: id, deviceName: id, publicKey: "pub" })
    const b = new TypedEventBus().configure({ node: "host" })
    const got: string[] = []
    const logs: string[] = []
    attachAnnouncePush({
      bus: b, store: s, prefs: new PushPrefs(db), startedAt: 0, log: (m) => logs.push(String(m)),
      send: async (m) => { if (m.chatId === "tok_x") throw new Error("gone"); got.push(m.text) },
    })
    b.publish({ kind: "announce", type: "announce", summary: "y".repeat(400) })
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toHaveLength(1)
    expect([...got[0].split("\n")[1]].length).toBe(ANNOUNCE_PUSH_MAX)
    expect(logs.join(" ")).toContain("tok_x")
    closeDb()
    rmSync(d, { recursive: true, force: true })
    cleanup()
  })
})

describe("announcements script", () => {
  it("parses and never writes text through innerHTML", () => {
    expect(() => new Function(APP_ANNOUNCE_SCRIPT)).not.toThrow()
    expect(APP_ANNOUNCE_SCRIPT).not.toMatch(/innerHTML|\\|`|\$\{/)
    expect(renderAppPage()).toContain("an-card")
  })
})
