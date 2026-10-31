import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { TypedEventBus } from "../src/events/bus"
import { publishNamedEvent } from "../src/events/emit"
import type { EventEnvelope } from "../src/events/envelope"
import { groupEventsFeed, nodeEventsFeed, type NodeEventsShare } from "../src/events/hub-feed"
import { EventWaker } from "../src/events/wake"
import { WakeJournal, type WakeRecord } from "../src/events/wake-journal"
import { buildWallEvents } from "../src/daemon/wall-events"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_EVENTS_SCRIPT } from "../src/daemon/ui/pages/wall-events.client"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// The Hub's events feed (#1648): broadcasts, the wakes each one caused
// (ran, waited for a slot, held, timed out) and the replies grouped under
// the event that caused them.

const T0 = Date.UTC(2026, 9, 31, 14, 0)
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()

function ev(o: Partial<EventEnvelope> & { id: string; type: string; min: number }): EventEnvelope {
  const { min, ...rest } = o
  return { rootId: o.id, node: "alpha", kind: "custom", summary: o.type, at: iso(min), ...rest } as EventEnvelope
}

function wake(o: Partial<WakeRecord> & { agentId: string; eventId: string; rootId: string }): WakeRecord {
  return { eventNode: "alpha", status: "ran", decidedAt: T0, attempts: 1, ...o }
}

afterEach(() => { vi.useRealTimers() })

describe("wake journal", () => {
  it("records how long a wake waited for its slot, and how it ended", () => {
    let now = T0
    const j = new WakeJournal(10, () => now)
    const e = ev({ id: "E1", type: "daemon:restart-soon", min: 0 })
    j.decided("coder", e)
    j.decided("ops", e)
    j.decided("pm", e, "rate-limit")
    now += 4 * 60_000
    j.started("coder", "E1", "T-coder")
    now += 60_000
    j.finished("coder", "E1")
    j.finished("ops", "E1", 'Agent "ops" busy — slot wait timed out after 25m')
    const [coder, ops, pm] = j.list()
    expect(coder).toMatchObject({ status: "ran", startedAt: T0 + 240_000, endedAt: T0 + 300_000, taskId: "T-coder" })
    expect(ops).toMatchObject({ status: "timed-out", error: expect.stringContaining("slot wait timed out") })
    expect(ops.startedAt).toBeUndefined()
    expect(pm).toMatchObject({ status: "skipped", reason: "rate-limit", attempts: 0 })
    expect(j.eventForTask("T-coder")).toBe("E1")
  })

  it("keeps at most its capacity, oldest dropped first", () => {
    const j = new WakeJournal(2)
    for (const id of ["A", "B", "C"]) j.decided("coder", ev({ id, type: "x", min: 0 }))
    expect(j.list().map((r) => r.eventId)).toEqual(["B", "C"])
  })

  it("is written by the waker: held, retried, then run", async () => {
    vi.useFakeTimers()
    const bus = new TypedEventBus().configure({ node: "alpha" })
    const journal = new WakeJournal()
    let calls = 0
    const waker = new EventWaker({
      agents: () => ({ coder: { subscriptions: [{ kinds: ["daemon:restart-soon"], delivery: "wake" }] } }),
      dispatch: async () => (++calls === 1 ? { held: "dispatch cap" } : { content: "ok" }),
      log: () => {},
      journal,
    })
    waker.attach(bus)
    publishNamedEvent(bus, { name: "daemon:restart-soon" }, new Set())
    await vi.advanceTimersByTimeAsync(10)
    expect(journal.list()[0]).toMatchObject({ status: "held", reason: "dispatch cap", attempts: 1 })
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(journal.list()[0]).toMatchObject({ status: "ran", attempts: 2 })
    waker.stop()
  })

  it("marks a held wake dropped when its retry would land after the deadline (#1647)", async () => {
    vi.useFakeTimers()
    const bus = new TypedEventBus().configure({ node: "alpha" })
    const journal = new WakeJournal()
    const waker = new EventWaker({
      agents: () => ({ coder: { subscriptions: [{ kinds: ["daemon:restart-soon"], delivery: "wake", maxDelayMin: 3 }] } }),
      dispatch: async () => ({ held: "dispatch cap" }),
      log: () => {},
      journal,
    })
    waker.attach(bus)
    publishNamedEvent(bus, { name: "daemon:restart-soon" }, new Set())
    await vi.advanceTimersByTimeAsync(10)
    expect(journal.list()[0]).toMatchObject({ status: "dropped" })
    expect(journal.list()[0].reason).toMatch(/^expired, still held at its deadline .*: dispatch cap$/)
    waker.stop()
  })

  it("marks a dispatch that threw as failed", async () => {
    const bus = new TypedEventBus().configure({ node: "alpha" })
    const journal = new WakeJournal()
    new EventWaker({
      agents: () => ({ coder: { subscriptions: [{ kinds: ["x:y"], delivery: "wake" }] } }),
      dispatch: async () => { throw new Error("boom") },
      log: () => {},
      journal,
    }).attach(bus)
    publishNamedEvent(bus, { name: "x:y" }, new Set())
    await vi.waitFor(() => expect(journal.list()[0]?.status).toBe("failed"))
    expect(journal.list()[0].error).toBe("boom")
  })
})

describe("named events from a woken turn", () => {
  it("carry the event that woke the turn as their parent", () => {
    const bus = new TypedEventBus().configure({ node: "alpha" })
    const r = publishNamedEvent(bus, { name: "agent:resume-plan-ready" }, new Set(["coder"]), { agentId: "coder", rootId: "E1", parentId: "E1" })
    expect(r.ok && r.event).toMatchObject({ parentId: "E1", rootId: "E1", agentId: "coder" })
  })
})

describe("grouping the feed", () => {
  const restart = ev({ id: "E1", type: "daemon:restart-soon", min: 0, ref: "4b63f428" })
  const fromCoder = ev({ id: "R1", type: "agent:resume-plan-ready", min: 2, agentId: "coder", rootId: "E1", parentId: "E1" })
  const fromOps = ev({ id: "R2", type: "agent:resume-plan-ready", min: 3, agentId: "ops", rootId: "E1", node: "beta" })
  const fromPm = ev({ id: "R3", type: "agent:resume-plan-ready", min: 4, agentId: "pm", rootId: "E1" })
  const unrelated = ev({ id: "U1", type: "build:done", min: 5 })

  it("groups replies under the event that caused them, and shows each wake", () => {
    const shares: NodeEventsShare[] = [
      { node: "alpha", events: [restart, fromCoder, fromPm, unrelated], wakes: [
        wake({ agentId: "coder", eventId: "E1", rootId: "E1", startedAt: T0 + 5_000, endedAt: T0 + 120_000 }),
        wake({ agentId: "pm", eventId: "E1", rootId: "E1", status: "timed-out", endedAt: T0 + 25 * 60_000, error: "slot wait timed out after 25m" }),
      ] },
      // beta took E1 in from its mesh feed, so it holds it too: kept once.
      { node: "beta", events: [restart, fromOps], wakes: [
        wake({ agentId: "ops", eventId: "E1", rootId: "E1", startedAt: T0 + 3 * 60_000 }),
      ] },
    ]
    const feed = groupEventsFeed(shares, { now: T0 + 30 * 60_000 })
    expect(feed.total).toBe(2)
    const t = feed.threads.find((x) => x.event.id === "E1")!
    expect(t.event.ref).toBe("4b63f428")
    // parentId, the woken sender's root and the shared root each link one reply.
    expect(t.replies.map((r) => r.event.id)).toEqual(["R1", "R2", "R3"])
    expect(t.wakes.map((w) => [w.agentId, w.node, w.status, w.waitedMs])).toEqual([
      ["coder", "alpha", "ran", 5_000],
      ["ops", "beta", "ran", 3 * 60_000],
      ["pm", "alpha", "timed-out", 25 * 60_000],
    ])
    expect(feed.counts).toMatchObject({ events: 5, wakes: 3, ran: 2, timedOut: 1 })
    // An event that is its own root answers nothing.
    expect(feed.threads.find((x) => x.event.id === "U1")!.replies).toEqual([])
  })

  it("puts the thread with the newest activity first and honours the limit", () => {
    const late = ev({ id: "R9", type: "agent:resume-plan-ready", min: 30, agentId: "coder", rootId: "E1", parentId: "E1" })
    const feed = groupEventsFeed([{ node: "alpha", events: [restart, unrelated, late], wakes: [] }], { limit: 1 })
    expect(feed.threads.map((t) => t.event.id)).toEqual(["E1"])
    expect(feed.total).toBe(2)
  })

  it("lists only named events and announcements from a node's ring", () => {
    const bus = new TypedEventBus().configure({ node: "alpha" })
    bus.publish({ kind: "agent", type: "task:started", summary: "started" })
    bus.publish({ kind: "announce", type: "announce", summary: "maintenance at 6" })
    publishNamedEvent(bus, { name: "build:done" }, new Set())
    const share = nodeEventsFeed(bus, new WakeJournal())
    expect(share.events.map((e) => e.type)).toEqual(["announce", "build:done"])
    expect(share.node).toBe("alpha")
  })
})

describe("the Hub's events read", () => {
  it("merges every machine that answered and names the one that did not", async () => {
    const reply = await buildWallEvents(new URLSearchParams(), {
      local: async () => ({ node: "alpha", events: [ev({ id: "E1", type: "daemon:restart-soon", min: 0 })], wakes: [] }),
      peers: [{ name: "gamma", read: async () => { throw new Error("key refused (answered 401)") } }],
      now: T0,
    })
    expect(reply.node).toBe("alpha")
    expect(reply.nodes).toEqual([{ name: "alpha", ok: true }, { name: "gamma", ok: false, error: "key refused (answered 401)" }])
    expect(reply.threads).toHaveLength(1)
  })

  it("is served by the dashboard from its daemon's /events/hub, redacted", async () => {
    const share: NodeEventsShare = {
      node: "alpha",
      events: [ev({ id: "E1", type: "deploy:done", min: 0, summary: "deployed, token=supersecretvalue123" })],
      wakes: [wake({ agentId: "coder", eventId: "E1", rootId: "E1" })],
    }
    const asked: string[] = []
    const daemon = createServer((req, res) => {
      asked.push(req.url || "")
      res.writeHead(req.url === "/events/hub" ? 200 : 404, { "Content-Type": "application/json" })
      res.end(JSON.stringify(req.url === "/events/hub" ? share : { error: "nope" }))
    })
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", () => r()))
    const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`
    const config = daemonConfigSchema.parse({ node: { id: "alpha", name: "alpha" }, agents: {}, dashboard: { daemonUrl } })
    const board = createServer((req, res) => { void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx) })
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", () => r()))
    const base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`
    try {
      const body = await (await fetch(`${base}/api/admin/wall/events`)).json() as any
      expect(asked).toContain("/events/hub")
      expect(body.threads[0].event.type).toBe("deploy:done")
      expect(body.threads[0].event.summary).not.toContain("supersecretvalue123")
      expect(body.threads[0].wakes[0]).toMatchObject({ agentId: "coder", node: "alpha", status: "ran" })
      const raw = await (await fetch(`${base}/api/admin/wall/events?scope=node`)).json() as any
      expect(raw.events).toHaveLength(1)
      expect(raw.threads).toBeUndefined()
    } finally {
      await new Promise<void>((r) => board.close(() => r()))
      await new Promise<void>((r) => daemon.close(() => r()))
    }
  })

  it("has an Events view in the Hub nav that only reads", () => {
    const html = renderWallPage({} as any)
    expect(html).toContain('data-nav="events"')
    expect(html).toContain('id="wall-events"')
    expect(WALL_EVENTS_SCRIPT).toContain("/api/admin/wall/events")
    expect(WALL_EVENTS_SCRIPT).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/)
    expect(() => new Function(WALL_PAGE_SCRIPT)).not.toThrow()
  })
})
