import { describe, expect, it } from "vitest"
import { TypedEventBus } from "../src/events/bus"
import type { EventEnvelope } from "../src/events/envelope"
import { EventWaker } from "../src/events/wake"
import { eventsForAgent } from "../src/events/subscriptions"

// Events that reached this node from a peer through the mesh feed (#166)
// wake an agent only when its wake subscription names that peer in `nodes`.

const peerEvent = (id: string, node = "node-b"): EventEnvelope =>
  ({ id, rootId: `R-${id}`, node, agentId: "helper", kind: "agent", type: "task:completed", at: new Date().toISOString(), summary: "completed in 5ms" })

function setup(subscriptions: any[]) {
  const bus = new TypedEventBus().configure({ node: "node-a" })
  const woke: string[] = []
  const agents = { watcher: { subscriptions } }
  new EventWaker({
    agents: () => agents,
    dispatch: (_agentId, e) => { woke.push(e.id) },
    log: () => {},
    isLocal: (e) => bus.isLocal(e),
  }).attach(bus)
  return { bus, woke, agents }
}

const tick = () => new Promise((r) => setImmediate(r))

describe("wake on peer events", () => {
  it("does not wake a broad subscription for another machine's events", async () => {
    const { bus, woke } = setup([{ kinds: ["task:completed"], delivery: "wake", maxPerHour: 10 }])
    bus.ingest(peerEvent("p1"))
    await tick()
    expect(woke).toEqual([])
    // A local event still wakes it.
    bus.emit("task:completed", { agentId: "helper", channel: "cron", chatId: "c", durationMs: 5, at: new Date().toISOString(), taskId: "T-local" })
    await tick()
    expect(woke).toHaveLength(1)
  })

  it("wakes when the subscription names that node", async () => {
    const { bus, woke } = setup([{ kinds: ["task:completed"], nodes: ["node-b"], delivery: "wake", maxPerHour: 10 }])
    bus.ingest(peerEvent("p1"))
    bus.ingest(peerEvent("p2", "node-c"))
    await tick()
    expect(woke).toEqual(["p1"])
  })

  it("still lets pull subscriptions read peer events", () => {
    const { bus, agents } = setup([{ kinds: ["task:completed"], delivery: "wake", maxPerHour: 10 }])
    bus.ingest(peerEvent("p1"))
    expect(eventsForAgent("watcher", agents.watcher.subscriptions, bus.recent()).map((e) => e.id)).toEqual(["p1"])
  })
})
