import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import QRCode from "qrcode"
import { TokenStore } from "../src/daemon/token-store"
import { APP_COOKIE, handleAppRequest } from "../src/daemon/app-routes"
import { APP_SERVICE_WORKER, renderAppLockedPage } from "../src/daemon/ui/pages/app"
import { LOCKED_HELPERS } from "../src/daemon/ui/pages/app-locked.client"

// #234: paired phones kept landing on the locked page. The cookie is now
// SameSite=Lax, the locked page and the service worker check /api/app/me
// before giving up on a paired phone, 401s are traced, and the locked page
// can scan the pairing QR code itself.

let dir: string
let store: TokenStore
let server: Server
let base: string
const logs: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-234-"))
  store = new TokenStore(dir)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const log = (line: string) => { logs.push(line) }
    if (!await handleAppRequest(req, res, path, req.method || "GET", { tokens: store, log })) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("session cookie", () => {
  it("is SameSite=Lax, still Secure and HttpOnly", async () => {
    const { token } = store.create({ name: "Phone", scopes: ["app"] })
    const r = await fetch(`${base}/api/app/session`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    const set = r.headers.get("set-cookie") || ""
    for (const attr of ["SameSite=Lax", "Secure", "HttpOnly", "Path=/"]) expect(set).toContain(attr)
    expect(set).not.toContain("Strict")
  })

  it("is set again on each app load, so phones paired under Strict move to Lax", async () => {
    const { token } = store.create({ name: "Old phone", scopes: ["app"] })
    const r = await fetch(`${base}/app`, { headers: { Cookie: `${APP_COOKIE}=${token}` } })
    expect(r.status).toBe(200)
    expect(r.headers.get("set-cookie")).toMatch(new RegExp(`^${APP_COOKIE}=${token};.*SameSite=Lax`))
    const byHeader = await fetch(`${base}/app`, { headers: { Authorization: `Bearer ${token}` } })
    expect(byHeader.headers.get("set-cookie")).toBeNull()
  })
})

describe("401 trace", () => {
  it("tells no cookie from an invalid one, without logging secrets", async () => {
    const { token, record } = store.create({ name: "Gone", scopes: ["app"] })
    store.revoke(record.id)
    logs.length = 0
    await fetch(`${base}/app`, { headers: { Cookie: "other=secret-value", "Sec-Fetch-Site": "none" } })
    await fetch(`${base}/app`, { headers: { Cookie: `${APP_COOKIE}=${token}` } })
    await fetch(`${base}/api/app/me`, { headers: { Authorization: `Bearer ${token}` } })
    expect(logs[0]).toMatch(/^\[app\] 401 GET \/app: no cookie \(1 other cookies\) \(fetch-site none, mode \w+\)$/)
    expect(logs[1]).toContain("cookie not valid")
    expect(logs[2]).toContain("bearer token not valid")
    for (const line of logs) {
      expect(line).not.toContain(token)
      expect(line).not.toContain("secret-value")
    }
  })

  it("logs when the locked page's probe finds the phone paired", async () => {
    const { token, record } = store.create({ name: "Probe phone", scopes: ["app"] })
    logs.length = 0
    const r = await fetch(`${base}/api/app/me`, { headers: { Cookie: `${APP_COOKIE}=${token}`, "X-AgentX-Probe": "locked" } })
    expect(r.status).toBe(200)
    expect(logs).toEqual([`[app] locked page recovered ${record.id} (Probe phone): the cookie came back on a fetch`])
  })
})

// --- Service worker, run against fake caches and network ---

type Handler = (e: any) => void
function runWorker(network: (url: string) => Response) {
  const handlers: Record<string, Handler> = {}
  const cache = new Map<string, Response>()
  const self = { location: { origin: "https://phone.ts.net" }, addEventListener: (t: string, h: Handler) => { handlers[t] = h } }
  const store = { put: async (k: string, v: Response) => { cache.set(k, v) }, delete: async (k: string) => cache.delete(k) }
  const caches = {
    open: async () => store,
    match: async (k: string) => cache.get(k)?.clone(),
    keys: async () => [],
  }
  const fetchFn = async (req: any) => network(typeof req === "string" ? req : req.url)
  new Function("self", "caches", "fetch", APP_SERVICE_WORKER)(self, caches, fetchFn)
  const navigate = async (): Promise<Response> => {
    let out: Promise<Response> | undefined
    handlers.fetch({ request: { method: "GET", mode: "navigate", url: "https://phone.ts.net/app" }, respondWith: (p: Promise<Response>) => { out = p } })
    const res = await out!
    await new Promise((r) => setTimeout(r, 0)) // let the cache writes land
    return res
  }
  return { cache, navigate }
}

const page = (status: number, body: string) => new Response(body, { status })

describe("service worker keeps a paired shell through one cookie-less load", () => {
  it("serves the cached shell when the page load is 401 but /api/app/me works", async () => {
    let appStatus = 200
    const w = runWorker((url) => url.endsWith("/api/app/me") ? page(200, "{}") : page(appStatus, appStatus === 200 ? "shell" : "locked"))
    expect(await (await w.navigate()).text()).toBe("shell")
    appStatus = 401
    const res = await w.navigate()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("shell")
    expect(w.cache.has("/app")).toBe(true)
  })

  it("locks the app when /api/app/me is refused too", async () => {
    let appStatus = 200
    const w = runWorker((url) => url.endsWith("/api/app/me") ? page(401, "{}") : page(appStatus, appStatus === 200 ? "shell" : "locked"))
    await w.navigate()
    appStatus = 401
    const res = await w.navigate()
    expect(res.status).toBe(401)
    expect(await res.text()).toBe("locked")
    expect(w.cache.has("/app")).toBe(false)
    expect(w.cache.has("/app/locked")).toBe(true)
  })
})

describe("locked page", () => {
  const helpers = new Function(`${LOCKED_HELPERS}; return { formatCode, parseScan }`)() as {
    formatCode: (v: string) => string
    parseScan: (t: string) => { token?: string; code?: string } | null
  }

  it("probes /api/app/me before asking for a code", () => {
    expect(renderAppLockedPage()).toContain("fetch('/api/app/me', { credentials: 'same-origin', headers: { 'X-AgentX-Probe': 'locked' } })")
  })

  it("inserts the dash and normalises case as you type or paste", () => {
    expect(helpers.formatCode("abcdefgh")).toBe("ABCD-EFGH")
    expect(helpers.formatCode("abcd")).toBe("ABCD")
    expect(helpers.formatCode("abcde")).toBe("ABCD-E")
    expect(helpers.formatCode(" abcd efgh ")).toBe("ABCD-EFGH")
    expect(helpers.formatCode("ABCD-EFGH")).toBe("ABCD-EFGH")
    expect(helpers.formatCode("abcdefghij")).toBe("ABCD-EFGH")
  })

  it("reads a pairing link or a bare code from a scanned QR code", () => {
    expect(helpers.parseScan("https://mac.tail.ts.net/app/pair#token=agx_abc%2Bdef")).toEqual({ token: "agx_abc+def" })
    expect(helpers.parseScan("wxyz-2345")).toEqual({ code: "WXYZ-2345" })
    expect(helpers.parseScan("https://example.com/")).toBeNull()
    expect(helpers.parseScan("https://example.com/#token=x")).toBeNull()
    expect(helpers.parseScan("ABCD-EFGH-JKMN")).toBeNull()
  })

  it("has a scan button and a camera view that plays inline", () => {
    const html = renderAppLockedPage()
    expect(html).toContain('id="scan-btn"')
    expect(html).toMatch(/<video id="scan-video" playsinline muted/)
  })
})

describe("/app/qr.js", () => {
  it("is public and decodes the QR code from agentx app pair", async () => {
    const r = await fetch(`${base}/app/qr.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("javascript")
    const mod = { exports: {} as any }
    new Function("module", "exports", await r.text())(mod, mod.exports)
    const jsQR = mod.exports as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null

    const link = "https://mac.tail1234.ts.net/app/pair#token=agx_0123456789abcdef0123456789abcdef"
    const qr = QRCode.create(link, { errorCorrectionLevel: "L" })
    const n = qr.modules.size, scale = 4, quiet = 4, side = (n + quiet * 2) * scale
    const px = new Uint8ClampedArray(side * side * 4).fill(255)
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet
      if (mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx)) px.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3)
    }
    expect(jsQR(px, side, side)?.data).toBe(link)
    expect(helpers().parseScan(link)).toEqual({ token: "agx_0123456789abcdef0123456789abcdef" })
  })
})

function helpers() {
  return new Function(`${LOCKED_HELPERS}; return { parseScan }`)() as { parseScan: (t: string) => unknown }
}
