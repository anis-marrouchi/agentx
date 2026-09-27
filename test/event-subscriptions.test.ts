import { beforeEach, describe, expect, it } from "vitest"
import { getEventBus, TypedEventBus } from "../src/events/bus"
import { withRoot, type EventEnvelope } from "../src/events/envelope"
import {
  digestEvents, eventsForAgent, matchesSubscription, renderDigest, DIGEST_MAX, PULL_MAX,
} from "../src/events/subscriptions"
import { EventWaker, wakeMessage } from "../src/events/wake"
import { daemonConfigSchema, eventSubscriptionSchema } from "../src/daemon/config"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { renderEventsAnswer } from "../src/mcp/index"
import { formatEventLine } from "../src/events/subscriptions"
import { eventsUrl } from "../src/commands/events"

beforeEach(() => { getEventBus().removeAllListeners() })

const at = () => new Date().toISOString()

function completed(bus: TypedEventBus, agentId: string, extra: Record<string, unknown> = {}) {
  bus.emit("task:completed", { agentId, channel: "cron", chatId: "cron:x", durationMs: 5, at: at(), taskId: `T-${agentId}`, ...extra })
}

describe("subscriptions config", () => {
  it("defaults delivery to pull and wake to 4 per hour", () => {
    const sub = eventSubscriptionSchema.parse({ kinds: ["task:completed"] })
    expect(sub).toMatchObject({ kinds: ["task:completed"], delivery: "pull", maxPerHour: 4 })
  })

  it("keeps subscriptions on an agent instead of stripping them", () => {
    const cfg = daemonConfigSchema.parse({
      node: { id: "n1", name: "n1" },
      agents: { a: { name: "A", workspace: "/tmp/a", subscriptions: [{ kinds: ["run"], nodes: ["n1"], match: "failed", delivery: "digest" }] } },
    })
    expect(cfg.agents.a.subscriptions).toEqual([{ kinds: ["run"], nodes: ["n1"], match: "failed", delivery: "digest", maxPerHour: 4 }])
  })

  it("rejects an unknown delivery, empty kinds and an out-of-range limit", () => {
    expect(eventSubscriptionSchema.safeParse({ kinds: ["run"], delivery: "push" }).success).toBe(false)
    expect(eventSubscriptionSchema.safeParse({ kinds: [] }).success).toBe(false)
    expect(eventSubscriptionSchema.safeParse({ kinds: ["run"], maxPerHour: 0 }).success).toBe(false)
  })
})

describe("matching", () => {
  const e: EventEnvelope = { id: "1", rootId: "r", node: "n1", agentId: "b", kind: "agent", type: "task:completed", at: at(), summary: "failed after 5ms: Timeout" }

  it("matches on kind or type, and every filter must agree", () => {
    expect(matchesSubscription({ kinds: ["agent"] }, e, "a")).toBe(true)
    expect(matchesSubscription({ kinds: ["task:completed"], agents: ["b"], nodes: ["n1"], match: "TIMEOUT" }, e, "a")).toBe(true)
    expect(matchesSubscription({ kinds: ["*"] }, e, "a")).toBe(true)
    expect(matchesSubscription({ kinds: ["run"] }, e, "a")).toBe(false)
    expect(matchesSubscription({ kinds: ["agent"], agents: ["c"] }, e, "a")).toBe(false)
    expect(matchesSubscription({ kinds: ["agent"], nodes: ["n2"] }, e, "a")).toBe(false)
    expect(matchesSubscription({ kinds: ["agent"], match: "completed in" }, e, "a")).toBe(false)
  })

  it("skips the agent's own events unless it names itself", () => {
    expect(matchesSubscription({ kinds: ["agent"] }, e, "b")).toBe(false)
    expect(matchesSubscription({ kinds: ["agent"], agents: ["b"] }, e, "b")).toBe(true)
  })
})

describe("pull", () => {
  it("returns B's finished task to A when A subscribes to task:completed from B", () => {
    const bus = getEventBus()
    const subs = [{ kinds: ["task:completed"], agents: ["b"] }]
    completed(bus, "c")
    bus.emit("task:started", { agentId: "b", channel: "cron", chatId: "cron:x", messagePreview: "secret prompt", at: at(), taskId: "T-b" })
    completed(bus, "b", { finalResponse: "secret answer" })

    const events = eventsForAgent("a", subs, bus.recent())
    expect(events.map((e) => [e.agentId, e.type])).toEqual([["b", "task:completed"]])
    expect(events[0].ref).toBe("T-b")

    const answer = renderEventsAnswer("a", { subscriptions: 1, events, next: events[0].id }, formatEventLine)
    expect(answer).toContain("task:completed b@")
    expect(answer).not.toContain("secret")
    expect(answer).toContain(`next: ${events[0].id}`)
  })

  it("is bounded and reads after `since`", () => {
    const bus = new TypedEventBus()
    for (let i = 0; i < 80; i++) bus.publish({ kind: "run", type: "failed", summary: `run ${i}` })
    const all = bus.recent()
    expect(eventsForAgent("a", [{ kinds: ["run"] }], all, { limit: 500 })).toHaveLength(PULL_MAX)
    expect(eventsForAgent("a", [{ kinds: ["run"] }], all)).toHaveLength(20)
    const after = eventsForAgent("a", [{ kinds: ["run"] }], bus.recent({ since: all[77].id }))
    expect(after.map((e) => e.summary)).toEqual(["run 78", "run 79"])
    expect(eventsForAgent("a", [], all)).toEqual([])
  })

  it("pages through more than a page of matches after a cursor with no gaps", () => {
    const bus = new TypedEventBus()
    const subs = [{ kinds: ["run"] }]
    const ids: string[] = []
    for (let i = 0; i < 130; i++) ids.push(bus.publish({ kind: "run", type: "failed", summary: `run ${i}` }).id)
    // A reader has seen up to run 9; 120 newer matches remain.
    let since = ids[9]
    const read: string[] = []
    for (let page = 0; page < 10; page++) {
      const events = eventsForAgent("a", subs, bus.recent({ since }), { limit: 50, fromCursor: true })
      if (events.length === 0) break
      read.push(...events.map((e) => e.id))
      since = events[events.length - 1].id
    }
    expect(read).toEqual(ids.slice(10))
  })

  it("says so when the agent has no subscriptions", () => {
    expect(renderEventsAnswer("a", { subscriptions: 0, events: [] }, formatEventLine)).toContain("no event subscriptions")
  })

  it("is served off-box only with the mesh token", () => {
    expect(isMeshGatedPath("/agents/helper/events")).toBe(true)
    expect(isMeshGatedPath("/agents/helper/workspace/x")).toBe(false)
  })

  it("CLI reads one agent's digest or the node's recent events", () => {
    expect(eventsUrl("http://localhost:18800/", { agent: "helper", since: "abc" })).toBe("http://localhost:18800/agents/helper/events?since=abc")
    expect(eventsUrl("http://localhost:18800", { kind: "run" })).toBe("http://localhost:18800/events/recent?kind=run&limit=50")
  })
})

describe("digest", () => {
  it("lists digest events since the agent's last finished turn, capped", () => {
    const bus = new TypedEventBus()
    const subs = [{ kinds: ["run"], delivery: "digest" as const }, { kinds: ["agent"], delivery: "pull" as const }]
    bus.publish({ kind: "run", type: "failed", summary: "before" })
    completed(bus, "a")
    for (let i = 0; i < DIGEST_MAX + 3; i++) bus.publish({ kind: "run", type: "failed", summary: `after ${i}` })
    completed(bus, "b")

    const { shown, more } = digestEvents("a", subs, bus.recent())
    expect(shown).toHaveLength(DIGEST_MAX)
    expect(more).toBe(3)
    expect(shown.some((e) => e.summary === "before" || e.agentId === "b")).toBe(false)
    const text = renderDigest(shown, more)!
    expect(text).toContain(`${DIGEST_MAX + 3} matched`)
    expect(text).toContain("agentx_events")
    expect(renderDigest([], 0)).toBeUndefined()
  })
})

describe("wake", () => {
  function waker(subs: Record<string, any[]>, opts: { now?: () => number } = {}) {
    const logs: string[] = []
    const woke: Array<{ agentId: string; e: EventEnvelope }> = []
    const agents = Object.fromEntries(Object.entries(subs).map(([id, s]) => [id, { subscriptions: s }]))
    const w = new EventWaker({ agents: () => agents, dispatch: (agentId, e) => { woke.push({ agentId, e }) }, log: (m) => logs.push(m), now: opts.now })
    return { w, logs, woke }
  }

  it("skips the N+1th wake in an hour and logs it", async () => {
    let t = Date.parse("2026-09-27T10:00:00Z")
    const { w, logs, woke } = waker({ a: [{ kinds: ["task:completed"], delivery: "wake", maxPerHour: 3 }] }, { now: () => t })
    const bus = new TypedEventBus()
    w.attach(bus)
    // Each completion is its own entry point (own root).
    for (let i = 0; i < 4; i++) { completed(bus, "b"); t += 60_000 }
    await new Promise((r) => setImmediate(r))
    expect(woke).toHaveLength(3)
    expect(logs.filter((l) => l.includes("wake skipped for a: rate-limit"))).toHaveLength(1)

    // An hour after the first wake, a slot frees up.
    t = Date.parse("2026-09-27T11:00:30Z")
    completed(bus, "b")
    await new Promise((r) => setImmediate(r))
    expect(woke).toHaveLength(4)
  })

  it("never wakes an agent on its own events", async () => {
    const { w, woke } = waker({ a: [{ kinds: ["*"], agents: ["a"], delivery: "wake" }] })
    const outcomes = w.handle({ id: "1", rootId: "r1", node: "n", agentId: "a", kind: "agent", type: "task:completed", at: at(), summary: "done" })
    await new Promise((r) => setImmediate(r))
    expect(woke).toHaveLength(0)
    expect(outcomes).toEqual([{ agentId: "a", eventId: "1", woke: false, reason: "own-event" }])
  })

  it("does not wake on events descending from its own work, and wakes once per root", async () => {
    const { w, woke, logs } = waker({ a: [{ kinds: ["task:completed"], delivery: "wake", maxPerHour: 10 }] })
    const ev = (id: string, rootId: string, agentId: string): EventEnvelope =>
      ({ id, rootId, node: "n", agentId, kind: "agent", type: "task:completed", at: at(), summary: "done" })
    // a works under root R1; b's later completion under R1 is a's doing.
    w.handle(ev("1", "R1", "a"))
    expect(w.handle(ev("2", "R1", "b"))[0]).toMatchObject({ woke: false, reason: "own-root" })
    // A new root wakes a once; a second event on it is a duplicate.
    expect(w.handle(ev("3", "R2", "b"))[0]).toMatchObject({ woke: true })
    expect(w.handle(ev("4", "R2", "c"))[0]).toMatchObject({ woke: false, reason: "duplicate-root" })
    await new Promise((r) => setImmediate(r))
    expect(woke.map((x) => x.e.id)).toEqual(["3"])
    expect(logs.some((l) => l.includes("own-root"))).toBe(true)
  })

  it("keeps one rate bucket per subscription", async () => {
    const { w, woke, logs } = waker({
      a: [
        { kinds: ["run"], delivery: "wake", maxPerHour: 1 },
        { kinds: ["task:completed"], delivery: "wake", maxPerHour: 2 },
      ],
    })
    const ev = (id: string, kind: string, type: string): EventEnvelope =>
      ({ id, rootId: `R${id}`, node: "n", agentId: "b", kind, type, at: at(), summary: "" })
    expect(w.handle(ev("1", "run", "failed"))[0].woke).toBe(true)
    expect(w.handle(ev("2", "run", "failed"))[0]).toMatchObject({ woke: false, reason: "rate-limit" })
    // The run bucket is full; task:completed still has its own two wakes.
    expect(w.handle(ev("3", "agent", "task:completed"))[0].woke).toBe(true)
    expect(w.handle(ev("4", "agent", "task:completed"))[0].woke).toBe(true)
    expect(w.handle(ev("5", "agent", "task:completed"))[0]).toMatchObject({ woke: false, reason: "rate-limit" })
    await new Promise((r) => setImmediate(r))
    expect(woke.map((x) => x.e.id)).toEqual(["1", "3", "4"])
    expect(logs.filter((l) => l.includes("rate-limit"))).toHaveLength(2)
  })

  it("ignores agents whose subscriptions are not wake", () => {
    const { w } = waker({ a: [{ kinds: ["*"], delivery: "pull" }, { kinds: ["*"], delivery: "digest" }] })
    expect(w.handle({ id: "1", rootId: "r", node: "n", agentId: "b", kind: "agent", type: "task:completed", at: at(), summary: "" })).toEqual([])
  })

  it("a woken turn run under the event's root cannot wake the agent again", async () => {
    const bus = new TypedEventBus()
    const logs: string[] = []
    const woke: string[] = []
    const agents = {
      a: { subscriptions: [{ kinds: ["task:completed"], delivery: "wake" as const, maxPerHour: 10 }] },
      b: { subscriptions: [{ kinds: ["task:completed"], delivery: "wake" as const, maxPerHour: 10 }] },
    }
    // Each woken agent finishes a task under the root it was woken for.
    new EventWaker({
      agents: () => agents,
      dispatch: (agentId, e) => { woke.push(agentId); withRoot({ rootId: e.rootId, parentId: e.id }, () => completed(bus, agentId)) },
      log: (m) => logs.push(m),
    }).attach(bus)
    completed(bus, "c")
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    // c wakes a and b once each; their completions share c's root and stop there.
    expect(woke.sort()).toEqual(["a", "b"])
  })

  it("tells the woken agent what happened", () => {
    const text = wakeMessage({ id: "E1", rootId: "R1", node: "n", agentId: "b", kind: "agent", type: "task:completed", at: at(), summary: "completed in 5ms" })
    expect(text).toContain("task:completed b@n: completed in 5ms")
    expect(text).toContain("agentx_events")
  })
})
