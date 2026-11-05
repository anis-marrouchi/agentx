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

// A slow board over a remote link: every open tab and the SSE tick
// share one whole live snapshot for a moment, and pages that only pick a
// node read which nodes answer, not each node's whole monitor.
describe("board reads kept small", () => {
  async function withBoard(handler: (req: any, res: any, hits: string[]) => boolean, run: (base: string, hits: string[]) => Promise<void>) {
    const hits: string[] = []
    server = createServer((req, res) => {
      hits.push(req.url || "/")
      if (handler(req, res, hits)) return
      res.writeHead(404); res.end("{}")
    })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
    const url = `http://127.0.0.1:${(server!.address() as any).port}`
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: url } })
    const dash = createServer((req, res) => { void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx) })
    await new Promise<void>((r) => dash.listen(0, "127.0.0.1", () => r()))
    try { await run(`http://127.0.0.1:${(dash.address() as any).port}`, hits) }
    finally { await new Promise<void>((r) => dash.close(() => r())) }
  }
  const json = (res: any, b: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); return true }

  it("reuses a whole live snapshot for two seconds", async () => {
    resetLiveCaches()
    await withBoard((req, res) => {
      const path = (req.url || "/").split("?")[0]
      if (path === "/mesh") return json(res, [])
      if (path === "/agents") return json(res, [{ id: "writer", name: "Writer" }])
      return false
    }, async (base, hits) => {
      const a = await (await fetch(`${base}/api/live`)).json() as any
      const b = await (await fetch(`${base}/api/live`)).json() as any
      expect(a.nodes[0].reachable).toBe(true)
      expect(b.ts).toBe(a.ts)
      expect(hits.filter((h) => h.split("?")[0] === "/agents")).toHaveLength(1)
    })
  }, 10_000)

  it("/api/monitor?nodes=1 names the nodes that answer without their monitor data", async () => {
    await withBoard((req, res) => {
      const path = (req.url || "/").split("?")[0]
      if (path === "/mesh") return json(res, [])
      if (path === "/monitor/actions") return json(res, { items: [], total: 900 })
      if (path === "/monitor") return json(res, { actions: { items: [{ big: "x".repeat(1000) }], total: 1 } })
      return false
    }, async (base, hits) => {
      const d = await (await fetch(`${base}/api/monitor?nodes=1`)).json() as any
      expect(d.nodes).toHaveLength(1)
      expect(d.nodes[0]).toMatchObject({ ok: true })
      expect(d.nodes[0].data).toBeUndefined()
      expect(hits).toContain("/monitor/actions?offset=1000000")
      expect(hits).not.toContain("/monitor")
      // Without the flag the whole monitor still comes back, for the classic pages.
      const full = await (await fetch(`${base}/api/monitor`)).json() as any
      expect(full.nodes[0].data.actions.total).toBe(1)
    })
  }, 10_000)
})
