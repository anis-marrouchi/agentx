import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { BUILD_FRESH_MS, NodeBuildCache } from "../src/daemon/node-build-cache"

// GET /api/node/build feeds the header of every page. The header script has
// no token to send, so the route must answer without one, and must give
// nothing of the daemon's /health beyond the five header fields.

let server: Server | undefined

async function start(token?: string): Promise<string> {
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800", token } })
  const ctx = { boards: [], sources: new Map(), token, config } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  vi.unstubAllGlobals()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
})

/** Stub the dashboard's outbound fetch (to the daemon) only. */
function stubDaemon(): ReturnType<typeof vi.fn> {
  const real = globalThis.fetch
  const daemon = vi.fn(async () => new Response(JSON.stringify({
    status: "ok", node: { id: "node-a" }, version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z",
    pid: 4242, build: { newer: true }, lastRestart: { by: "restart-when-idle from someone" }, agents: [{ id: "private" }],
  })))
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("http://daemon.invalid") ? daemon(url, init) : real(url, init))
  return daemon
}

const HEADER = { node: "node-a", version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z", diskNewer: true }

describe("dashboard header build route", () => {
  it("answers the header script, which sends no token, when the dashboard has one", async () => {
    stubDaemon()
    const base = await start("dash-secret")
    const r = await fetch(`${base}/api/node/build`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(HEADER)
  })

  it("gives the header fields only, with or without a token", async () => {
    stubDaemon()
    const base = await start()
    expect(await (await fetch(`${base}/api/node/build`)).json()).toEqual(HEADER)
  })

  it("keeps the token check on the routes next to it", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    expect((await fetch(`${base}/api/mesh/feed`)).status).toBe(401)
    expect((await fetch(`${base}/api/node/build`, { method: "POST" })).status).toBe(401)
    expect(daemon).not.toHaveBeenCalled()
  })
})

describe("dashboard keeps the daemon's build (#2101: Hub bar version)", () => {
  it("serves a recent answer without asking the daemon again", async () => {
    const daemon = stubDaemon()
    const base = await start()
    await fetch(`${base}/api/node/build`)
    const r = await fetch(`${base}/api/node/build`)
    expect(await r.json()).toEqual(HEADER)
    expect(daemon).toHaveBeenCalledTimes(1)
  })

  it("fails only when it never had an answer", async () => {
    vi.stubGlobal("fetch", (() => { const real = globalThis.fetch; return (url: string, init?: RequestInit) =>
      String(url).startsWith("http://daemon.invalid") ? Promise.reject(new Error("The operation was aborted due to timeout")) : real(url, init) })())
    const base = await start()
    const r = await fetch(`${base}/api/node/build`)
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: "The operation was aborted due to timeout" })
  })
})

describe("NodeBuildCache", () => {
  const HEALTH = { node: { id: "node-a" }, version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z" }

  it("gives the last good answer, marked asOf, when an ask fails", async () => {
    let t = Date.parse("2026-11-26T10:00:00.000Z")
    let fail = false
    const ask = vi.fn(async () => { if (fail) throw new Error("timeout"); return HEALTH })
    const c = new NodeBuildCache(ask, () => t)
    expect(await c.get()).toEqual({ status: 200, body: { ...HEADER, diskNewer: false } })
    fail = true
    t += BUILD_FRESH_MS
    expect(await c.get()).toEqual({ status: 200, body: { ...HEADER, diskNewer: false, asOf: "2026-11-26T10:00:00.000Z" } })
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it("asks again once the answer is no longer recent", async () => {
    let t = 0
    const ask = vi.fn(async () => HEALTH)
    const c = new NodeBuildCache(ask, () => t)
    await c.get()
    t = BUILD_FRESH_MS - 1
    await c.get()
    expect(ask).toHaveBeenCalledTimes(1)
    t = BUILD_FRESH_MS
    await c.get()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it("asks once for many pages opening at the same moment", async () => {
    let done!: (v: unknown) => void
    const ask = vi.fn(() => new Promise((r) => { done = r }))
    const c = new NodeBuildCache(ask)
    const all = Promise.all([c.get(), c.get(), c.get()])
    done(HEALTH)
    expect((await all).map((a) => a.status)).toEqual([200, 200, 200])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("does not keep an answer without a version", async () => {
    const c = new NodeBuildCache(async () => ({ status: "ok" }))
    expect((await c.get()).status).toBe(502)
  })
})
