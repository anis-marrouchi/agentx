import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #1647 — an event wake that waited for a busy agent ran as if its event
// were new (a restart warning acted on 14 minutes late), and one that
// was given up was only a daemon log line. Now
// the late wake is told the event's age when it really starts, and a
// dropped wake is published as a `wake:dropped` event.

const gate = vi.hoisted(() => ({ release: () => {}, calls: [] as string[] }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any) => {
      gate.calls.push(task.message)
      if (gate.calls.length === 1) return new Promise((res) => { gate.release = () => res({ content: "ok", duration: 1 }) })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { formatAge, staleEventNote } from "../src/agents/message-queue"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus, TypedEventBus } from "../src/events/bus"
import { publishNamedEvent } from "../src/events/emit"
import type { EventEnvelope } from "../src/events/envelope"
import type { SubscriptionInput } from "../src/events/subscriptions"
import { EventWaker, RETRY_ATTEMPTS, WAKE_DROPPED, wakeDroppedEnvelope, wakeMessage } from "../src/events/wake"

const MIN = 60_000
const tick = () => new Promise((r) => setImmediate(r))
let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-wake-age-"))
  process.chdir(dir)
  gate.calls.length = 0
  getEventBus().removeAllListeners()
})
afterEach(() => {
  vi.useRealTimers()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry() {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })
  return new AgentRegistry(config, () => {})
}

describe("staleEventNote", () => {
  it("states the event's age, emit time and run time past one minute", () => {
    const at = Date.parse("2026-10-31T16:30:58Z")
    const note = staleEventNote(at, at + 14 * MIN)!
    expect(note).toContain("event age: 14m")
    expect(note).toContain("emitted at 16:30 UTC")
    expect(note).toContain("running at 16:44 UTC")
    expect(note).toMatch(/take no action if it has passed/)
  })

  it("is null for a prompt wake or an unknown emit time", () => {
    const at = Date.now()
    expect(staleEventNote(at, at + 30_000)).toBeNull()
    expect(staleEventNote(Number.NaN)).toBeNull()
  })

  it("formats ages in words", () => {
    expect(formatAge(45_000)).toBe("45s")
    expect(formatAge(14 * MIN)).toBe("14m")
    expect(formatAge(125 * MIN)).toBe("2h 5m")
    expect(formatAge(120 * MIN)).toBe("2h")
  })
})

describe("an event wake on a busy agent", () => {
  it("runs once the slot frees, told how old its event is", async () => {
    const r = registry()
    const busy = r.execute({ message: "long cron job", agentId: "coder", context: { channel: "cron", chatId: "cron:x" } })
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1))

    // The event was emitted 14 minutes ago; the wake has been waiting since.
    const eventAt = Date.now() - 14 * MIN
    const wake = r.execute({ message: "[Event] daemon:restart-soon", agentId: "coder", eventAt, context: { channel: "events", chatId: "coder" } })
    await new Promise((res) => setTimeout(res, 50))
    expect(gate.calls).toHaveLength(1)

    gate.release()
    await busy
    const res = await wake
    expect(res.error).toBeUndefined()
    expect(gate.calls).toHaveLength(2)
    expect(gate.calls[1]).toMatch(/^\[event age: 1[45]m — emitted at /)
    expect(gate.calls[1]).toContain("[Event] daemon:restart-soon")
  }, 15_000)

  it("gets no note when it starts within a minute of its event", async () => {
    gate.calls.push("(no hold)")
    const r = registry()
    const res = await r.execute({ message: "[Event] build:done", agentId: "coder", eventAt: Date.now(), context: { channel: "events", chatId: "coder" } })
    expect(res.error).toBeUndefined()
    expect(gate.calls[1]).toBe("[Event] build:done")
  })

  it("is refused as agent_busy past its slot wait", async () => {
    const r = registry()
    const busy = r.execute({ message: "long cron job", agentId: "coder", context: { channel: "cron", chatId: "cron:x" } })
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1))
    const res = await r.execute({ message: "[Event] x", agentId: "coder", slotWaitMs: 100, context: { channel: "events", chatId: "coder" } })
    expect(res.errorKind).toBe("agent_busy")
    expect(res.error).toMatch(/slot wait timed out/)
    gate.release()
    await busy
  }, 15_000)
})

describe("the wake message", () => {
  it("states when the event was emitted", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const r = publishNamedEvent(bus, { name: "daemon:restart-soon" }, new Set())
    if (!r.ok) throw new Error(r.error)
    expect(wakeMessage(r.event)).toContain(`at ${r.event.at}`)
  })
})

describe("a dropped wake", () => {
  const AGENTS = new Set(["ops", "coder"])

  function setup(result: () => unknown) {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const agents: Record<string, { subscriptions?: SubscriptionInput[] }> = {
      coder: { subscriptions: [{ kinds: ["daemon:restart-soon"], delivery: "wake", maxPerHour: 4 }] },
      ops: { subscriptions: [{ kinds: [WAKE_DROPPED], delivery: "pull" }] },
    }
    const logs: string[] = []
    const published: EventEnvelope[] = []
    bus.subscribe((e) => { if (e.type === WAKE_DROPPED) published.push(e) })
    const waker = new EventWaker({
      agents: () => agents,
      dispatch: () => Promise.resolve(result()),
      onDropped: (agentId, e, reason) => { bus.publish(wakeDroppedEnvelope(agentId, e, reason)) },
      log: (m) => logs.push(m),
      isLocal: (e) => bus.isLocal(e),
    })
    waker.attach(bus)
    return { bus, logs, published, waker }
  }

  it("is published as wake:dropped under the event's root when dispatch gives it up", async () => {
    const { bus, logs, published } = setup(() => ({ dropped: `Agent "coder" busy — slot wait timed out after 25m` }))
    const r = publishNamedEvent(bus, { name: "daemon:restart-soon", by: "ops" }, AGENTS)
    if (!r.ok) throw new Error(r.error)
    await tick(); await tick()
    expect(published).toHaveLength(1)
    const d = published[0]
    expect(d).toMatchObject({ kind: "custom", type: WAKE_DROPPED, agentId: "coder", rootId: r.event.rootId, parentId: r.event.id, ref: r.event.id })
    expect(d.summary).toContain("Wake of coder for daemon:restart-soon")
    expect(d.summary).toContain("slot wait timed out after 25m")
    expect(d.summary).toMatch(/event age \d+s/)
    expect(logs.some((l) => l.includes("wake of coder dropped: Agent \"coder\" busy"))).toBe(true)
  })

  it("is published when a held wake runs out of retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { bus, published, waker } = setup(() => ({ held: "plan window rejected" }))
    publishNamedEvent(bus, { name: "daemon:restart-soon" }, AGENTS)
    await tick(); await tick()
    for (let i = 0; i < RETRY_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(60 * MIN)
      await tick(); await tick()
    }
    expect(waker.pendingRetries()).toBe(0)
    expect(published).toHaveLength(1)
    expect(published[0].summary).toContain(`still held after ${RETRY_ATTEMPTS} retries: plan window rejected`)
  })

  it("is not reported when the wake ran", async () => {
    const { bus, published } = setup(() => ({ content: "ok" }))
    publishNamedEvent(bus, { name: "daemon:restart-soon" }, AGENTS)
    await tick(); await tick()
    expect(published).toHaveLength(0)
  })
})
