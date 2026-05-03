import { describe, it, expect, beforeEach } from "vitest"
import { getEventBus } from "../src/events/bus"
import { EventBus, matches, parseKindsParam, type DaemonEvent } from "../src/daemon/event-bus"
import { splitTaskUsageByTier, CONTEXT_TIER_THRESHOLD } from "../src/daemon/token-tracker"

describe("event bus (legacy EventEmitter)", () => {
  beforeEach(() => {
    getEventBus().removeAllListeners()
  })

  it("delivers a typed event to a subscriber", () => {
    const bus = getEventBus()
    const received: any[] = []
    bus.on("task:started", (p) => received.push(p))
    bus.emit("task:started", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      messagePreview: "hi",
      at: "2026-04-27T18:00:00.000Z",
    })
    expect(received).toHaveLength(1)
    expect(received[0].agentId).toBe("coder-agent")
    expect(received[0].channel).toBe("telegram")
  })

  it("supports multiple subscribers", () => {
    const bus = getEventBus()
    const a: any[] = []
    const b: any[] = []
    bus.on("message:matched", (p) => a.push(p))
    bus.on("message:matched", (p) => b.push(p))
    bus.emit("message:matched", {
      channel: "telegram",
      chatId: "x",
      msgId: "1",
      agentId: "coder-agent",
      decidingStage: "dm-binding",
      at: "2026-04-27T18:00:00.000Z",
    })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it("off() removes a listener", () => {
    const bus = getEventBus()
    const received: any[] = []
    const fn = (p: any) => received.push(p)
    bus.on("session:rotated", fn)
    bus.off("session:rotated", fn)
    bus.emit("session:rotated", {
      agentId: "x",
      channel: "telegram",
      chatId: "y",
      reason: "tier-2",
      at: "2026-04-27T18:00:00.000Z",
    })
    expect(received).toHaveLength(0)
  })

  it("subscriber error does not crash other subscribers", () => {
    const bus = getEventBus()
    const ok: any[] = []
    bus.on("task:completed", () => { throw new Error("boom") })
    bus.on("task:completed", (p) => ok.push(p))
    expect(() =>
      bus.emit("task:completed", {
        agentId: "x", channel: "api", chatId: "y",
        durationMs: 100, at: "2026-04-27T18:00:00.000Z",
      }),
    ).toThrow("boom")
  })

  it("session:rotated carries reason + lastTurnInputTokens", () => {
    const bus = getEventBus()
    const events: any[] = []
    bus.on("session:rotated", (p) => events.push(p))
    bus.emit("session:rotated", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      reason: "tier-2",
      lastTurnInputTokens: 245_000,
      at: "2026-04-27T18:00:00.000Z",
    })
    expect(events[0].reason).toBe("tier-2")
    expect(events[0].lastTurnInputTokens).toBe(245_000)
  })

  it("getEventBus returns the same singleton", () => {
    expect(getEventBus()).toBe(getEventBus())
  })

  it("task:completed carries optional tier-2 token fields", () => {
    const bus = getEventBus()
    const events: any[] = []
    bus.on("task:completed", (p) => events.push(p))
    bus.emit("task:completed", {
      agentId: "coder-agent",
      channel: "telegram",
      chatId: "1816212449",
      durationMs: 30_000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      tier2InputTokens: 12_000,
      tier2OutputTokens: 800,
      tier2CacheReadTokens: 250_000,
      tier2CacheCreateTokens: 500,
      at: "2026-04-30T18:00:00.000Z",
    })
    expect(events[0].tier2InputTokens).toBe(12_000)
    expect(events[0].tier2CacheReadTokens).toBe(250_000)
  })
})

describe("splitTaskUsageByTier", () => {
  it("returns tier1 buckets when totalInput is below threshold", () => {
    const split = splitTaskUsageByTier({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 50_000,
      cacheCreateTokens: 1_000,
    })
    expect(split.inputTokens).toBe(1_000)
    expect(split.cacheReadTokens).toBe(50_000)
    expect(split.tier2InputTokens).toBe(0)
    expect(split.tier2CacheReadTokens).toBe(0)
  })

  it("returns tier2 buckets when totalInput crosses threshold", () => {
    const split = splitTaskUsageByTier({
      inputTokens: 5_000,
      outputTokens: 800,
      cacheReadTokens: CONTEXT_TIER_THRESHOLD + 1,
      cacheCreateTokens: 0,
    })
    expect(split.inputTokens).toBe(0)
    expect(split.outputTokens).toBe(0)
    expect(split.cacheReadTokens).toBe(0)
    expect(split.tier2InputTokens).toBe(5_000)
    expect(split.tier2OutputTokens).toBe(800)
    expect(split.tier2CacheReadTokens).toBe(CONTEXT_TIER_THRESHOLD + 1)
  })

  it("treats output as inheriting the request's tier", () => {
    const tier2 = splitTaskUsageByTier({
      inputTokens: 100, outputTokens: 999,
      cacheReadTokens: CONTEXT_TIER_THRESHOLD, cacheCreateTokens: 1,
    })
    expect(tier2.tier2OutputTokens).toBe(999)
    expect(tier2.outputTokens).toBe(0)
  })
})

describe("EventBus (daemon)", () => {
  it("delivers matching events to subscribers", () => {
    const bus = new EventBus()
    const received: DaemonEvent[] = []
    bus.subscribe({}, (e) => received.push(e))
    bus.publish({ kind: "run", runId: "r1", workflowId: "w", phase: "ok" } as any)
    bus.publish({ kind: "task", taskId: "t", workflowId: "w", runId: "r1", phase: "created" } as any)
    expect(received).toHaveLength(2)
    expect(received[0].kind).toBe("run")
    expect(received[1].kind).toBe("task")
  })

  it("filters by kind", () => {
    const bus = new EventBus()
    const received: DaemonEvent[] = []
    bus.subscribe({ kinds: ["run"] }, (e) => received.push(e))
    bus.publish({ kind: "run", runId: "r", workflowId: "w", phase: "ok" } as any)
    bus.publish({ kind: "task", taskId: "t", workflowId: "w", runId: "r", phase: "created" } as any)
    bus.publish({ kind: "signal", name: "x", scope: "workflow" } as any)
    expect(received.map((e) => e.kind)).toEqual(["run"])
  })

  it("filters by workflowId across run + task + signal", () => {
    const bus = new EventBus()
    const received: DaemonEvent[] = []
    bus.subscribe({ workflowId: "a" }, (e) => received.push(e))
    bus.publish({ kind: "run", runId: "r", workflowId: "a", phase: "ok" } as any)
    bus.publish({ kind: "run", runId: "r", workflowId: "b", phase: "ok" } as any)
    bus.publish({ kind: "task", taskId: "t", workflowId: "a", runId: "r", phase: "created" } as any)
    bus.publish({ kind: "signal", name: "x", scope: "workflow", workflowId: "b" } as any)
    expect(received).toHaveLength(2)
    expect(received.every((e) => (e as any).workflowId === "a")).toBe(true)
  })

  it("filters task events by actor on assignedTo OR submittedBy", () => {
    expect(matches({ actor: "actor:alice" }, { kind: "task", id: "i", at: "t", taskId: "tx", workflowId: "w", runId: "r", phase: "created", assignedTo: ["actor:alice"] } as DaemonEvent)).toBe(true)
    expect(matches({ actor: "actor:alice" }, { kind: "task", id: "i", at: "t", taskId: "tx", workflowId: "w", runId: "r", phase: "submitted", submittedBy: "actor:alice" } as DaemonEvent)).toBe(true)
    expect(matches({ actor: "actor:bob" },   { kind: "task", id: "i", at: "t", taskId: "tx", workflowId: "w", runId: "r", phase: "created", assignedTo: ["actor:alice"] } as DaemonEvent)).toBe(false)
  })

  it("unsubscribe stops further deliveries", () => {
    const bus = new EventBus()
    const received: DaemonEvent[] = []
    const stop = bus.subscribe({}, (e) => received.push(e))
    bus.publish({ kind: "run", runId: "r", workflowId: "w", phase: "ok" } as any)
    stop()
    bus.publish({ kind: "run", runId: "r", workflowId: "w", phase: "failed" } as any)
    expect(received).toHaveLength(1)
  })

  it("swallows listener errors — a bad subscriber can't kill the fanout", () => {
    const bus = new EventBus()
    const good: DaemonEvent[] = []
    bus.subscribe({}, () => { throw new Error("boom") })
    bus.subscribe({}, (e) => good.push(e))
    bus.publish({ kind: "run", runId: "r", workflowId: "w", phase: "ok" } as any)
    expect(good).toHaveLength(1)
  })

  it("parseKindsParam tolerates unknown values", () => {
    expect(parseKindsParam("run,task")).toEqual(["run", "task"])
    expect(parseKindsParam("run,bogus,task")).toEqual(["run", "task"])
    expect(parseKindsParam("")).toBeUndefined()
    expect(parseKindsParam(null)).toBeUndefined()
  })
})
