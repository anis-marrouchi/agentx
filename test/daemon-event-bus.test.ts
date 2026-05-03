import { describe, expect, it } from "vitest"
import { EventBus, matches, parseKindsParam, type DaemonEvent } from "../src/daemon/event-bus"

describe("EventBus", () => {
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
