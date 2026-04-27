import { describe, it, expect, beforeEach } from "vitest"
import { getEventBus } from "../src/events/bus"

describe("event bus", () => {
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
    // Node EventEmitter throws on uncaught listener errors by default
    // unless we wrap. The bus does NOT yet swallow — emit() will throw.
    // This test documents current behavior; if we add guarding, update.
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
})
