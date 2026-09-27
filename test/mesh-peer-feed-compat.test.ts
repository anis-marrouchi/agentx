import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import type { AddressInfo } from "net"
import { TypedEventBus } from "../src/events/bus"
import { recentFeed, streamEnvelopes } from "../src/events/feed-http"
import { envelopeFrames, httpFeedTransport, MAX_FRAME_BYTES, toEnvelope } from "../src/events/feed-transport"
import { MeshFeedFollower } from "../src/events/peer-feed"

// Mixed-version meshes and quiet peers: neither may make the follower
// publish feed:down / feed:up.

type Handler = (req: IncomingMessage, res: ServerResponse) => void
const servers: Server[] = []
const followers: MeshFeedFollower[] = []

async function serve(handler: () => Handler): Promise<number> {
  const server = createServer((req, res) => handler()(req, res))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return (server.address() as AddressInfo).port
}

/** What an AgentX without the feed answers: its legacy /events stream
 *  (one status frame, no heartbeat) and no /events/recent. */
const legacy: Handler = (req, res) => {
  if ((req.url || "").startsWith("/events?")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`event: status\ndata: {"node":"old-node","agents":1}\n\n`)
    return
  }
  res.writeHead(404).end()
}

/** A current peer, with a configurable heartbeat. */
function feed(bus: TypedEventBus, heartbeatMs: number): Handler {
  return (req, res) => {
    const url = new URL(req.url || "/", "http://x")
    if (url.pathname === "/events") return streamEnvelopes(bus, req, res, url.searchParams, { heartbeatMs })
    if (url.pathname === "/events/recent") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(recentFeed(bus, url.searchParams)))
      return
    }
    res.writeHead(404).end()
  }
}

function follow(bus: TypedEventBus, name: string, port: number, extra: { unsupportedRetryMs?: number; log?: (m: string) => void } = {}) {
  const f = new MeshFeedFollower({
    bus,
    peers: () => [{ name, url: `http://127.0.0.1:${port}`, healthy: true, headers: {} }],
    transport: httpFeedTransport({ idleMs: 150 }),
    backoff: { minMs: 20, maxMs: 100 },
    reconcileMs: 20,
    shortSessionMs: 0,
    ...extra,
  }).start()
  followers.push(f)
  return f
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await wait(15) }
  throw new Error("condition not met in time")
}
const feedEvents = (bus: TypedEventBus) => bus.recent({ kind: "mesh" }).filter((e) => e.type.startsWith("feed:"))

afterEach(async () => {
  for (const f of followers.splice(0)) f.stop()
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())) }
})

describe("mixed-version mesh", () => {
  it("leaves a peer without the feed alone: no down/up flapping", async () => {
    const a = new TypedEventBus().configure({ node: "node-a" })
    const logs: string[] = []
    let handler: Handler = legacy
    const port = await serve(() => handler)
    const f = follow(a, "old-node", port, { unsupportedRetryMs: 100, log: (m) => logs.push(m) })

    await wait(1500) // ten times the idle limit
    expect(feedEvents(a)).toEqual([])
    expect(f.status()).toEqual([expect.objectContaining({ peer: "old-node", unsupported: true })])
    expect(logs.filter((l) => l.includes("not followed"))).toHaveLength(1)

    // The peer is upgraded: it is followed from then on, as a quiet first contact.
    const b = new TypedEventBus().configure({ node: "old-node" })
    handler = feed(b, 50)
    await waitFor(() => f.status()[0]?.up === true)
    b.publish({ kind: "status", type: "hello", summary: "upgraded" })
    await waitFor(() => a.recent().some((e) => e.node === "old-node" && e.type === "hello"))
    expect(feedEvents(a)).toEqual([])
  })
})

describe("quiet peers", () => {
  it("keeps a quiet current peer up past the idle limit thanks to the keep-alive", async () => {
    const a = new TypedEventBus().configure({ node: "node-a" })
    const b = new TypedEventBus().configure({ node: "node-b" })
    const f = follow(a, "node-b", await serve(() => feed(b, 50)))
    await waitFor(() => f.status()[0]?.up === true)
    await wait(800)
    expect(feedEvents(a)).toEqual([])
    b.publish({ kind: "status", type: "hello", summary: "still here" })
    await waitFor(() => a.recent().some((e) => e.node === "node-b" && e.type === "hello"))
  })

  it("reconnects silently when a correct peer's stream goes idle", async () => {
    const a = new TypedEventBus().configure({ node: "node-a" })
    const b = new TypedEventBus().configure({ node: "node-b" })
    const f = follow(a, "node-b", await serve(() => feed(b, 60_000)))
    await waitFor(() => f.status()[0]?.up === true)
    await wait(800)
    expect(feedEvents(a)).toEqual([])
    b.publish({ kind: "status", type: "hello", summary: "after idle" })
    await waitFor(() => a.recent().some((e) => e.node === "node-b" && e.type === "hello"))
    expect(f.status()[0].up).toBe(true)
  })

  it("drops and logs events from a peer that uses this node's name", async () => {
    const a = new TypedEventBus().configure({ node: "node-a" })
    const twin = new TypedEventBus().configure({ node: "node-a" })
    const logs: string[] = []
    const f = follow(a, "twin", await serve(() => feed(twin, 50)), { log: (m) => logs.push(m) })
    await waitFor(() => f.status()[0]?.up === true)
    twin.publish({ kind: "status", type: "hello", summary: "one" })
    twin.publish({ kind: "status", type: "hello", summary: "two" })
    await wait(200)
    expect(a.recent({ kind: "status" })).toEqual([])
    expect(logs.filter((l) => l.includes("this node's own name"))).toHaveLength(1)
  })
})

describe("frame bounds", () => {
  it("cuts off a frame that never ends", async () => {
    async function* chunks() { yield new TextEncoder().encode("data: " + "x".repeat(MAX_FRAME_BYTES + 10)) }
    const read = async () => { for await (const _ of envelopeFrames(chunks())) { /* none */ } }
    await expect(read()).rejects.toThrow(/feed frame over/)
  })

  it("refuses an envelope with an unreadable time", () => {
    const e = { id: "e1", node: "n", kind: "k", type: "t", summary: "" }
    expect(toEnvelope({ ...e, at: "not a time" })).toBeNull()
    expect(toEnvelope({ ...e, at: new Date().toISOString() })).not.toBeNull()
  })
})
