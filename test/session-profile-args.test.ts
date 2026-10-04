import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ClaudeProcessFactory } from "../src/agents/claude-process-factory"
import {
  ProcessRegistry,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type SpawnOptions,
  type TurnInput,
  type TurnEvent,
} from "../src/agents/process-registry"
import { resetProcessRegistryForTesting, setProcessRegistry } from "../src/agents/process-registry-instance"
import { executeTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

// The lean profile's claude flags (#615) ride AgentTask.claudeArgs. They
// must reach both ways a claude-code agent is started: the persistent
// process (SpawnOptions.extraArgs) and the spawn-per-task command line.

const LEAN = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "project,local"]

class RecordingHandle implements ProcessHandle {
  constructor(public readonly key: ProcessKey, public readonly opts: SpawnOptions) {}
  state() { return "idle" as const }
  snapshot() {
    return { key: this.key, pid: 0, claudeSessionId: null, state: "idle" as const, spawnedAt: 0, lastTurnAt: 0, turnCount: 0, lastInputTokens: 0, pendingTaskId: null, claudeMdHash: null }
  }
  async *runTurn(_input: TurnInput): AsyncIterable<TurnEvent> {
    yield { type: "result", raw: { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } } }
  }
  async kill(): Promise<void> { /* nothing to stop */ }
}

class RecordingFactory implements ProcessFactory {
  spawned: RecordingHandle[] = []
  spawn(key: ProcessKey, opts: SpawnOptions): ProcessHandle {
    const h = new RecordingHandle(key, opts)
    this.spawned.push(h)
    return h
  }
}

const agent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  name: "coder", workspace: mkdtempSync(join(tmpdir(), "lean-args-")), tier: "claude-code",
  intents: [], maxDelegationDepth: 5, maxConcurrent: 1, maxExecutionMinutes: 20,
  permissionMode: "bypassPermissions", persistentProcess: true, toolUseRequired: [], ...overrides,
} as unknown as AgentDef)

beforeEach(() => resetProcessRegistryForTesting())
afterEach(() => resetProcessRegistryForTesting())

describe("lean claude flags on the persistent process", () => {
  it("hands AgentTask.claudeArgs to the spawn as extraArgs", async () => {
    const factory = new RecordingFactory()
    setProcessRegistry(new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 }))
    await executeTask(agent(), {
      agentId: "coder", message: "label event", taskId: "01T1", claudeArgs: LEAN,
      context: { channel: "github", chatId: "acme/widgets:issue:1" },
    } as any, {})
    expect(factory.spawned).toHaveLength(1)
    expect(factory.spawned[0].opts.extraArgs).toEqual(LEAN)
  })

  it("spawns without them when the task carries none (full profile)", async () => {
    const factory = new RecordingFactory()
    setProcessRegistry(new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 }))
    await executeTask(agent(), {
      agentId: "coder", message: "hi", taskId: "01T2", context: { channel: "telegram", chatId: "100" },
    } as any, {})
    expect(factory.spawned[0].opts.extraArgs).toBeUndefined()
  })
})

describe("lean claude flags on the command line", () => {
  // A `claude` stand-in that records its argv and answers one turn in
  // the stream-json shape the factory expects.
  const standIn = (dump: string) => `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)))
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const q = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    out({ type: "system", subtype: "init" })
    out({ type: "user", uuid: q.uuid, isReplay: true, message: q.message })
    out({ type: "result", result: "ok" })
  }
})
`

  it("appear on the persistent process after the model and before the factory's own extras", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lean-claude-"))
    const binary = join(dir, "claude"), dump = join(dir, "argv.json")
    writeFileSync(binary, standIn(dump))
    chmodSync(binary, 0o755)
    const handle = new ClaudeProcessFactory({ binary, extraArgs: ["--verbose-extra"] }).spawn(
      { agentId: "coder", channel: "github", chatId: "c" },
      { agentId: "coder", channel: "github", chatId: "c", workspace: dir, model: "m", extraArgs: LEAN },
    )
    try {
      for await (const _ of handle.runTurn({ message: "hi", taskId: "t", deadlineMs: 5_000 })) { /* one turn */ }
      const argv: string[] = JSON.parse(readFileSync(dump, "utf8"))
      expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "m"])
      const i = argv.indexOf("--strict-mcp-config")
      expect(argv.slice(i, i + LEAN.length)).toEqual(LEAN)
      expect(argv.indexOf("--verbose-extra")).toBeGreaterThan(i)
    } finally {
      await handle.kill("test-end")
    }
  })

  it("appear on a spawn-per-task run as well", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lean-claude-"))
    const binary = join(dir, "bin", "claude"), dump = join(dir, "argv.json")
    // A directory for PATH, so `claude` resolves to the stand-in.
    mkdirSync(join(dir, "bin"))
    writeFileSync(binary, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({ type: "result", result: "ok", session_id: "s1", num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
`)
    chmodSync(binary, 0o755)
    const prevPath = process.env.PATH
    process.env.PATH = `${join(dir, "bin")}:${prevPath}`
    try {
      const res = await executeTask(agent({ persistentProcess: false, workspace: dir }), {
        agentId: "coder", message: "label event", taskId: "01T3", claudeArgs: LEAN,
        context: { channel: "github", chatId: "acme/widgets:issue:1" },
      } as any)
      expect(res.error).toBeUndefined()
      const argv: string[] = JSON.parse(readFileSync(dump, "utf8"))
      const i = argv.indexOf("--strict-mcp-config")
      expect(i).toBeGreaterThan(0)
      expect(argv.slice(i, i + LEAN.length)).toEqual(LEAN)
    } finally {
      process.env.PATH = prevPath
    }
  })
})
