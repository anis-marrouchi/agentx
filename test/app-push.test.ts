import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import type { AppPushDeps } from "../src/daemon/app-push"
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
  push = { store: () => store, publicKey: () => "BPUBLICKEY", keepRecent: 10 }
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
    expect(await (await a.call("GET", "/api/app/push")).json()).toEqual({ available: true, reason: null, publicKey: "BPUBLICKEY", subscriptions: 0 })
    expect((await a.call("POST", "/api/app/push/subscribe", SUB)).status).toBe(200)
    expect(store.list(a.id)).toMatchObject([{ endpoint: SUB.endpoint, deviceName: "Phone A" }])
    expect((await (await a.call("GET", "/api/app/push")).json()).subscriptions).toBe(1)

    expect(await (await b.call("POST", "/api/app/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: false })
    expect(store.list()).toHaveLength(1)
    expect(await (await a.call("POST", "/api/app/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: true })
    expect(store.list()).toHaveLength(0)
  })

  it("rejects endpoints that aren't public https push services", async () => {
    const a = phone("Phone C")
    for (const endpoint of ["http://push.example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "not a url"]) {
      expect((await a.call("POST", "/api/app/push/subscribe", { ...SUB, endpoint })).status).toBe(400)
    }
    expect((await a.call("POST", "/api/app/push/subscribe", { endpoint: SUB.endpoint, keys: {} })).status).toBe(400)
    expect(store.list()).toHaveLength(0)
  })

  it("lists recent pushes for the Alerts tab", async () => {
    store.log({ title: "Build failed", body: "nightly", url: "/app#alerts", delivered: 1 }, 10)
    const body = await (await phone("Phone D").call("GET", "/api/app/alerts")).json()
    expect(body.items).toMatchObject([{ title: "Build failed", body: "nightly", delivered: 1 }])
  })

  it("explains why when this computer can't send", async () => {
    const saved = push
    push = { store: () => null, publicKey: () => null, keepRecent: 0, reason: "Notifications are off." }
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
