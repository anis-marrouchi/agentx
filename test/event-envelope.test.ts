import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { rmSync } from "fs"
import { resolve } from "path"
import { getEventBus, TypedEventBus } from "../src/events/bus"
import { EventRing, SUMMARY_MAX, withNewRoot, withRoot, type EventEnvelope } from "../src/events/envelope"
import { EventBus, type DaemonEvent } from "../src/daemon/event-bus"
import { A2AMesh, rootFromTaskBody } from "../src/a2a/mesh"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { WorkflowDispatcher } from "../src/workflows/dispatcher"
import { WorkflowStore } from "../src/workflows/store"
import { RunStore } from "../src/workflows/run-store"
import { workflowSchema } from "../src/workflows/types"

const SECRET = "the-full-prompt-" + "x".repeat(2000)

beforeEach(() => { getEventBus().removeAllListeners() })

describe("envelope summaries", () => {
  it("caps every summary at SUMMARY_MAX", () => {
    const e = getEventBus().publish({ kind: "status", type: "status", summary: "y".repeat(5000) })
    expect(e.summary.length).toBeLessThanOrEqual(SUMMARY_MAX)
  })

  it("never carries a full prompt or answer, while typed subscribers still get them", () => {
    const bus = getEventBus()
    const typed: any[] = []
    const envelopes: EventEnvelope[] = []
    bus.on("task:started", (p) => typed.push(p))
    bus.subscribe((e) => envelopes.push(e))
    bus.emit("task:started", { agentId: "a", channel: "telegram", chatId: "c", messagePreview: SECRET.slice(0, 200), fullMessage: SECRET, at: new Date().toISOString(), taskId: "T1" })
    bus.emit("task:completed", { agentId: "a", channel: "telegram", chatId: "c", durationMs: 5, finalResponse: SECRET, error: SECRET, at: new Date().toISOString(), taskId: "T1" })
    bus.emit("task:step", { taskId: "T1", agentId: "a", name: "tool_use", action: "Bash", status: "in-flight", inputSummary: SECRET, at: new Date().toISOString() })

    expect(typed[0].fullMessage).toBe(SECRET)
    expect(envelopes).toHaveLength(3)
    for (const e of [...envelopes, ...bus.recent()]) {
      expect(e.summary.length).toBeLessThanOrEqual(SUMMARY_MAX)
      expect(JSON.stringify(e)).not.toContain(SECRET.slice(0, 300))
      expect(e.ref).toBe("T1")
    }
    expect(envelopes.map((e) => e.type)).toEqual(["task:started", "task:completed", "task:step"])
  })
})

describe("ring buffer", () => {
  it("keeps only the newest events", () => {
    const ring = new EventRing(3)
    for (let i = 0; i < 5; i++) ring.push({ id: `e${i}`, rootId: "r", node: "n", kind: "k", type: "t", at: new Date(1000 * i).toISOString(), summary: "" })
    expect(ring.recent().map((e) => e.id)).toEqual(["e2", "e3", "e4"])
  })

  it("filters by since (id or time), kind and agent", () => {
    const bus = new TypedEventBus()
    bus.publish({ kind: "run", type: "created", summary: "a", at: "2026-09-27T10:00:00.000Z" })
    const mid = bus.publish({ kind: "agent", type: "task:started", agentId: "coder", summary: "b", at: "2026-09-27T10:01:00.000Z" })
    bus.publish({ kind: "agent", type: "task:completed", agentId: "other", summary: "c", at: "2026-09-27T10:02:00.000Z" })
    bus.publish({ kind: "agent", type: "task:completed", agentId: "coder", summary: "d", at: "2026-09-27T10:03:00.000Z" })

    expect(bus.recent({ since: mid.id }).map((e) => e.summary)).toEqual(["c", "d"])
    expect(bus.recent({ since: "2026-09-27T10:01:30.000Z" }).map((e) => e.summary)).toEqual(["c", "d"])
    expect(bus.recent({ kind: "agent", agent: "coder" }).map((e) => e.summary)).toEqual(["b", "d"])
    expect(bus.recent({ limit: 1 }).map((e) => e.summary)).toEqual(["d"])
  })

  it("is served off-box only with the mesh token", () => {
    expect(isMeshGatedPath("/events/recent")).toBe(true)
    expect(isMeshGatedPath("/events")).toBe(false)
  })

  it("resizes from config", () => {
    const bus = new TypedEventBus().configure({ ringSize: 2 })
    for (let i = 0; i < 4; i++) bus.publish({ kind: "k", type: "t", summary: String(i) })
    expect(bus.recent().map((e) => e.summary)).toEqual(["2", "3"])
  })
})

describe("/events adapter", () => {
  it("keeps the legacy wire shape and adds rootId and node", () => {
    const core = new TypedEventBus().configure({ node: "mac" })
    const events = new EventBus(core)
    const got: DaemonEvent[] = []
    events.subscribe({ kinds: ["mesh"] }, (e) => got.push(e))
    // Envelope-only events (no legacy shape) never reach /events clients.
    core.publish({ kind: "mesh", type: "forward", summary: "forwarded" })
    withNewRoot(() => events.publish({ kind: "mesh", peer: "hq", healthy: false, delta: "lost" }))

    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: "mesh", peer: "hq", healthy: false, delta: "lost", node: "mac" })
    expect(typeof got[0].id).toBe("string")
    expect(typeof got[0].rootId).toBe("string")
    expect(core.recent({ kind: "mesh" }).map((e) => e.summary)).toEqual(["forwarded", "peer hq lost"])
  })
})

describe("root ids", () => {
  const DIR = resolve(__dirname, "../.test-event-roots")
  let server: Server
  let peerBody: Record<string, unknown> | undefined

  beforeEach(async () => {
    rmSync(DIR, { recursive: true, force: true })
    peerBody = undefined
    server = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => { raw += c })
      req.on("end", () => {
        peerBody = JSON.parse(raw)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ content: "done remotely" }))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(DIR, { recursive: true, force: true })
  })

  it("a message that causes a workflow run and a mesh forward shares one rootId, across the peer too", async () => {
    const port = (server.address() as { port: number }).port
    const mesh = new A2AMesh({ mesh: { peers: [{ name: "hq", url: `http://127.0.0.1:${port}` }], healthCheck: { timeout: 5, interval: 60 } } } as any, () => {})
    ;(mesh as any).peers.get("hq").client.getAgentCard = vi.fn(async () => ({ name: "HQ", skills: [{ id: "devops", name: "DevOps" }] }))
    await mesh.discoverAll()

    const store = new WorkflowStore({ baseDir: DIR })
    store.save(workflowSchema.parse({
      id: "wf", version: 2, title: "wf", priority: 0, fanOut: false,
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "ask", type: "agent", config: { agentId: "devops", prompt: "check {{trigger.text}}" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "ask" }, { from: "ask", to: "done" }],
      envAllow: [], retention: { maxRuns: 500, maxDays: 90 },
    }))
    const runs = new RunStore({ baseDir: DIR, nodeId: "node-a" })
    // The agent lives on a peer, as with the registry's mesh fallback.
    const agents = {
      execute: async (req: { agentId: string; message: string }) => ({
        content: await mesh.sendTask("hq", req.message, req.agentId), taskId: "t", durationMs: 1,
      }),
    }
    const bus = getEventBus()
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels: {}, agents: agents as any, events: new EventBus(bus) })

    await withNewRoot(async () => {
      bus.emit("message:matched", { channel: "telegram", chatId: "c", msgId: "m1", agentId: "devops", decidingStage: "dm", at: new Date().toISOString() })
      await dispatcher.dispatch({ trigger: { source: "manual" }, entityRef: { backend: "manual", id: "e1" }, event: { id: "evt-1", payload: { text: "disk" } } })
    })
    await vi.waitFor(() => expect(runs.list({ workflowId: "wf" })[0]?.status).toBe("completed"))

    const all = bus.recent()
    const message = all.find((e) => e.type === "message:matched")!
    const forward = all.find((e) => e.kind === "mesh" && e.type === "forward")!
    const runEvents = all.filter((e) => e.kind === "run")
    expect(runEvents.map((e) => e.type)).toEqual(expect.arrayContaining(["created", "completed"]))
    for (const e of [forward, ...runEvents]) expect(e.rootId).toBe(message.rootId)
    expect(runs.list({ workflowId: "wf" })[0].eventRootId).toBe(message.rootId)

    // The peer receives the root and adopts it for its own events.
    expect(peerBody).toMatchObject({ rootId: message.rootId, parentEventId: forward.id })
    const onPeer = withRoot(rootFromTaskBody(peerBody!), () => new TypedEventBus().publish({ kind: "agent", type: "task:started", summary: "started" }))
    expect(onPeer).toMatchObject({ rootId: message.rootId, parentId: forward.id })
  })

  it("entry points without a peer root start a new one", () => {
    const a = rootFromTaskBody({})
    const b = rootFromTaskBody({ rootId: 42 })
    expect(a.rootId).not.toBe(b.rootId)
    expect(a.parentId).toBeUndefined()
  })
})
