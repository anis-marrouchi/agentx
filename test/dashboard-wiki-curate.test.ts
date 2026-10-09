import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// /api/wiki/curate* on the dashboard proxies to the daemon with the
// dashboard's own credential, and a POST starts an operator turn that
// rewrites a page (#818). It must sit behind the dashboard's token and
// X-Requested-With checks.

let server: Server | undefined

async function start(token?: string): Promise<string> {
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { daemonUrl: "http://daemon.invalid:18800", ...(token ? { token } : {}) },
  })
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

function stubDaemon(): ReturnType<typeof vi.fn> {
  const real = globalThis.fetch
  const daemon = vi.fn(async () => new Response(JSON.stringify({ pending: true, id: 1, curator: "ops" })))
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("http://daemon.invalid") ? daemon(url, init) : real(url, init))
  return daemon
}

const BODY = JSON.stringify({ agent: "ops", path: "people/sam.md", message: "rewrite the summary" })

describe("dashboard wiki curate proxy", () => {
  it("refuses an untokened request when dashboard.token is set", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    const headers = { "Content-Type": "application/json", "X-Requested-With": "agentx-board" }
    expect((await fetch(`${base}/api/wiki/curate`, { method: "POST", headers, body: BODY })).status).toBe(401)
    expect((await fetch(`${base}/api/wiki/curate/restore`, { method: "POST", headers, body: BODY })).status).toBe(401)
    expect((await fetch(`${base}/api/wiki/curate?agent=ops&path=people%2Fsam.md`)).status).toBe(401)
    expect(daemon).not.toHaveBeenCalled()
  })

  it("refuses a write without X-Requested-With", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    const r = await fetch(`${base}/api/wiki/curate`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer dash-secret" }, body: BODY,
    })
    expect(r.status).toBe(400)
    expect(daemon).not.toHaveBeenCalled()
  })

  it("forwards a tokened write to the daemon", async () => {
    const daemon = stubDaemon()
    const base = await start("dash-secret")
    const r = await fetch(`${base}/api/wiki/curate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", Authorization: "Bearer dash-secret" },
      body: BODY,
    })
    expect(r.status).toBe(200)
    expect(String(daemon.mock.calls[0][0])).toBe("http://daemon.invalid:18800/api/wiki/curate")
    expect(JSON.parse(String((daemon.mock.calls[0][1] as RequestInit).body)).message).toBe("rewrite the summary")
  })
})
