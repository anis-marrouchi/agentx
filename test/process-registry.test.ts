import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  ProcessRegistry,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type ProcessSnapshot,
  type ProcessState,
  type SpawnOptions,
  type TurnEvent,
  type TurnInput,
  processKeyToString,
} from "../src/agents/process-registry"

// --- Fake handle / factory: in-memory only, no subprocess ---

interface FakeOptions {
  spawnDelayMs?: number
  killDelayMs?: number
}

class FakeHandle implements ProcessHandle {
  private _state: ProcessState = "warm-cold"
  private _snap: ProcessSnapshot
  private _killResolved = false
  killReasons: string[] = []
  constructor(
    public readonly key: ProcessKey,
    public readonly opts: SpawnOptions,
    private readonly fakeOpts: FakeOptions = {},
    initialHash: string | null = null,
  ) {
    this._snap = {
      key,
      pid: Math.floor(Math.random() * 100000),
      claudeSessionId: null,
      state: "warm-cold",
      spawnedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: 0,
      lastInputTokens: 0,
      pendingTaskId: null,
      claudeMdHash: initialHash,
    }
  }

  state(): ProcessState {
    return this._state
  }

  snapshot(): ProcessSnapshot {
    return { ...this._snap, state: this._state }
  }

  /** Synchronous test helper to drive lifecycle transitions. */
  setIdle(at: number = Date.now()): void {
    this._state = "idle"
    this._snap = { ...this._snap, lastTurnAt: at, state: "idle" }
  }

  setWarmHot(at: number = Date.now()): void {
    this._state = "warm-hot"
    this._snap = { ...this._snap, lastTurnAt: at, state: "warm-hot", turnCount: this._snap.turnCount + 1 }
  }

  async *runTurn(input: TurnInput): AsyncIterable<TurnEvent> {
    this._snap = { ...this._snap, pendingTaskId: input.taskId }
    yield { type: "system", raw: { type: "system", subtype: "init", session_id: "fake-sid" } }
    yield { type: "assistant", raw: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } }
    yield { type: "result", raw: { type: "result", subtype: "success", duration_ms: 100 } }
    this._snap = { ...this._snap, pendingTaskId: null, turnCount: this._snap.turnCount + 1, lastTurnAt: Date.now() }
    this._state = "idle"
  }

  async kill(reason: string): Promise<void> {
    this.killReasons.push(reason)
    if (this.fakeOpts.killDelayMs) {
      await new Promise((r) => setTimeout(r, this.fakeOpts.killDelayMs))
    }
    this._state = "dead"
    this._snap = { ...this._snap, state: "dead", deadReason: reason }
    this._killResolved = true
  }

  killResolved(): boolean {
    return this._killResolved
  }
}

class FakeFactory implements ProcessFactory {
  spawned: FakeHandle[] = []
  /** Optional hash to record on every spawn — drift tests set this. */
  initialHash: string | null = null
  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    const h = new FakeHandle(key, opts, {}, this.initialHash)
    this.spawned.push(h)
    return h
  }
}

const KEY = (agentId: string, chat: string = "c1"): ProcessKey => ({
  agentId,
  channel: "telegram",
  chatId: chat,
})

const OPTS = (agentId: string): SpawnOptions => ({
  agentId,
  channel: "telegram",
  chatId: "c1",
  workspace: "/tmp/x",
})

describe("processKeyToString", () => {
  it("flattens to agentId:channel:chatId", () => {
    expect(processKeyToString({ agentId: "atlas", channel: "telegram", chatId: "c1" }))
      .toBe("atlas:telegram:c1")
  })
  it("preserves colons in chatId", () => {
    expect(processKeyToString({ agentId: "a", channel: "gitlab", chatId: "proj:issue:7" }))
      .toBe("a:gitlab:proj:issue:7")
  })
})

describe("ProcessRegistry — acquire / get-or-spawn", () => {
  let factory: FakeFactory
  let reg: ProcessRegistry
  beforeEach(() => {
    factory = new FakeFactory()
    reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
  })

  it("spawns a new handle on first acquire", () => {
    const h = reg.acquire(KEY("a"), OPTS("a"))
    expect(factory.spawned).toHaveLength(1)
    expect(h.key.agentId).toBe("a")
  })

  it("reuses the same handle on second acquire of the same key", () => {
    const a = reg.acquire(KEY("a"), OPTS("a"))
    const b = reg.acquire(KEY("a"), OPTS("a"))
    expect(a).toBe(b)
    expect(factory.spawned).toHaveLength(1)
  })

  it("spawns a separate handle for a different chat on the same agent", () => {
    reg.acquire(KEY("a", "chatA"), OPTS("a"))
    reg.acquire(KEY("a", "chatB"), OPTS("a"))
    expect(factory.spawned).toHaveLength(2)
  })

  it("respawns when the existing handle is dead", async () => {
    const a = reg.acquire(KEY("a"), OPTS("a"))
    await a.kill("test")
    const b = reg.acquire(KEY("a"), OPTS("a"))
    expect(b).not.toBe(a)
    expect(factory.spawned).toHaveLength(2)
  })
})

describe("ProcessRegistry — caps and eviction", () => {
  it("evicts the oldest idle handle when at the global cap", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, maxProcessesGlobal: 2, sweepIntervalMs: 1_000_000 })
    const a = reg.acquire(KEY("a", "c1"), OPTS("a")) as FakeHandle
    const b = reg.acquire(KEY("b", "c1"), OPTS("b")) as FakeHandle
    a.setIdle(Date.now() - 10_000) // older
    b.setIdle(Date.now() - 1_000)  // newer

    // At cap (2/2). Acquiring a third must evict 'a' (oldest idle).
    reg.acquire(KEY("c", "c1"), OPTS("c"))
    // a is now removed from the registry and got a kill.
    expect(reg.list().map((s) => s.key.agentId).sort()).toEqual(["b", "c"])
    expect(a.killReasons.some((r) => r.includes("evicted"))).toBe(true)
  })

  it("evicts the oldest idle handle within an agent at per-agent cap", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, maxProcessesPerAgent: 2, sweepIntervalMs: 1_000_000 })
    const a1 = reg.acquire(KEY("agent-a", "c1"), OPTS("agent-a")) as FakeHandle
    const a2 = reg.acquire(KEY("agent-a", "c2"), OPTS("agent-a")) as FakeHandle
    a1.setIdle(Date.now() - 10_000)
    a2.setIdle(Date.now() - 1_000)
    // A third chat for agent-a should evict a1, not a different agent.
    reg.acquire(KEY("agent-b", "c1"), OPTS("agent-b")) // unrelated agent
    reg.acquire(KEY("agent-a", "c3"), OPTS("agent-a"))
    const ids = reg.list().map((s) => `${s.key.agentId}:${s.key.chatId}`).sort()
    expect(ids).toEqual(["agent-a:c2", "agent-a:c3", "agent-b:c1"])
  })

  it("throws when at cap and no idle handle is evictable", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, maxProcessesGlobal: 1, sweepIntervalMs: 1_000_000 })
    reg.acquire(KEY("a", "c1"), OPTS("a")) // warm-cold, NOT idle
    expect(() => reg.acquire(KEY("b", "c1"), OPTS("b"))).toThrow(/global cap/)
  })
})

describe("ProcessRegistry — list / kill / release", () => {
  it("list returns one snapshot per live handle", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    reg.acquire(KEY("a"), OPTS("a"))
    reg.acquire(KEY("b"), OPTS("b"))
    expect(reg.list()).toHaveLength(2)
  })

  it("kill removes from registry and signals the handle", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    await reg.kill(KEY("a"), "operator-test")
    expect(reg.list()).toHaveLength(0)
    expect(h.killReasons).toContain("operator-test")
    expect(h.killResolved()).toBe(true)
  })

  it("release without kill removes from registry but leaves handle alive", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    reg.release(KEY("a"))
    expect(reg.list()).toHaveLength(0)
    expect(h.state()).not.toBe("dead")
  })

  it("release with kill removes from registry and kills", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    reg.release(KEY("a"), { kill: true, reason: "test-release" })
    expect(reg.list()).toHaveLength(0)
    expect(h.killReasons).toContain("test-release")
  })
})

describe("ProcessRegistry — idle/stale sweep", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("kills idle handles past idleTimeoutMs", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000,
      staleTimeoutMs: 60_000,
      sweepIntervalMs: 100,
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle(Date.now() - 2_000) // 2s idle, past 1s threshold
    vi.advanceTimersByTime(150)
    // Kill is async — wait microtasks
    await Promise.resolve()
    expect(h.killReasons.some((r) => r.startsWith("idle"))).toBe(true)
    expect(reg.list()).toHaveLength(0)
  })

  it("kills stale handles past staleTimeoutMs even if rescheduled", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 100_000,
      staleTimeoutMs: 1_000,
      sweepIntervalMs: 100,
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle(Date.now() - 2_000) // past stale, within idle
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(h.killReasons.some((r) => r.startsWith("stale"))).toBe(true)
  })

  it("does not kill handles that are warm-hot or warm-cold", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 100,
      staleTimeoutMs: 100,
      sweepIntervalMs: 50,
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    // Stay warm-cold; sweeper should leave it alone even after timeouts.
    vi.advanceTimersByTime(500)
    await Promise.resolve()
    expect(h.killReasons).toHaveLength(0)
    expect(reg.list()).toHaveLength(1)
  })

  it("reaps dead handles on sweep", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 100 })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    await h.kill("crash") // outside the registry's knowledge
    expect(reg.list()).toHaveLength(1) // still listed
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(reg.list()).toHaveLength(0) // reaped
  })
})

describe("ProcessRegistry — CLAUDE.md drift sweep", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("kills idle handles when the workspace hash changes", async () => {
    const factory = new FakeFactory()
    factory.initialHash = "abc123"
    let liveHash = "abc123"
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000_000,
      staleTimeoutMs: 1_000_000,
      sweepIntervalMs: 100,
      currentWorkspaceHash: () => liveHash,
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle()
    // First sweep: no drift, hash matches.
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(reg.list()).toHaveLength(1)
    expect(h.killReasons).toHaveLength(0)
    // Operator edits CLAUDE.md → hash changes.
    liveHash = "def456"
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(reg.list()).toHaveLength(0)
    expect(h.killReasons.some((r) => r.startsWith("claude-md drifted"))).toBe(true)
  })

  it("does NOT kill warm-hot or warm-cold handles even when hash drifts (mid-turn safety)", async () => {
    const factory = new FakeFactory()
    factory.initialHash = "abc"
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000_000,
      staleTimeoutMs: 1_000_000,
      sweepIntervalMs: 100,
      currentWorkspaceHash: () => "different",
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    // warm-cold (default). Hash differs but we should NOT kill mid-turn.
    vi.advanceTimersByTime(500)
    await Promise.resolve()
    expect(h.killReasons).toHaveLength(0)
    expect(reg.list()).toHaveLength(1)

    // Now go warm-hot. Still not killed.
    h.setWarmHot()
    vi.advanceTimersByTime(500)
    await Promise.resolve()
    expect(h.killReasons).toHaveLength(0)

    // Transition to idle → next sweep kills.
    h.setIdle()
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(h.killReasons.some((r) => r.startsWith("claude-md drifted"))).toBe(true)
  })

  it("treats unmarked → marked as drift (and vice versa)", async () => {
    const factory = new FakeFactory()
    factory.initialHash = null
    let liveHash: string | null = null
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000_000,
      staleTimeoutMs: 1_000_000,
      sweepIntervalMs: 100,
      currentWorkspaceHash: () => liveHash,
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle()
    // null === null, no drift.
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(h.killReasons).toHaveLength(0)
    // user-edited file converted to managed (or first managed gen ran)
    liveHash = "newhash"
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    expect(h.killReasons.some((r) => r.includes("unmarked → newhash"))).toBe(true)
  })

  it("hash-read failures don't crash the sweeper", async () => {
    const factory = new FakeFactory()
    factory.initialHash = "abc"
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000_000,
      staleTimeoutMs: 1_000_000,
      sweepIntervalMs: 100,
      currentWorkspaceHash: () => { throw new Error("EACCES: permission denied") },
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle()
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    // Survived the throw — handle still alive, sweeper still running.
    expect(reg.list()).toHaveLength(1)
    expect(h.killReasons).toHaveLength(0)
  })

  it("does nothing when no currentWorkspaceHash hook is configured", async () => {
    const factory = new FakeFactory()
    factory.initialHash = "abc"
    const reg = new ProcessRegistry({
      factory,
      idleTimeoutMs: 1_000_000,
      staleTimeoutMs: 1_000_000,
      sweepIntervalMs: 100,
      // currentWorkspaceHash intentionally omitted
    })
    reg.start()
    const h = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    h.setIdle()
    vi.advanceTimersByTime(500)
    await Promise.resolve()
    expect(reg.list()).toHaveLength(1)
    expect(h.killReasons).toHaveLength(0)
  })
})

describe("ProcessRegistry — start / stop", () => {
  it("stop kills every live handle", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    const a = reg.acquire(KEY("a"), OPTS("a")) as FakeHandle
    const b = reg.acquire(KEY("b"), OPTS("b")) as FakeHandle
    await reg.stop()
    expect(reg.list()).toHaveLength(0)
    expect(a.killResolved()).toBe(true)
    expect(b.killResolved()).toBe(true)
    expect(a.killReasons).toContain("registry-stop")
    expect(b.killReasons).toContain("registry-stop")
  })
})

describe("ProcessHandle — runTurn (fake) yields the expected event sequence", () => {
  it("emits system → assistant → result", async () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    const h = reg.acquire(KEY("a"), OPTS("a"))
    const events: TurnEvent[] = []
    for await (const e of h.runTurn({ message: "hi", taskId: "01TASK" })) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"])
  })
})
