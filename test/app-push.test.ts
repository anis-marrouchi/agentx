import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { RelayedPushState, validEndpoint, type AppPushDeps } from "../src/daemon/app-push"
import { handlePushBridge, pushOrigin, PushRosterSync, ROSTER_RESEND_MS } from "../src/daemon/push-bridge"
import { openDb, closeDb } from "../src/storage/sqlite"
import { PushStore } from "../src/channels/push-store"
import { APP_SERVICE_WORKER, renderAppPage } from "../src/daemon/ui/pages/app"

// /api/app/push* and /api/app/alerts sit behind the same device-token gate
// as the rest of the phone app, and tie each subscription to its phone.

let dir: string
let tokens: TokenStore
let store: PushStore
let server: Server
let base: string
let push: AppPushDeps

beforeAll(async () => {
  closeDb()
  dir = mkdtempSync(join(tmpdir(), "agentx-app-push-"))
  tokens = new TokenStore(dir)
  store = new PushStore(openDb({ path: join(dir, "db.sqlite") })!)
  push = { store: () => store, publicKey: () => "BPUBLICKEY", keepRecent: 10, allowedHosts: ["push.example.com", "fcm.googleapis.com"] }
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleAppRequest(req, res, path, req.method || "GET", { tokens, push })
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

const SUB = { endpoint: "https://push.example.com/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } }

describe("phone app notifications", () => {
  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/push`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/push/subscribe`, { method: "POST", body: JSON.stringify(SUB) })).status).toBe(401)
    expect((await fetch(`${base}/api/app/alerts`)).status).toBe(401)
  })

  it("subscribes, reports it, and unsubscribes only its own", async () => {
    const a = phone("Phone A")
    const b = phone("Phone B")
    expect(await (await a.call("GET", "/api/app/push")).json()).toEqual({ available: true, reason: null, publicKey: "BPUBLICKEY", subscriptions: 0, chatFinish: true, announce: true })
    expect((await a.call("POST", "/api/app/push/subscribe", SUB)).status).toBe(200)
    expect(store.list(a.id)).toMatchObject([{ endpoint: SUB.endpoint, deviceName: "Phone A", publicKey: "BPUBLICKEY" }])
    expect((await (await a.call("GET", "/api/app/push")).json()).subscriptions).toBe(1)

    expect(await (await b.call("POST", "/api/app/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: false })
    expect(store.list()).toHaveLength(1)
    expect(await (await a.call("POST", "/api/app/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: true })
    expect(store.list()).toHaveLength(0)
  })

  it("keeps the finish-notification setting per phone, on by default (#265)", async () => {
    const a = phone("Phone A")
    const b = phone("Phone B")
    expect((await (await a.call("GET", "/api/app/push")).json()).chatFinish).toBe(true)
    expect(await (await a.call("POST", "/api/app/push/prefs", { chatFinish: false })).json()).toEqual({ ok: true, chatFinish: false })
    expect((await (await a.call("GET", "/api/app/push")).json()).chatFinish).toBe(false)
    expect(store.chatFinishOn(a.id)).toBe(false)
    // Another phone keeps its own.
    expect((await (await b.call("GET", "/api/app/push")).json()).chatFinish).toBe(true)
    expect((await a.call("POST", "/api/app/push/prefs", { chatFinish: "no" })).status).toBe(400)
    expect((await fetch(`${base}/api/app/push/prefs`, { method: "POST", body: JSON.stringify({ chatFinish: true }) })).status).toBe(401)
    await a.call("POST", "/api/app/push/prefs", { chatFinish: true })
    expect(store.chatFinishOn(a.id)).toBe(true)
  })

  it("refuses a subscription made with keys the computer no longer has", async () => {
    const a = phone("Phone F")
    expect((await a.call("POST", "/api/app/push/subscribe", { ...SUB, publicKey: "OLDKEY" })).status).toBe(409)
    expect((await a.call("POST", "/api/app/push/subscribe", { ...SUB, publicKey: "BPUBLICKEY" })).status).toBe(200)
    store.subscribe({ ...store.list(a.id)[0], publicKey: "OLDKEY" })
    expect((await (await a.call("GET", "/api/app/push")).json()).subscriptions).toBe(0)
    store.unsubscribe(SUB.endpoint)
  })

  it("rejects endpoints that aren't allowed push services", async () => {
    const a = phone("Phone C")
    for (const endpoint of ["http://push.example.com/x", "https://127.0.0.1/x", "https://localhost./x", "https://evil.example.org/x",
      "https://push.example.com.evil.org/x", "https://push.example.com:8443/x", "https://u:p@push.example.com/x", "not a url"]) {
      expect((await a.call("POST", "/api/app/push/subscribe", { ...SUB, endpoint })).status).toBe(400)
    }
    expect((await a.call("POST", "/api/app/push/subscribe", { endpoint: SUB.endpoint, keys: {} })).status).toBe(400)
    expect(store.list()).toHaveLength(0)
  })

  it("lists recent pushes for the Alerts tab", async () => {
    store.log({ title: "Build failed", body: "nightly", url: "/app#alerts", delivered: 1, deviceId: null }, 10)
    store.log({ title: "Only for another phone", body: "x", url: null, delivered: 1, deviceId: "tok_other" }, 10)
    const body = await (await phone("Phone D").call("GET", "/api/app/alerts")).json()
    expect(body.items).toMatchObject([{ title: "Build failed", body: "nightly", delivered: 1 }])
  })

  it("explains why when this computer can't send", async () => {
    const saved = push
    push = { store: () => null, publicKey: () => null, keepRecent: 0, allowedHosts: [], reason: "Notifications are off." }
    try {
      const a = phone("Phone E")
      expect(await (await a.call("GET", "/api/app/push")).json()).toMatchObject({ available: false, reason: "Notifications are off." })
      expect((await a.call("POST", "/api/app/push/subscribe", SUB)).status).toBe(503)
      push = { ...saved, publicKey: () => null }
      expect((await (await a.call("GET", "/api/app/push")).json()).reason).toMatch(/agentx app push-keys/)
    } finally {
      push = saved
    }
  })
})

describe("a phone paired with a relaying node (#711)", () => {
  // The relay's dashboard forwards; here the host's half (handlePushBridge)
  // answers from `store`, after a JSON round trip like the mesh hop.
  const relayed = (origin = "laptop"): AppPushDeps => {
    const host = push
    return {
      store: () => null, publicKey: () => null, keepRecent: 0, allowedHosts: [], reason: "Can't reach host-node",
      forward: async (call) => handlePushBridge(JSON.parse(JSON.stringify({ op: "app", origin, call })), host),
    }
  }

  it("subscribes on the host under a device id scoped to the relay", async () => {
    const saved = push
    push = relayed()
    try {
      const a = phone("Relay phone")
      expect(await (await a.call("GET", "/api/app/push")).json()).toMatchObject({ available: true, publicKey: "BPUBLICKEY", subscriptions: 0 })
      expect((await a.call("POST", "/api/app/push/subscribe", SUB)).status).toBe(200)
      expect(store.list()).toMatchObject([{ deviceId: `laptop:${a.id}`, deviceName: "Relay phone (laptop)", publicKey: "BPUBLICKEY" }])
      expect((await (await a.call("GET", "/api/app/push")).json()).subscriptions).toBe(1)
      // A stale page still gets the 409 that asks it to subscribe again.
      expect((await a.call("POST", "/api/app/push/subscribe", { ...SUB, publicKey: "OLDKEY" })).status).toBe(409)
      expect(await (await a.call("POST", "/api/app/push/prefs", { announce: false })).json()).toEqual({ ok: true, announce: false })
      expect(store.prefs.on(`laptop:${a.id}`, "announce")).toBe(false)
      store.log({ title: "For this phone", body: "x", url: null, delivered: 1, deviceId: `laptop:${a.id}` }, 10)
      expect((await (await a.call("GET", "/api/app/alerts")).json()).items[0]).toMatchObject({ title: "For this phone" })
      expect(await (await a.call("POST", "/api/app/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: true })
      expect(store.list()).toHaveLength(0)
    } finally {
      push = saved
    }
  })

  it("says why when the host can't be reached", async () => {
    const saved = push
    push = { ...relayed(), forward: async () => { throw new Error("connect ECONNREFUSED") } }
    try {
      const a = phone("Offline relay phone")
      expect(await (await a.call("GET", "/api/app/push")).json()).toMatchObject({ available: false, reason: "Can't reach host-node: connect ECONNREFUSED" })
      expect((await (await a.call("GET", "/api/app/alerts")).json()).items).toEqual([])
      expect((await a.call("POST", "/api/app/push/subscribe", SUB)).status).toBe(502)
    } finally {
      push = saved
    }
  })

  it("drops a relay's phones that left its roster", () => {
    store.subscribe({ endpoint: "https://push.example.com/r1", p256dh: "k", auth: "a", deviceId: "laptop:tok_gone", deviceName: "Gone", publicKey: "BPUBLICKEY" })
    store.subscribe({ endpoint: "https://push.example.com/r2", p256dh: "k", auth: "a", deviceId: "laptop:tok_kept", deviceName: "Kept", publicKey: "BPUBLICKEY" })
    expect(handlePushBridge({ op: "roster", origin: "laptop", active: ["tok_kept"] }, push)).toEqual({ status: 200, body: { ok: true, removed: 1 } })
    expect(store.list().map((s) => s.deviceId)).toEqual(["laptop:tok_kept"])
    store.unsubscribe("https://push.example.com/r2")
  })

  it("refuses a bad origin, device id or path, and answers when push is off", () => {
    const call = { path: "/api/app/push", method: "GET", body: {}, device: { id: "tok_1", name: "P" } }
    expect(handlePushBridge({ op: "app", origin: "bad:name", call }, push).status).toBe(400)
    expect(handlePushBridge({ op: "app", origin: "laptop", call: { ...call, device: { id: "x:y", name: "P" } } }, push).status).toBe(400)
    expect(handlePushBridge({ op: "app", origin: "laptop", call: { ...call, path: "/api/app/chat" } }, push).status).toBe(404)
    expect(handlePushBridge({ op: "roster", origin: "laptop", active: "tok_1" }, push).status).toBe(400)
    expect(handlePushBridge({ op: "app", origin: "laptop", call }, null, "push is off")).toEqual({ status: 503, body: { error: "push is off" } })
    expect(pushOrigin("My Laptop:1")).toBe("My-Laptop-1")
  })
})

describe("RelayedPushState", () => {
  it("remembers what the host said, for finish notifications and the announcement switch", () => {
    const st = new RelayedPushState()
    const call = (path: string, method = "POST") => ({ path, method, body: {}, device: { id: "tok_r", name: "R" } })
    expect(st.finishOn("tok_r")).toBe(false)
    expect(st.on("tok_r", "announce")).toBe(true)
    st.note(call("/api/app/push", "GET"), { status: 200, body: { available: true, subscriptions: 1, chatFinish: true, announce: false } })
    expect(st.finishOn("tok_r")).toBe(true)
    expect(st.on("tok_r", "announce")).toBe(false)
    st.note(call("/api/app/push/prefs"), { status: 200, body: { ok: true, chatFinish: false } })
    expect(st.finishOn("tok_r")).toBe(false)
    expect(st.on("tok_r", "announce")).toBe(false)
    st.note(call("/api/app/push/prefs"), { status: 400, body: { error: "x", chatFinish: true } })
    expect(st.on("tok_r", "finish")).toBe(false)
    st.note(call("/api/app/push/prefs"), { status: 200, body: { ok: true, chatFinish: true } })
    st.note(call("/api/app/push/unsubscribe"), { status: 200, body: { ok: true, removed: true } })
    expect(st.finishOn("tok_r")).toBe(false)
    st.note(call("/api/app/push/subscribe"), { status: 200, body: { ok: true } })
    expect(st.finishOn("tok_r")).toBe(true)
  })
})

describe("PushRosterSync", () => {
  it("sends when the roster changes or is due, and retries a failure", async () => {
    let now = 0
    let active = ["tok_b", "tok_a"]
    let fail = false
    const sent: string[][] = []
    const sync = new PushRosterSync({ active: () => active, now: () => now, send: async (a) => { if (fail) throw new Error("down"); sent.push(a) } })
    expect(await sync.tick()).toBe(true)
    expect(sent).toEqual([["tok_a", "tok_b"]])
    expect(await sync.tick()).toBe(false)
    active = ["tok_a"]
    fail = true
    expect(await sync.tick()).toBe(false)
    fail = false
    expect(await sync.tick()).toBe(true)
    now += ROSTER_RESEND_MS
    expect(await sync.tick()).toBe(true)
    expect(sent).toEqual([["tok_a", "tok_b"], ["tok_a"], ["tok_a"]])
  })
})

describe("validEndpoint", () => {
  it("accepts the default push services and their subdomains", () => {
    const hosts = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"]
    for (const u of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/x", "https://db5p.notify.windows.com/w/?token=x"]) expect(validEndpoint(u, hosts)).toBe(u)
    expect(validEndpoint("https://notfcm.googleapis.com.attacker.io/x", hosts)).toBeNull()
    expect(validEndpoint("https://xpush.apple.com/x", hosts)).toBeNull()
  })
})

describe("service worker and Alerts tab", () => {
  it("shows pushes and opens only web links", () => {
    expect(() => new Function(APP_SERVICE_WORKER)).not.toThrow()
    expect(APP_SERVICE_WORKER).toContain("addEventListener('push'")
    expect(APP_SERVICE_WORKER).toContain("addEventListener('notificationclick'")
    expect(APP_SERVICE_WORKER).toContain("abs.protocol === 'https:' || abs.protocol === 'http:'")
  })

  it("inlines an Alerts script that parses", () => {
    const html = renderAppPage()
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    expect(html).toContain("/api/app/push/subscribe")
  })
})
