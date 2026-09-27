import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { TypedEventBus } from "../src/events/bus"
import type { EventEnvelope } from "../src/events/envelope"
import { recentFeed, streamEnvelopes } from "../src/events/feed-http"
import { httpFeedTransport } from "../src/events/feed-transport"
import { MeshFeedFollower, type FeedPeerInfo } from "../src/events/peer-feed"

// Nodes are simulated in-process: each has its own bus and a small HTTP
// server exposing the two feed routes exactly as the daemon does, and
// followers talk to them over real sockets with the production transport.

interface Node {
  name: string
  bus: TypedEventBus
  server: Server
  port: number
  follower?: MeshFeedFollower
  up: boolean
}

const nodes: Node[] = []

function serve(bus: TypedEventBus): Server {
  return createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x")
    if (url.pathname === "/events" && url.searchParams.get("format") === "envelope") {
      streamEnvelopes(bus, req, res, url.searchParams)
      return
    }
    if (url.pathname === "/events/recent") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(recentFeed(bus, url.searchParams)))
      return
    }
    res.writeHead(404).end()
  })
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()))
  return (server.address() as AddressInfo).port
}

async function makeNode(name: string, ringSize = 1000): Promise<Node> {
  const bus = new TypedEventBus().configure({ node: name, ringSize })
  const server = serve(bus)
  const port = await listen(server)
  const n: Node = { name, bus, server, port, up: true }
  nodes.push(n)
  return n
}

async function takeDown(n: Node): Promise<void> {
  n.up = false
  n.server.closeAllConnections()
  await new Promise<void>((r) => n.server.close(() => r()))
}

async function bringUp(n: Node): Promise<void> {
  n.server = serve(n.bus)
  await listen(n.server, n.port)
  n.up = true
}

function follow(n: Node, peers: Node[], healthy: () => boolean = () => true): MeshFeedFollower {
  const info = (): FeedPeerInfo[] => peers.map((p) => ({ name: p.name, url: `http://127.0.0.1:${p.port}`, healthy: healthy(), headers: {} }))
  n.follower = new MeshFeedFollower({
    bus: n.bus,
    peers: info,
    skipTypes: () => ["task:step"],
    transport: httpFeedTransport({ idleMs: 2000 }),
    backoff: { minMs: 20, maxMs: 100 },
    reconcileMs: 20,
  }).start()
  return n.follower
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error("condition not met in time")
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

function from(bus: TypedEventBus, node: string, type?: string): EventEnvelope[] {
  return bus.recent().filter((e) => e.node === node && (!type || e.type === type))
}

function completed(bus: TypedEventBus, taskId: string): void {
  bus.emit("task:completed", { agentId: "helper", channel: "cron", chatId: "c1", durationMs: 12, at: new Date().toISOString(), taskId })
}

afterEach(async () => {
  for (const n of nodes.splice(0)) {
    n.follower?.stop()
    if (n.up) { n.server.closeAllConnections(); await new Promise<void>((r) => n.server.close(() => r())) }
  }
})

describe("peer event feed", () => {
  it("shows a task completed on B in A's feed with node B, exactly once", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    const typed: unknown[] = []
    a.bus.on("task:completed", (p) => typed.push(p))
    follow(a, [b])
    await waitFor(() => a.follower!.status().some((s) => s.up === true))

    completed(b.bus, "T-1")
    await waitFor(() => from(a.bus, "node-b", "task:completed").length > 0)
    await settle()

    const got = from(a.bus, "node-b", "task:completed")
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ node: "node-b", kind: "agent", ref: "T-1", agentId: "helper" })
    // A's own trace writer (typed listeners) never records B's task.
    expect(typed).toHaveLength(0)

    // Readers of A's envelope stream see it once too, with node B.
    const seen: EventEnvelope[] = []
    const ctrl = new AbortController()
    const stream = await httpFeedTransport().open({ name: "a", url: `http://127.0.0.1:${a.port}`, headers: {} }, "", ctrl.signal)
    const reading = (async () => { try { for await (const e of stream) seen.push(e) } catch { /* aborted */ } })()
    completed(b.bus, "T-2")
    await waitFor(() => seen.some((e) => e.ref === "T-2"))
    await settle()
    ctrl.abort()
    await reading
    expect(seen.filter((e) => e.ref === "T-2")).toEqual([expect.objectContaining({ node: "node-b" })])
  })

  it("leaves out skipped types such as task:step", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    follow(a, [b])
    await waitFor(() => a.follower!.status().some((s) => s.up === true))
    b.bus.emit("task:step", { taskId: "T", agentId: "helper", name: "tool_use", at: new Date().toISOString() })
    completed(b.bus, "T")
    await waitFor(() => from(a.bus, "node-b", "task:completed").length === 1)
    expect(from(a.bus, "node-b", "task:step")).toHaveLength(0)
  })

  it("backfills a peer's recent events on first contact", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    completed(b.bus, "before")
    follow(a, [b])
    await waitFor(() => from(a.bus, "node-b", "task:completed").length === 1)
    expect(from(a.bus, "node-b", "task:completed")[0].ref).toBe("before")
  })

  it("reports a down peer once, then catches up on what it missed when it returns", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    follow(a, [b])
    completed(b.bus, "T-0")
    await waitFor(() => from(a.bus, "node-b", "task:completed").length === 1)

    await takeDown(b)
    await waitFor(() => from(a.bus, "node-a", "feed:down").length === 1)
    // B keeps working while A can't reach it.
    completed(b.bus, "T-1")
    completed(b.bus, "T-2")
    await settle(300)
    expect(from(a.bus, "node-a", "feed:down")).toHaveLength(1)

    await bringUp(b)
    await waitFor(() => from(a.bus, "node-b", "task:completed").length === 3)
    await waitFor(() => from(a.bus, "node-a", "feed:up").length === 1)
    await settle()
    expect(from(a.bus, "node-b", "task:completed").map((e) => e.ref)).toEqual(["T-0", "T-1", "T-2"])
    expect(from(a.bus, "node-a", "feed:gap")).toHaveLength(0)
    expect(from(a.bus, "node-a", "feed:up")[0].summary).toContain("node-b")
  })

  it("reports a gap when the missed events have left the peer's buffer", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b", 3)]
    follow(a, [b])
    completed(b.bus, "T-0")
    await waitFor(() => from(a.bus, "node-b", "task:completed").length === 1)

    await takeDown(b)
    for (let i = 1; i <= 6; i++) completed(b.bus, `T-${i}`)
    await bringUp(b)
    await waitFor(() => from(a.bus, "node-a", "feed:gap").length === 1)
    // What the buffer still held arrives; the rest is reported, not invented.
    await waitFor(() => from(a.bus, "node-b", "task:completed").some((e) => e.ref === "T-6"))
    expect(from(a.bus, "node-b", "task:completed").map((e) => e.ref)).toEqual(["T-0", "T-4", "T-5", "T-6"])
  })

  it("publishes a mesh event, not silence, for a peer that is unreachable from the start", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    follow(a, [b], () => false)
    await waitFor(() => from(a.bus, "node-a", "feed:down").length === 1)
    await settle(200)
    const down = from(a.bus, "node-a", "feed:down")
    expect(down).toHaveLength(1)
    expect(down[0]).toMatchObject({ kind: "mesh", node: "node-a" })
    expect(down[0].summary).toContain("node-b")
  })

  it("three nodes in a triangle produce no duplicate or echoed events", async () => {
    const [a, b, c] = [await makeNode("node-a"), await makeNode("node-b"), await makeNode("node-c")]
    follow(a, [b, c]); follow(b, [a, c]); follow(c, [a, b])
    for (const n of [a, b, c]) await waitFor(() => n.follower!.status().filter((s) => s.up).length === 2)

    for (const n of [a, b, c]) n.bus.publish({ kind: "status", type: "hello", summary: `hello from ${n.name}` })
    for (const n of [a, b, c]) await waitFor(() => n.bus.recent({ kind: "status" }).length === 3)
    await settle(400)

    for (const n of [a, b, c]) {
      const hellos = n.bus.recent({ kind: "status" })
      expect(hellos).toHaveLength(3)
      const keys = hellos.map((e) => `${e.node}:${e.id}`)
      expect(new Set(keys).size).toBe(3)
      expect(new Set(hellos.map((e) => e.node))).toEqual(new Set(["node-a", "node-b", "node-c"]))
      // Its own event is the one it published; nothing came back to it.
      expect(from(n.bus, n.name, "hello")).toHaveLength(1)
    }
  })

  it("stops following a peer that leaves the mesh", async () => {
    const [a, b] = [await makeNode("node-a"), await makeNode("node-b")]
    let roster = [b]
    a.follower = new MeshFeedFollower({
      bus: a.bus,
      peers: () => roster.map((p) => ({ name: p.name, url: `http://127.0.0.1:${p.port}`, healthy: true, headers: {} })),
      backoff: { minMs: 20, maxMs: 100 },
      reconcileMs: 20,
    }).start()
    await waitFor(() => a.follower!.status().some((s) => s.up === true))
    roster = []
    await settle(100)
    completed(b.bus, "after-leaving")
    await settle(200)
    expect(from(a.bus, "node-b", "task:completed")).toHaveLength(0)
  })
})

describe("bus ingest", () => {
  const env = (over: Partial<EventEnvelope> = {}): EventEnvelope => ({
    id: "e1", rootId: "r1", node: "node-b", kind: "agent", type: "task:completed", at: new Date().toISOString(), summary: "done", ...over,
  })

  it("refuses duplicates and events claiming to come from this node", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const got: EventEnvelope[] = []
    bus.subscribe((e) => got.push(e))
    expect(bus.ingest(env())).toBe(true)
    expect(bus.ingest(env())).toBe(false)
    expect(bus.ingest(env({ node: "node-a", id: "e2" }))).toBe(false)
    expect(bus.ingest(env({ node: "node-c" }))).toBe(true)
    expect(got.map((e) => `${e.node}:${e.id}`)).toEqual(["node-b:e1", "node-c:e1"])
    expect(bus.isLocal(got[0])).toBe(false)
  })

  it("keeps peer events out of an origin=local read and flags a lost cursor", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    bus.ingest(env())
    const own = bus.publish({ kind: "status", type: "status", summary: "mine" })
    const all = recentFeed(bus, new URLSearchParams())
    expect(all.events).toHaveLength(2)
    const local = recentFeed(bus, new URLSearchParams({ origin: "local" }))
    expect(local.events.map((e) => e.id)).toEqual([own.id])
    expect(recentFeed(bus, new URLSearchParams({ since: own.id })).gap).toBeUndefined()
    expect(recentFeed(bus, new URLSearchParams({ since: "gone-id" })).gap).toBe(true)
    expect(recentFeed(bus, new URLSearchParams({ since: "2000-01-01T00:00:00Z" })).gap).toBeUndefined()
  })
})
