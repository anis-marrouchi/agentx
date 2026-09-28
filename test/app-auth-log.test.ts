import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { APP_COOKIE, handleAppRequest } from "../src/daemon/app-routes"
import { RejectLog } from "../src/daemon/app-auth-log"

// #234: refused /app and /api/app requests leave one trace line saying
// whether a cookie came at all, with no token material, at most once a
// minute per path and state.

let dir: string
let store: TokenStore
let server: Server
let base: string
let lines: string[]
let clock: number

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-applog-"))
  store = new TokenStore(dir)
  // One RejectLog across requests, so the rate limit is exercised.
  const rejectLog = new RejectLog((l) => lines.push(l), () => clock)
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleAppRequest(req, res, path, req.method || "GET", { tokens: store, rejectLog })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

beforeEach(() => {
  lines = []
  clock = (clock ?? Date.now()) + 3_600_000 // a fresh minute for every test
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const withCookie = (t: string) => ({ Cookie: `${APP_COOKIE}=${t}` })

// node:http rather than fetch: fetch adds its own Sec-Fetch-Mode header.
function get(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)) })
    req.on("error", reject)
    req.end()
  })
}

describe("unauthenticated trace", () => {
  it("says the cookie was absent, with the browser's fetch mode and site", async () => {
    await get(`/app`, { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" })
    expect(lines).toEqual(["[app] unauthenticated /app cookie=absent mode=navigate site=none"])
  })

  it("tells an unknown key from a revoked one, and never prints either", async () => {
    const bogus = "agx_live_" + "ab".repeat(32)
    const { token, record } = store.create({ name: "Old phone", scopes: ["app"] })
    store.revoke(record.id)
    await get(`/api/app/me`, withCookie(bogus))
    await get(`/api/app/fleet`, withCookie(token))
    expect(lines).toEqual([
      "[app] unauthenticated /api/app/me cookie=invalid mode=- site=-",
      "[app] unauthenticated /api/app/fleet cookie=revoked mode=- site=-",
    ])
    const all = lines.join("\n")
    for (const secret of [bogus, token, record.id, record.hash, record.prefix, "agx_live_"]) expect(all).not.toContain(secret)
  })

  it("reports a refused Bearer key separately from the cookie", async () => {
    const { token } = store.create({ name: "admin", scopes: ["dashboard:write"] })
    await get(`/api/app/me`, { Authorization: `Bearer ${token}` })
    expect(lines).toEqual(["[app] unauthenticated /api/app/me cookie=absent bearer=invalid mode=- site=-"])
    expect(lines[0]).not.toContain(token)
  })

  it("logs each path and state at most once a minute", async () => {
    for (let i = 0; i < 5; i++) await get(`/api/app/alerts`)
    expect(lines).toHaveLength(1)
    await get(`/api/app/push`) // another path still gets its line
    expect(lines).toHaveLength(2)
    clock += 59_000
    await get(`/api/app/alerts`)
    expect(lines).toHaveLength(2)
    clock += 2_000
    await get(`/api/app/alerts`)
    expect(lines).toHaveLength(3)
  })

  it("does not log accepted requests or the public assets", async () => {
    const { token } = store.create({ name: "Phone", scopes: ["app"] })
    expect((await get(`/api/app/me`, withCookie(token)))).toBe(200)
    await get(`/app/manifest.webmanifest`)
    await get(`/app/pair`)
    expect(lines).toEqual([])
  })

  it("replaces unexpected header values instead of copying them into the log", async () => {
    await get(`/app`, { "Sec-Fetch-Mode": "evil value; cookie=x" })
    expect(lines).toEqual(["[app] unauthenticated /app cookie=absent mode=- site=-"])
  })
})

describe("RejectLog", () => {
  it("stays bounded under many distinct paths", () => {
    let now = 0
    const out: string[] = []
    const log = new RejectLog((l) => out.push(l), () => now)
    for (let i = 0; i < 2000; i++) log.record(`/api/app/x${i}`, { cookie: "absent" })
    expect(out).toHaveLength(2000)
    expect((log as any).last.size).toBeLessThanOrEqual(501)
    now += 1
    log.record("/api/app/x1999", { cookie: "absent" })
    expect(out).toHaveLength(2000)
  })
})
