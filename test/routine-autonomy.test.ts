import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Routine autonomy levels (#80), end to end at the runtime + scheduler seams:
// the restriction rides on ONE spawn, other chats of the same agent keep
// their warm process and full permissions, tiers that cannot enforce refuse,
// and blocked actions come back on the run result.

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  onSpawn: undefined as undefined | ((args: string[]) => void),
}))

vi.mock("child_process", async (orig) => {
  const real = await orig<typeof import("child_process")>()
  return {
    ...real,
    execFile: (file: string, args: string[], opts: any, cb: any) => {
      mocks.execFile(file, args, opts)
      mocks.onSpawn?.(args)
      setImmediate(() => cb(null, JSON.stringify({ result: "report body", session_id: "sess-1" }), ""))
      return { stdin: { end: () => {} }, kill: () => {}, on: () => {} }
    },
  }
})

import {
  ProcessRegistry,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessKey,
  type SpawnOptions,
  type TurnEvent,
} from "../src/agents/process-registry"
import { setProcessRegistry, resetProcessRegistryForTesting } from "../src/agents/process-registry-instance"
import { executeTask } from "../src/agents/runtime"
import { setAutonomyHookPort, checkAutonomyPayload } from "../src/guard/autonomy-enforce"
import { daemonConfigSchema, type AgentDef } from "../src/daemon/config"
import { CronScheduler } from "../src/crons/scheduler"
import { closeDb } from "../src/storage/sqlite"

class WarmHandle implements ProcessHandle {
  constructor(public readonly key: ProcessKey, public readonly opts: SpawnOptions) {}
  state() { return "idle" as const }
  snapshot() {
    return {
      key: this.key, pid: 0, claudeSessionId: null, state: "idle" as const, spawnedAt: 0, lastTurnAt: 0,
      turnCount: 0, lastInputTokens: 0, pendingTaskId: null, claudeMdHash: null,
    }
  }
  async *runTurn(): AsyncIterable<TurnEvent> {
    yield { type: "result", raw: { type: "result", subtype: "success", is_error: false, result: "warm reply", session_id: "warm" } }
  }
  claim() {}
  async kill() {}
}
class WarmFactory implements ProcessFactory {
  spawned: WarmHandle[] = []
  spawn(key: ProcessKey, opts: SpawnOptions) {
    const h = new WarmHandle(key, opts)
    this.spawned.push(h)
    return h
  }
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "coder", workspace: "/tmp/agentx-autonomy-test", tier: "claude-code", intents: [],
  maxDelegationDepth: 5, maxConcurrent: 1, maxExecutionMinutes: 20,
  permissionMode: "bypassPermissions", persistentProcess: true, toolUseRequired: [],
  ...over,
} as unknown as AgentDef)

const cronTask = (over: Record<string, unknown> = {}) => ({
  agentId: "coder", message: "summarise open MRs", taskId: "01TASKREPORT",
  context: { channel: "cron", chatId: "cron:daily-brief" }, ...over,
}) as any

let root: string
const prevKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  closeDb()
  root = mkdtempSync(join(tmpdir(), "agentx-autonomy-"))
  mocks.execFile.mockReset()
  mocks.onSpawn = undefined
  resetProcessRegistryForTesting()
  setAutonomyHookPort("19900")
  process.env.ANTHROPIC_API_KEY = "sk-test-should-be-stripped"
})
afterEach(() => {
  closeDb()
  resetProcessRegistryForTesting()
  setAutonomyHookPort(null)
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = prevKey
  rmSync(root, { recursive: true, force: true })
})

describe("runtime: enforcement per task, not per agent", () => {
  it("a report task spawns its own claude process with the autonomy hook; the warm process is not used", async () => {
    const factory = new WarmFactory()
    setProcessRegistry(new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 }))

    const r = await executeTask(agent(), cronTask({ autonomy: "report" }), {})

    expect(factory.spawned).toHaveLength(0)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = mocks.execFile.mock.calls[0]
    expect(bin).toBe("claude")
    expect(args).toContain("--dangerously-skip-permissions") // the agent's mode is unchanged…
    expect(args).toContain("--disallowedTools")              // …but this task is fenced
    const settings = JSON.parse(args[args.indexOf("--settings") + 1])
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("autonomy=report&task=01TASKREPORT")
    expect(args[1]).toMatch(/^\[Autonomy: report\]/m)
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined()      // billing strip preserved
    expect(r.content).toBe("report body")
    expect(r.autonomy).toBe("report")
  })

  it("an act task on the same agent keeps the warm persistent process and gets no hook", async () => {
    const factory = new WarmFactory()
    setProcessRegistry(new ProcessRegistry({ factory, sweepIntervalMs: 1_000_000 }))

    await executeTask(agent(), cronTask({ autonomy: "report" }), {})
    const r = await executeTask(agent(), cronTask({ taskId: "01TASKACT", context: { channel: "telegram", chatId: "42" } }), {})

    expect(factory.spawned).toHaveLength(1)
    expect(r.content).toBe("warm reply")
    expect(r.autonomy).toBeUndefined()
    expect(mocks.execFile).toHaveBeenCalledTimes(1) // only the report task spawned
  })

  it("propose adds the hook without disallowing file tools", async () => {
    await executeTask(agent({ persistentProcess: false }), cronTask({ autonomy: "propose" }), {})
    const args: string[] = mocks.execFile.mock.calls[0][1]
    expect(args).not.toContain("--disallowedTools")
    expect(args[args.indexOf("--settings") + 1]).toContain("autonomy=propose")
  })

  it("act and unset are byte-for-byte today's spawn", async () => {
    await executeTask(agent({ persistentProcess: false }), cronTask({ autonomy: "act" }), {})
    await executeTask(agent({ persistentProcess: false }), cronTask(), {})
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain("--settings")
      expect(call[1]).not.toContain("--disallowedTools")
    }
    expect(mocks.execFile.mock.calls[0][1]).toEqual(mocks.execFile.mock.calls[1][1])
  })

  it.each(["codex-cli", "opencode", "sdk", "orchestrator"])("refuses a report task on the %s tier instead of running it at full power", async (tier) => {
    const r = await executeTask(agent({ tier } as any), cronTask({ autonomy: "report" }), {})
    expect(r.error).toMatch(/only enforceable on the claude-code tier/)
    expect(r.content).toBe("")
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it("refuses when the hook endpoint is not configured", async () => {
    setAutonomyHookPort(null)
    const r = await executeTask(agent({ persistentProcess: false }), cronTask({ autonomy: "report" }), {})
    expect(r.error).toMatch(/cannot be enforced/)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it("surfaces the actions the hook blocked on the response", async () => {
    // Simulate the spawned claude calling the hook twice during its run.
    mocks.onSpawn = (args) => {
      const hook: string = JSON.parse(args[args.indexOf("--settings") + 1]).hooks.PreToolUse[0].hooks[0].command
      const taskId = /task=([^'&]+)/.exec(hook)![1]
      checkAutonomyPayload({ tool_name: "Bash", tool_input: { command: "git status" } }, { root, level: "report", taskId })
      checkAutonomyPayload({ tool_name: "Bash", tool_input: { command: "gh pr merge 4" } }, { root, level: "report", taskId })
    }
    const r = await executeTask(agent({ persistentProcess: false }), cronTask({ autonomy: "report" }), {})
    expect(r.autonomyBlocks).toHaveLength(1)
    expect(r.autonomyBlocks![0]).toMatchObject({ tool: "Bash", target: "gh pr merge 4", ruleId: "autonomy.report.shell" })
  })
})

describe("cron config + scheduler", () => {
  const parseCrons = (crons: unknown) => daemonConfigSchema.shape.crons.safeParse(crons)

  it("accepts autonomy on agent routines and rejects bad values and command crons", () => {
    const ok = parseCrons({ brief: { schedule: "0 8 * * *", agent: "coder", prompt: "x", autonomy: "report" } })
    expect(ok.success && ok.data.brief.autonomy).toBe("report")
    expect(parseCrons({ brief: { schedule: "0 8 * * *", agent: "coder", prompt: "x", autonomy: "full" } }).success).toBe(false)
    expect(parseCrons({ sweep: { schedule: "0 8 * * *", agent: "coder", command: "echo hi", autonomy: "propose" } }).success).toBe(false)
    const dflt = parseCrons({ brief: { schedule: "0 8 * * *", agent: "coder", prompt: "x" } })
    expect(dflt.success && dflt.data.brief.autonomy).toBeUndefined()
  })

  it("dispatches with the job's autonomy and persists blocked actions on the run record", async () => {
    const prevCwd = process.cwd()
    process.chdir(root)
    try {
      const execute = vi.fn(async () => ({
        content: "3 MRs open", duration: 5, autonomy: "report",
        autonomyBlocks: [{ ts: 1, tool: "Write", target: "/w/x.md", ruleId: "autonomy.report.write", reason: "Write modifies files" }],
      }))
      const s: any = new CronScheduler(
        { crons: parseCrons({ brief: { schedule: "0 8 * * *", agent: "coder", prompt: "brief", autonomy: "report" } }).data, agents: {}, notifications: {} } as any,
        { execute } as any,
        undefined,
        () => {},
      )
      s.scheduleNext = () => {}
      s.running = true
      await s.executeJob("brief")

      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ autonomy: "report", context: { channel: "cron", chatId: "cron:brief" } }))
      const dir = join(root, ".agentx/cron/runs/brief")
      const run = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"))
      expect(run.success).toBe(true)
      expect(run.autonomy).toBe("report")
      expect(run.autonomyBlocks[0].ruleId).toBe("autonomy.report.write")
    } finally {
      process.chdir(prevCwd)
    }
  })

  it("catch-up (missed) runs keep the job's autonomy", async () => {
    const prevCwd = process.cwd()
    process.chdir(root)
    try {
      const execute = vi.fn(async () => ({ content: "ok", duration: 1 }))
      const s: any = new CronScheduler(
        { crons: parseCrons({ brief: { schedule: "0 8 * * *", agent: "coder", prompt: "brief", autonomy: "propose" } }).data, agents: {}, notifications: {} } as any,
        { execute } as any,
        undefined,
        () => {},
      )
      await s.executeMissedRuns([{ jobId: "brief", missedAt: new Date(0) }])
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ autonomy: "propose" }))
    } finally {
      process.chdir(prevCwd)
    }
  })
})
