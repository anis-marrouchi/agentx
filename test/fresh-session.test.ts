import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
} from "../src/agents/process-registry"
import {
  setProcessRegistry,
  resetProcessRegistryForTesting,
} from "../src/agents/process-registry-instance"
import { executeTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

// --- Scripted handle for freshSession integration ---

class ScriptedHandle implements ProcessHandle {
  private _state: ProcessState = "warm-cold"
  public readonly id: string
  public turnsRun: TurnInput[] = []
  public killReasons: string[] = []
  constructor(public readonly key: ProcessKey, public readonly opts: SpawnOptions) {
    this.id = `handle-${Math.random().toString(36).slice(2, 8)}`
  }
  state(): ProcessState { return this._state }
  snapshot(): ProcessSnapshot {
    return {
      key: this.key,
      pid: 0,
      claudeSessionId: null,
      state: this._state,
      spawnedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: this.turnsRun.length,
      lastInputTokens: 0,
      pendingTaskId: null,
      claudeMdHash: null,
    }
  }
  async *runTurn(input: TurnInput): AsyncIterable<TurnEvent> {
    this.turnsRun.push(input)
    // First turn output identifies the handle so tests can confirm a
    // BRAND-NEW handle (different id) handled the turn.
    yield { type: "system", raw: { type: "system", subtype: "init" } }
    yield {
      type: "assistant",
      raw: { type: "assistant", message: { content: [{ type: "text", text: `from ${this.id}` }] } },
    }
    yield {
      type: "result",
      raw: {
        type: "result", subtype: "success", is_error: false,
        result: `from ${this.id}`,
        session_id: this.id,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
    this._state = "idle"
  }
  async kill(reason: string): Promise<void> {
    this.killReasons.push(reason)
    this._state = "dead"
  }
}

class ScriptedFactory implements ProcessFactory {
  spawned: ScriptedHandle[] = []
  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    const h = new ScriptedHandle(key, opts)
    this.spawned.push(h)
    return h
  }
}

const baseAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  name: "lead",
  workspace: "/tmp/agentx-test",
  tier: "claude-code",
  intents: [],
  maxDelegationDepth: 5,
  maxConcurrent: 1,
  maxExecutionMinutes: 20,
  permissionMode: "default",
  persistentProcess: true,
  toolUseRequired: [],
  ...overrides,
} as unknown as AgentDef)

beforeEach(() => {
  resetProcessRegistryForTesting()
})

afterEach(() => {
  resetProcessRegistryForTesting()
})

describe("freshSession (improvement plan #8 — Run-3 finding)", () => {
  it("WITHOUT freshSession: second call reuses the same handle (the stickiness bug)", async () => {
    const factory = new ScriptedFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)
    const agent = baseAgent()

    const r1 = await executeTask(agent, {
      agentId: "lead",
      message: "first turn",
      taskId: "01T1",
      context: { channel: "api", chatId: "default" },
    } as any, {})
    const r2 = await executeTask(agent, {
      agentId: "lead",
      message: "second turn (different visitor — but same chatId)",
      taskId: "01T2",
      context: { channel: "api", chatId: "default" },
    } as any, {})

    // Same handle id in BOTH responses → stickiness reproduced.
    expect(r1.content).toBe(r2.content)
    expect(factory.spawned).toHaveLength(1)
  })

  it("WITH freshSession=true on the second call: registry kills the warm handle, new spawn handles it", async () => {
    const factory = new ScriptedFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)
    const agent = baseAgent()

    const r1 = await executeTask(agent, {
      agentId: "lead",
      message: "S2 final turn",
      taskId: "01T1",
      context: { channel: "api", chatId: "default" },
    } as any, {})
    const r2 = await executeTask(agent, {
      agentId: "lead",
      message: "brand new visitor — triage delegated to lead",
      taskId: "01T2",
      context: { channel: "api", chatId: "default" },
      freshSession: true,
    } as any, {})

    // Different handle ids → fresh spawn ran turn 2.
    expect(r1.content).not.toBe(r2.content)
    expect(factory.spawned).toHaveLength(2)
    // The first handle was killed with the freshSession reason.
    expect(factory.spawned[0].killReasons.some((r) => r.includes("freshSession"))).toBe(true)
  })

  it("freshSession on the FIRST call (no prior handle) is a no-op kill — still spawns once", async () => {
    const factory = new ScriptedFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)
    const agent = baseAgent()

    const r1 = await executeTask(agent, {
      agentId: "lead",
      message: "fresh visitor",
      taskId: "01T1",
      context: { channel: "api", chatId: "default" },
      freshSession: true,
    } as any, {})

    expect(r1.error).toBeUndefined()
    expect(factory.spawned).toHaveLength(1)
    expect(factory.spawned[0].killReasons).toHaveLength(0)
  })

  it("freshSession only kills the targeted (agent, channel, chatId) — unrelated handles untouched", async () => {
    const factory = new ScriptedFactory()
    const reg = new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 })
    setProcessRegistry(reg)
    const agent = baseAgent()

    // Warm up two distinct chats.
    await executeTask(agent, {
      agentId: "lead", message: "a",
      taskId: "01TA", context: { channel: "api", chatId: "chatA" },
    } as any, {})
    await executeTask(agent, {
      agentId: "lead", message: "b",
      taskId: "01TB", context: { channel: "api", chatId: "chatB" },
    } as any, {})

    expect(factory.spawned).toHaveLength(2)
    const handleA = factory.spawned[0]
    const handleB = factory.spawned[1]

    // freshSession on chatA only — chatB's handle stays alive.
    await executeTask(agent, {
      agentId: "lead", message: "fresh A",
      taskId: "01TC", context: { channel: "api", chatId: "chatA" },
      freshSession: true,
    } as any, {})

    expect(handleA.killReasons.some((r) => r.includes("freshSession"))).toBe(true)
    expect(handleB.killReasons).toHaveLength(0)
    expect(factory.spawned).toHaveLength(3) // chatA respawned
  })
})
