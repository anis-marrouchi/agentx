import { afterEach, describe, expect, it, vi } from "vitest"
import { TypedEventBus } from "../src/events/bus"
import { publishNamedEvent } from "../src/events/emit"
import { EventWaker, RETRY_ATTEMPTS, RETRY_BASE_MS, wakeMessage } from "../src/events/wake"
import type { EventEnvelope } from "../src/events/envelope"
import type { SubscriptionInput } from "../src/events/subscriptions"
import { isControlPost } from "../src/daemon/mesh-auth"
import { emitBody } from "../src/commands/events"

// Named events (#1284): a script or an agent emits `render:ready`, and the
// agents whose wake subscription lists it start a turn that sees it.

const AGENTS = new Set(["builder", "renderer", "watcher"])
const tick = () => new Promise((r) => setImmediate(r))

function setup(agents: Record<string, { subscriptions?: SubscriptionInput[] }>, node = "node-a") {
  const bus = new TypedEventBus().configure({ node })
  const woke: Array<{ agentId: string; e: EventEnvelope; message: string }> = []
  const logs: string[] = []
  let held: string | undefined
  const waker = new EventWaker({
    agents: () => agents,
    dispatch: (agentId, e, sub) => {
      if (held) return Promise.resolve({ held })
      woke.push({ agentId, e, message: wakeMessage(e, sub.prompt) })
      return Promise.resolve({ content: "ok" })
    },
    log: (m) => logs.push(m),
    isLocal: (e) => bus.isLocal(e),
  })
  const stop = waker.attach(bus)
  return { bus, woke, logs, waker, stop, hold: (reason: string | undefined) => { held = reason } }
}

afterEach(() => { vi.useRealTimers() })

describe("publishNamedEvent", () => {
  it("publishes a custom envelope whose type is the name", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const r = publishNamedEvent(bus, { name: "render:ready", summary: "batch 3 done", ref: "renders/b3" }, AGENTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event).toMatchObject({ kind: "custom", type: "render:ready", summary: "batch 3 done", ref: "renders/b3", node: "node-a" })
    expect(r.event.agentId).toBeUndefined()
    expect(r.event.rootId).toBe(r.event.id)
  })

  it("credits the running turn's agent and keeps its root", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const r = publishNamedEvent(bus, { name: "build:done", by: "someone" }, AGENTS, { agentId: "builder", rootId: "ROOT-1" })
    expect(r.ok && r.event.agentId).toBe("builder")
    expect(r.ok && r.event.rootId).toBe("ROOT-1")
    // No summary: the name stands in.
    expect(r.ok && r.event.summary).toBe("build:done")
  })

  it("names an agent author by `by`, and anyone else in the summary", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const a = publishNamedEvent(bus, { name: "x", by: "renderer" }, AGENTS)
    expect(a.ok && a.event.agentId).toBe("renderer")
    const p = publishNamedEvent(bus, { name: "x", summary: "done", by: "cron-script" }, AGENTS)
    expect(p.ok && p.event.agentId).toBeUndefined()
    expect(p.ok && p.event.summary).toBe("cron-script: done")
  })

  it("rejects a missing or malformed name and oversized fields", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    expect(publishNamedEvent(bus, {}, AGENTS).ok).toBe(false)
    expect(publishNamedEvent(bus, { name: "has space" }, AGENTS).ok).toBe(false)
    expect(publishNamedEvent(bus, { name: ":leading" }, AGENTS).ok).toBe(false)
    expect(publishNamedEvent(bus, { name: "a".repeat(65) }, AGENTS).ok).toBe(false)
    expect(publishNamedEvent(bus, { name: "ok", summary: "y".repeat(2001) }, AGENTS).ok).toBe(false)
    expect(publishNamedEvent(bus, { name: "ok", ref: "r".repeat(201) }, AGENTS).ok).toBe(false)
  })

  it("is a control POST, so off-box callers need the mesh token", () => {
    expect(isControlPost("/events")).toBe(true)
  })
})

describe("waking on a named event", () => {
  it("wakes a subscriber once, with the event and its prompt in the message", async () => {
    const { bus, woke } = setup({
      renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 4, prompt: "Upload the batch to the Space." }] },
      watcher: { subscriptions: [{ kinds: ["build:done"], delivery: "wake", maxPerHour: 4 }] },
    })
    publishNamedEvent(bus, { name: "render:ready", summary: "batch 3 done", ref: "renders/b3" }, AGENTS)
    await tick()
    expect(woke.map((w) => w.agentId)).toEqual(["renderer"])
    const msg = woke[0].message
    expect(msg).toContain("render:ready")
    expect(msg).toContain("batch 3 done")
    expect(msg).toContain("ref renders/b3")
    expect(msg).toContain("emitted by node-a")
    expect(msg).toContain("When this event arrives: Upload the batch to the Space.")
  })

  it("names the emitting agent in the message", () => {
    const e: EventEnvelope = { id: "e1", rootId: "e1", node: "node-a", agentId: "builder", kind: "custom", type: "build:done", at: new Date().toISOString(), summary: "ok" }
    expect(wakeMessage(e)).toContain("emitted by builder on node-a")
    expect(wakeMessage(e)).toContain("reply briefly that no action is needed")
  })

  it("wakes across the mesh only when the subscription names the emitting node", async () => {
    const remote = new TypedEventBus().configure({ node: "node-b" })
    const r = publishNamedEvent(remote, { name: "render:ready" }, AGENTS)
    if (!r.ok) throw new Error(r.error)

    const broad = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 4 }] } })
    broad.bus.ingest(r.event)
    await tick()
    expect(broad.woke).toEqual([])

    const named = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], nodes: ["node-b"], delivery: "wake", maxPerHour: 4 }] } })
    named.bus.ingest(r.event)
    await tick()
    expect(named.woke.map((w) => w.agentId)).toEqual(["renderer"])
  })

  it("keeps the loop guard: an event emitted by a woken turn does not wake its cause", async () => {
    const { bus, woke } = setup({
      builder: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 10 }] },
      renderer: { subscriptions: [{ kinds: ["build:done"], delivery: "wake", maxPerHour: 10 }] },
    })
    // builder emits build:done under its own root; renderer is woken.
    const first = publishNamedEvent(bus, { name: "build:done" }, AGENTS, { agentId: "builder", rootId: "R1" })
    await tick()
    expect(woke.map((w) => w.agentId)).toEqual(["renderer"])
    expect(first.ok && first.event.rootId).toBe("R1")
    // The woken renderer turn runs under R1 and emits render:ready from it.
    publishNamedEvent(bus, { name: "render:ready" }, AGENTS, { agentId: "renderer", rootId: "R1" })
    await tick()
    expect(woke.map((w) => w.agentId)).toEqual(["renderer"])
  })

  it("applies maxPerHour to emitted events", async () => {
    const { bus, woke, logs } = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 2 }] } })
    for (let i = 0; i < 3; i++) publishNamedEvent(bus, { name: "render:ready", summary: `b${i}` }, AGENTS)
    await tick()
    expect(woke).toHaveLength(2)
    expect(logs.some((l) => l.includes("rate-limit"))).toBe(true)
  })
})

describe("a wake held by the dispatch cap", () => {
  it("is retried after a delay and logged with its reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { bus, woke, logs, waker, hold } = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 4 }] } })
    hold("Local dispatch cap reached: 400/400 claude-code runs in the last 5h.")
    publishNamedEvent(bus, { name: "render:ready" }, AGENTS)
    await tick(); await tick()
    expect(woke).toHaveLength(0)
    expect(waker.pendingRetries()).toBe(1)
    expect(logs.find((l) => l.includes("held:"))).toContain("Local dispatch cap reached")

    hold(undefined)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await tick(); await tick()
    expect(woke.map((w) => w.agentId)).toEqual(["renderer"])
    expect(waker.pendingRetries()).toBe(0)
  })

  it("is given up, and logged, after the last retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { bus, logs, waker, hold } = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 4 }] } })
    hold("plan window rejected")
    publishNamedEvent(bus, { name: "render:ready" }, AGENTS)
    await tick(); await tick()
    for (let i = 0; i < RETRY_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      await tick(); await tick()
    }
    expect(waker.pendingRetries()).toBe(0)
    expect(logs.some((l) => l.includes(`dropped after ${RETRY_ATTEMPTS} retries`))).toBe(true)
  })

  it("is cancelled when the waker is detached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { bus, waker, hold, stop } = setup({ renderer: { subscriptions: [{ kinds: ["render:ready"], delivery: "wake", maxPerHour: 4 }] } })
    hold("cap")
    publishNamedEvent(bus, { name: "render:ready" }, AGENTS)
    await tick(); await tick()
    expect(waker.pendingRetries()).toBe(1)
    stop()
    expect(waker.pendingRetries()).toBe(0)
  })
})

describe("a wake whose agent stays busy (#1596)", () => {
  it("is retried rather than dropped after the slot wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { bus, woke, logs, waker, hold } = setup({ coder: { subscriptions: [{ kinds: ["daemon:restart-soon"], delivery: "wake" }] } })
    hold(`Agent "coder" busy — slot wait timed out after 25m`)
    publishNamedEvent(bus, { name: "daemon:restart-soon" }, AGENTS)
    await tick(); await tick()
    expect(waker.pendingRetries()).toBe(1)
    expect(logs.find((l) => l.includes("held:"))).toContain("slot wait timed out")
    hold(undefined)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await tick(); await tick()
    expect(woke.map((w) => w.agentId)).toEqual(["coder"])
  })
})

describe("agentx events emit", () => {
  it("sends the running turn's ids so the daemon credits the agent", () => {
    const body = emitBody("render:ready", { summary: "done" }, { AGENTX_AGENT_ID: "renderer", AGENTX_TASK_ID: "T1" } as any)
    expect(body).toEqual({ name: "render:ready", summary: "done", by: "renderer", senderAgentId: "renderer", callerTaskId: "T1" })
  })

  it("outside a turn sends only what was given", () => {
    expect(emitBody("build:done", { by: "ci", ref: "pipeline/42" }, {} as any)).toEqual({ name: "build:done", by: "ci", ref: "pipeline/42" })
  })
})
