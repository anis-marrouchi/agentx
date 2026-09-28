import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "http"
import { fetchDaemonAgents } from "../src/daemon/board-dashboard"

// #245: a node busy on a slow extra (its cron history) must stay reachable
// in the snapshot; only /agents decides reachability.
let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

function startNode(hang: string[]): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0]
    if (hang.includes(path)) return // never answers
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
  }, 10_000)
})
