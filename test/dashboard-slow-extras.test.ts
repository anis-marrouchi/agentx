import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "http"
import { fetchDaemonAgents, handleBoardRequest, resetLiveCaches, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// #245: a node busy on a slow extra (its cron history) must stay reachable
// in the snapshot; only /agents decides reachability.
let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

function startNode(hang: string[], slowMs = 0): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0]
    if (hang.includes(path)) return // never answers
    if (path === "/mesh") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]"); return }
    if (slowMs && path === "/agents") { setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify([{ id: "writer", name: "Writer" }])) }, slowMs); return }
    const json = (b: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)) }
    if (path === "/agents") return json([{ id: "writer", name: "Writer", tier: "claude-code", active: 0, total: 3, errors: 0 }])
    if (path === "/health") return json({ uptime: 42, node: { id: "node-b", name: "node-b" } })
    if (path === "/crons") return json([{ id: "digest", enabled: true, schedule: "0 9 * * *", agent: "writer" }])
    res.writeHead(404); res.end("{}")
  })
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as any).port}`)))
}

describe("live snapshot with slow optional endpoints", () => {
  it("keeps a node reachable when /crons/runs and /routines hang", async () => {
    const url = await startNode(["/crons/runs", "/routines"])
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 3000)
    const node = await fetchDaemonAgents(url, undefined, ac.signal, { date: "2026-09-28", timezone: "UTC" })
    clearTimeout(timer)
    expect(node.reachable).toBe(true)
    expect(node.error).toBeUndefined()
    expect(node.agents.map((a) => a.id)).toEqual(["writer"])
    expect(node.crons?.map((c) => c.id)).toEqual(["digest"])
    expect(node.cronRuns).toBeUndefined()
    expect(node.name).toBe("node-b")
  }, 10_000)

  it("still marks a node unreachable when /agents itself hangs", async () => {
    const url = await startNode(["/agents"])
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1500)
    const node = await fetchDaemonAgents(url, undefined, ac.signal)
    clearTimeout(timer)
    expect(node.reachable).toBe(false)
    // #1442: out of time is slow, not down; the Wall shows "checking…".
    expect(node).toMatchObject({ error: "timed out", checking: true })
  }, 10_000)

  it("marks a node that refuses the connection as down, not checking (#1442)", async () => {
    const url = await startNode([])
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    const node = await fetchDaemonAgents(url, undefined, AbortSignal.timeout(3000))
    expect(node.reachable).toBe(false)
    expect(node.checking).toBeUndefined()
    expect(node.error).toBe("unreachable")
  }, 10_000)

  it("a quick snapshot answers while a node is slow, the node checking, then whole (#1442)", async () => {
    resetLiveCaches()
    const url = await startNode([], 2500)
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: url } })
    const dash = createServer((req, res) => { void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx) })
    await new Promise<void>((r) => dash.listen(0, "127.0.0.1", () => r()))
    const live = `http://127.0.0.1:${(dash.address() as any).port}/api/live?quick=1`
    try {
      const t0 = Date.now()
      const first = await (await fetch(live)).json() as any
      expect(Date.now() - t0).toBeLessThan(2300)
      expect(first.nodes[0]).toMatchObject({ reachable: false, checking: true })
      // Asked again while the node is still slow: the same read, now answered.
      const again = await (await fetch(live)).json() as any
      expect(again.nodes[0]).toMatchObject({ reachable: true })
      expect(again.nodes[0].checking).toBeUndefined()
    } finally {
      await new Promise<void>((r) => dash.close(() => r()))
    }
  }, 15_000)
})
