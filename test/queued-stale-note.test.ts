import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #282: a message queued behind a long turn runs later with the text it had
// when it was queued. The agent then reports on that stale snapshot ("I
// checked the new head X" after Y was pushed). A flushed turn that waited
// long enough carries one line saying so; a short wait gets nothing.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { MessageQueue, STALE_QUEUE_NOTE_AFTER_MS, staleQueueNote } from "../src/agents/message-queue"
import { isQueued } from "../src/agents/queued"
import { getEventBus } from "../src/events/bus"
import { daemonConfigSchema } from "../src/daemon/config"

describe("staleQueueNote", () => {
  const at = Date.UTC(2026, 0, 5, 14, 2)

  it("is null for a short wait", () => {
    expect(staleQueueNote(at, at + 5_000)).toBeNull()
    expect(staleQueueNote(at, at + STALE_QUEUE_NOTE_AFTER_MS)).toBeNull()
  })

  it("is one line naming both times after a long wait", () => {
    const note = staleQueueNote(at, at + 17 * 60_000)!
    expect(note).toContain("queued at 14:02 UTC, running at 14:19 UTC")
    expect(note).toContain("re-check the current state")
    expect(note).not.toContain("\n")
  })
})

describe("MessageQueue collect batches keep the oldest queue time", () => {
  it("sets queuedAt to the earliest message, not the flush time", async () => {
    const q = new MessageQueue("collect")
    q.markRunning("a", "telegram", "c")
    q.enqueue("a", "telegram", "c", { text: "one", sender: "s", timestamp: 1_000, channel: "telegram", chatId: "c" })
    q.enqueue("a", "telegram", "c", { text: "two", sender: "s", timestamp: 5_000, channel: "telegram", chatId: "c" })
    const [batch] = await q.markDone("a", "telegram", "c")
    expect(batch.queuedAt).toBe(1_000)
    expect(batch.timestamp).toBeGreaterThan(5_000)
  })
})

describe("registry flush of a queued channel message", () => {
  let dir: string
  const prevCwd = process.cwd()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-stale-note-"))
    process.chdir(dir)
    hang.on = true
  })
  afterEach(() => {
    hang.on = false
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  const config = () => daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })

  const ctx = { channel: "telegram", chatId: "chat-1", sender: "Sam" }
  const pendingOf = (r: AgentRegistry) => (r as any).messageQueue.queues.get("ops:telegram:chat-1").pending

  /** Start a hanging turn on chat-1; resolves with its id and run. */
  async function busy(r: AgentRegistry) {
    let onStart!: (id: string) => void
    const started = new Promise<string>((res) => { onStart = res })
    const run = r.execute({ message: "first", agentId: "ops", context: ctx, onStart })
    return { id: await started, run }
  }

  /** The message of the turn the flush started (the planner hangs it). */
  async function flushedMessage(r: AgentRegistry, first: { id: string; run: Promise<unknown> }): Promise<string> {
    r.cancelRunningTask(first.id, "done")
    await first.run
    const state = (r as any).agents.get("ops")
    for (let i = 0; i < 100 && state.runningTasks.length === 0; i++) await new Promise((res) => setTimeout(res, 20))
    return state.runningTasks[0].message
  }

  async function flushOne(ageMs: number): Promise<string> {
    const r = new AgentRegistry(config(), () => {})
    const first = await busy(r)
    const queued = await r.execute({ message: "look at the PR head", agentId: "ops", context: ctx })
    expect(isQueued(queued.error)).toBe(true)
    // Age the queued message as if it had waited behind a long turn.
    pendingOf(r)[0].timestamp = Date.now() - ageMs
    return flushedMessage(r, first)
  }

  it("announces a queued message on the event bus, with who sent it (request status, #383)", async () => {
    const seen: any[] = []
    const listen = (p: any) => { seen.push(p) }
    getEventBus().on("task:queued", listen)
    const r = new AgentRegistry(config(), () => {})
    await busy(r)
    const queued = await r.execute({ message: "second", agentId: "ops", context: { ...ctx, senderId: "77" } })
    getEventBus().off("task:queued", listen)
    expect(isQueued(queued.error)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ agentId: "ops", channel: "telegram", chatId: "chat-1", humanRoot: true, sender: { name: "Sam", id: "77" } })
  })

  it("prepends the note when the message waited past the threshold", async () => {
    const message = await flushOne(10 * 60_000)
    const [firstLine, ...rest] = message.split("\n")
    expect(firstLine).toMatch(/^\[queued at \d\d:\d\d UTC, running at \d\d:\d\d UTC — /)
    expect(rest.join("\n")).toBe("look at the PR head")
  })

  it("leaves a short wait untouched", async () => {
    expect(await flushOne(2_000)).toBe("look at the PR head")
  })

  it("a flushed message that queues again keeps its clean text and first queue time: one note", async () => {
    const r = new AgentRegistry(config(), () => {})
    const first = await busy(r)
    const firstQueued = Date.now() - 20 * 60_000
    // What the flush dispatches, meeting a chat that is busy again.
    const again = await r.execute({ message: "look at the PR head", agentId: "ops", context: ctx, queuedAt: firstQueued })
    expect(isQueued(again.error)).toBe(true)
    expect(pendingOf(r)[0]).toMatchObject({ text: "look at the PR head", queuedAt: firstQueued })

    const message = await flushedMessage(r, first)
    expect(message.match(/\[queued at /g)).toHaveLength(1)
    expect(message).toContain(`queued at ${new Date(firstQueued).toISOString().slice(11, 16)} UTC`)
    expect(message.endsWith("\nlook at the PR head")).toBe(true)
  })
})
