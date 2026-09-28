import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { validEndpoint, type AppPushDeps } from "../src/daemon/app-push"
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
    expect(await (await a.call("GET", "/api/app/push")).json()).toEqual({ available: true, reason: null, publicKey: "BPUBLICKEY", subscriptions: 0, chatFinish: true })
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
