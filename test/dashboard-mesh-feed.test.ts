import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// GET /api/mesh/feed proxies the daemon's mesh-gated /events/recent, which
// holds every peer's events. It must sit behind the dashboard's token gate.

let server: Server | undefined

async function start(token?: string): Promise<string> {
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800" } })
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
  const daemon = vi.fn(async () => new Response(JSON.stringify({ events: [{ id: "e1", node: "node-b", kind: "announce", type: "announce", summary: "hi" }] })))
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("http://daemon.invalid") ? daemon(url, init) : real(url, init))
  return daemon
}

describe("dashboard mesh feed route", () => {
  it("refuses a request without the dashboard token when one is configured", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    const r = await fetch(`${base}/api/mesh/feed`)
    expect(r.status).toBe(401)
    expect(daemon).not.toHaveBeenCalled()
  })

  it("serves the daemon's feed with the right token", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    const r = await fetch(`${base}/api/mesh/feed?limit=10`, { headers: { Authorization: "Bearer dash-secret" } })
    expect(r.status).toBe(200)
    const body = await r.json() as { node: string; events: Array<{ node: string }> }
    expect(body.node).toBe("node-a")
    expect(body.events[0].node).toBe("node-b")
    expect(String(daemon.mock.calls[0][0])).toContain("/events/recent?skip=task:step&limit=10")
  })
})
