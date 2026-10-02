import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

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
