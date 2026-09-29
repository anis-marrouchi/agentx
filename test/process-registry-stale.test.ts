import { describe, it, expect } from "vitest"
import {
  ProcessRegistry,
  staleHandleReason,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type ProcessSnapshot,
  type ProcessState,
  type SpawnOptions,
  type TurnEvent,
  type TurnInput,
} from "../src/agents/process-registry"

// A warm process used to be reused whatever the next turn asked for: a
// rotation cleared the stored session id, routing picked another model,
// and the registry handed back the same subprocess anyway. The fresh-session
// context then landed on top of the old conversation and the model change
// was silently dropped. These tests pin the respawn rule.

class FakeHandle implements ProcessHandle {
  private _state: ProcessState = "warm-cold"
  private _snap: ProcessSnapshot
  killReasons: string[] = []
  constructor(public readonly key: ProcessKey, public readonly opts: SpawnOptions) {
    this._snap = {
      key, pid: 1, claudeSessionId: opts.resumeSessionId ?? null, state: "warm-cold",
      spawnedAt: Date.now(), lastTurnAt: Date.now(), turnCount: 0, lastInputTokens: 0,
      pendingTaskId: null, claudeMdHash: null,
    }
  }
  state(): ProcessState { return this._state }
  snapshot(): ProcessSnapshot { return { ...this._snap, state: this._state } }
  /** One turn completed; Claude reported `sessionId` on its result event. */
  finishTurn(sessionId: string): void {
    this._state = "idle"
    this._snap = { ...this._snap, turnCount: this._snap.turnCount + 1, claudeSessionId: sessionId }
  }
  setBusy(): void { this._state = "busy" }
  claim(): void {}
  async *runTurn(_input: TurnInput): AsyncIterable<TurnEvent> { yield { type: "result", raw: { type: "result" } } }
  async kill(reason: string): Promise<void> { this.killReasons.push(reason); this._state = "dead" }
}

class FakeFactory implements ProcessFactory {
  spawned: FakeHandle[] = []
  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    const h = new FakeHandle(key, opts)
    this.spawned.push(h)
    return h
  }
}

const KEY: ProcessKey = { agentId: "a", channel: "telegram", chatId: "c1" }
const opts = (extra: Partial<SpawnOptions> = {}): SpawnOptions => ({
  agentId: "a", channel: "telegram", chatId: "c1", workspace: "/tmp/x", model: "opus", ...extra,
})

describe("staleHandleReason", () => {
  it("keeps a cold process that has not started a conversation", () => {
    const h = new FakeHandle(KEY, opts())
    expect(staleHandleReason(h, opts())).toBeNull()
  })

  it("keeps a warm process when the caller resumes the session it holds", () => {
    const h = new FakeHandle(KEY, opts())
    h.finishTurn("sid-1")
    expect(staleHandleReason(h, opts({ resumeSessionId: "sid-1" }))).toBeNull()
  })

  it("flags a rotation: no --resume while the process holds a conversation", () => {
    const h = new FakeHandle(KEY, opts())
    h.finishTurn("sid-1")
    expect(staleHandleReason(h, opts())).toMatch(/rotated/)
  })

  it("keeps a process that ran turns but never reported a session id", () => {
    const h = new FakeHandle(KEY, opts())
    h.finishTurn("sid-1")
    ;(h as any)._snap = { ...h.snapshot(), claudeSessionId: null }
    expect(staleHandleReason(h, opts())).toBeNull()
  })

  it("flags a different session id", () => {
    const h = new FakeHandle(KEY, opts())
    h.finishTurn("sid-1")
    expect(staleHandleReason(h, opts({ resumeSessionId: "sid-2" }))).toMatch(/session changed/)
  })

  it("flags a model change", () => {
    const h = new FakeHandle(KEY, opts({ model: "opus" }))
    expect(staleHandleReason(h, opts({ model: "haiku" }))).toMatch(/model changed/)
  })

  it("never interrupts a busy process", () => {
    const h = new FakeHandle(KEY, opts({ model: "opus" }))
    h.finishTurn("sid-1")
    h.setBusy()
    expect(staleHandleReason(h, opts({ model: "haiku" }))).toBeNull()
  })
})

describe("ProcessRegistry.acquire respawns a stale handle", () => {
  it("kills the old process and spawns a new one after a rotation", () => {
    const factory = new FakeFactory()
    const reg = new ProcessRegistry({ factory, log: () => {} } as any)
    const first = reg.acquire(KEY, opts()) as FakeHandle
    first.finishTurn("sid-1")
    // Same session: reused.
    expect(reg.acquire(KEY, opts({ resumeSessionId: "sid-1" }))).toBe(first)
    // Rotation: respawned.
    const second = reg.acquire(KEY, opts())
    expect(second).not.toBe(first)
    expect(first.killReasons).toEqual(["session rotated"])
    expect(factory.spawned).toHaveLength(2)
    expect(reg.list()).toHaveLength(1)
  })
})
