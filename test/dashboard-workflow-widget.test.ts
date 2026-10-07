import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// The progress widget's routes on the dashboard (#796): the page, its rows
// (read from the daemon), and an answer forwarded to the run's daemon.

let server: Server | undefined

const blockedRun = {
  id: "run-b", workflowId: "deploy", status: "paused", pending: [], history: [], createdAt: "2026-01-02T10:00:00Z", updatedAt: "2026-01-02T10:05:00Z",
  pausedAt: { kind: "agentStep", nodeId: "copy", agentId: "builder", nudges: 2, maxNudges: 2, stallMs: 60000, blocked: "needs a password" },
  meta: { title: "Move the blog", tags: ["project:blog"], followUp: true, approvedAtStart: false },
}

async function start(opts: { token?: string; widget?: Record<string, unknown> } = {}): Promise<string> {
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { daemonUrl: "http://daemon.invalid:18800" },
    workflows: { widget: opts.widget ?? {} },
  })
  const ctx = {
    boards: [], sources: new Map(), token: opts.token, config,
    workflowRuns: { list: () => [] },
    workflowStore: { list: () => [], get: () => null },
  } as unknown as Ctx
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
  const daemon = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/workflows/runs")) return new Response(JSON.stringify({ runs: [blockedRun] }))
    if (url.includes("/workflow-runs/")) return new Response(JSON.stringify({ ok: true }))
    return new Response(JSON.stringify({ peers: [] }))
  })
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("http://daemon.invalid") ? daemon(String(url), init) : real(url, init))
  return daemon
}

describe("dashboard progress widget", () => {
  it("serves the page with its settings", async () => {
    stubDaemon()
    const base = await start({ widget: { position: "bottom-left" } })
    const r = await fetch(`${base}/workflows/widget`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain("Keep on top")
    expect(html).toContain("bottom-left")
  })

  it("lists the daemon's followed runs with the node they live on", async () => {
    stubDaemon()
    const base = await start()
    const body = await (await fetch(`${base}/api/workflows/widget`)).json() as any
    expect(body.enabled).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ runId: "run-b", node: "http://daemon.invalid:18800", nodeName: "node-a", state: "blocked", owner: "builder", answer: { kind: "reply", agentId: "builder" } })
  })

  it("forwards a reply to the run's daemon, and only from a dashboard page", async () => {
    const daemon = stubDaemon()
    const base = await start()
    const answer = { node: "http://daemon.invalid:18800", runId: "run-b", action: "reply", text: "It is in the vault." }
    const bare = await fetch(`${base}/api/workflows/widget/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answer) })
    expect(bare.status).toBe(400)
    const r = await fetch(`${base}/api/workflows/widget/answer`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" }, body: JSON.stringify(answer),
    })
    expect(r.status).toBe(200)
    const call = daemon.mock.calls.find((c) => String(c[0]).includes("/workflow-runs/"))!
    expect(String(call[0])).toBe("http://daemon.invalid:18800/workflow-runs/run-b/answer")
    expect(JSON.parse(String(call[1]!.body))).toEqual({ text: "It is in the vault.", by: "operator (progress widget)" })
  })

  it("sits behind the dashboard token", async () => {
    stubDaemon()
    const base = await start({ token: "dash-secret" })
    expect((await fetch(`${base}/api/workflows/widget`)).status).toBe(401)
    expect((await fetch(`${base}/api/workflows/widget`, { headers: { Authorization: "Bearer dash-secret" } })).status).toBe(200)
  })
})
