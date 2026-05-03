import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  ProcessRegistry,
  RegistryCapExceeded,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type ProcessSnapshot,
  type ProcessState,
  type SpawnOptions,
  type TurnEvent,
  type TurnInput,
} from "../src/agents/process-registry"
import {
  setProcessRegistry,
  resetProcessRegistryForTesting,
} from "../src/agents/process-registry-instance"
import { executeTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

// --- Fake handle that yields scripted events for one turn ---
class ScriptedHandle implements ProcessHandle {
  private _state: ProcessState = "warm-cold"
  public turnsRun: TurnInput[] = []
  constructor(
    public readonly key: ProcessKey,
    private events: Array<TurnEvent>,
  ) {}
  state(): ProcessState { return this._state }
  snapshot(): ProcessSnapshot {
    return {
      key: this.key,
      pid: 0,
      claudeSessionId: null,
      state: this._state,
      spawnedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: 0,
      lastInputTokens: 0,
      pendingTaskId: null,
    }
  }
  async *runTurn(input: TurnInput): AsyncIterable<TurnEvent> {
    this.turnsRun.push(input)
    for (const e of this.events) yield e
    this._state = "idle"
  }
  async kill(): Promise<void> { this._state = "dead" }
}

class ScriptedFactory implements ProcessFactory {
  constructor(private events: Array<TurnEvent>) {}
  spawn(key: ProcessKey, _opts: SpawnOptions): ProcessHandle {
    return new ScriptedHandle(key, this.events)
  }
}

class CapExceededFactory implements ProcessFactory {
  spawn(): ProcessHandle {
    throw new Error("CapExceededFactory: spawn shouldn't be called when registry is at cap")
  }
}

const baseAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  name: "test",
  workspace: "/tmp/agentx-test",
  tier: "claude-code",
  intents: [],
  maxDelegationDepth: 5,
  maxConcurrent: 1,
  maxExecutionMinutes: 20,
  permissionMode: "default",
  persistentProcess: false,
  ...overrides,
} as unknown as AgentDef)

const baseTask = (msg: string) => ({
  agentId: "test",
  message: msg,
  taskId: "01TASKID",
  context: { channel: "api" as const, chatId: "c1" },
})

const successResultEvents: TurnEvent[] = [
  {
    type: "system",
    raw: { type: "system", subtype: "init", session_id: "sess-fake" } as Record<string, unknown>,
  },
  {
    type: "assistant",
    raw: {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }], model: "claude-sonnet-4-6" },
    } as Record<string, unknown>,
  },
  {
    type: "result",
    raw: {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello world",
      session_id: "sess-fake",
      duration_ms: 100,
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      message: { model: "claude-sonnet-4-6" },
    } as Record<string, unknown>,
  },
]

beforeEach(() => {
  resetProcessRegistryForTesting()
})

afterEach(() => {
  resetProcessRegistryForTesting()
})

describe("executeTask routing — persistent flag", () => {
  it("uses the persistent path when agent.persistentProcess is true and registry is set", async () => {
    const factory = new ScriptedFactory(successResultEvents)
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)

    const agent = baseAgent({ persistentProcess: true })
    const task = baseTask("hi")

    const events: any[] = []
    const r = await executeTask(agent, task as any, {}, undefined, undefined, undefined, (e) => events.push(e))

    expect(r.error).toBeUndefined()
    expect(r.content).toBe("hello world")
    expect(r.usage?.inputTokens).toBe(5)
    expect(r.claudeSessionId).toBe("sess-fake")
    expect(r.billedModel).toBe("claude-sonnet-4-6")
    // Forwarded events to onEvent so the trace step capture would fire.
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"])
  })

  it("does NOT call the persistent path when agent.persistentProcess is false", async () => {
    // No registry set. If runtime mistakenly tried to use it, executeClaudeCode
    // would fire and shell out to a missing or unintended `claude` binary.
    // Instead we expect the legacy spawn-per-task path. We don't actually run
    // it here (would spawn claude); we just verify the early return doesn't
    // happen by setting a registry that would explode if used.
    setProcessRegistry({ acquire() { throw new Error("must not be called") } } as any)

    const agent = baseAgent({ persistentProcess: false })
    const task = baseTask("hi")
    // The legacy path would spawn `claude`. To avoid that in unit tests we
    // can short-circuit by checking that executeTask did NOT throw the
    // "must not be called" sentinel. We accept that the actual subprocess
    // attempt may produce an error response — that's not what we're
    // asserting.
    let threwSentinel = false
    try {
      await executeTask(agent, task as any, {}, undefined)
    } catch (e: any) {
      if (e?.message === "must not be called") threwSentinel = true
    }
    expect(threwSentinel).toBe(false)
  })

  it("falls back to legacy path when registry throws RegistryCapExceeded", async () => {
    const factory = new CapExceededFactory()
    const reg = new ProcessRegistry({
      factory,
      maxProcessesGlobal: 0, // cap = 0 → first acquire always throws
      sweepIntervalMs: 1_000_000,
    })
    setProcessRegistry(reg)

    const agent = baseAgent({ persistentProcess: true })
    // Sanity: the registry would throw RegistryCapExceeded on acquire.
    expect(() => reg.acquire(
      { agentId: "test", channel: "api", chatId: "c1" },
      { agentId: "test", channel: "api", chatId: "c1", workspace: "/tmp" },
    )).toThrow(RegistryCapExceeded)

    // The persistent path returns null on cap; executeTask falls through
    // to the legacy path. We don't run real claude here — just verify
    // the persistent path's early return doesn't raise.
    let raised = false
    try {
      await executeTask(agent, baseTask("hi") as any, {}, undefined)
    } catch {
      raised = true
    }
    // The legacy path may fail on missing binary in some test envs, but
    // executeTask itself must not propagate the cap-exceeded error.
    expect(raised).toBe(false)
  })

  it("returns null from the persistent path when registry is unset", async () => {
    // Internally, executeClaudeCodePersistent returns null which makes
    // executeTask fall through. Same property as the cap-exceeded case.
    resetProcessRegistryForTesting()
    const agent = baseAgent({ persistentProcess: true })
    let raised = false
    try {
      await executeTask(agent, baseTask("hi") as any, {}, undefined)
    } catch { raised = true }
    expect(raised).toBe(false)
  })

  it("propagates is_error from the result event as a friendly error", async () => {
    const errorEvents: TurnEvent[] = [
      { type: "system", raw: { type: "system", subtype: "init" } },
      {
        type: "result",
        raw: {
          type: "result",
          is_error: true,
          result: "rate_limit_error: too many requests",
          session_id: "sess-x",
        } as Record<string, unknown>,
      },
    ]
    const factory = new ScriptedFactory(errorEvents)
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)

    const r = await executeTask(baseAgent({ persistentProcess: true }), baseTask("x") as any, {})
    expect(r.error).toBeTruthy()
    expect(r.content).toBe("")
  })
})
