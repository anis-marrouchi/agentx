import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { executeTask, type AgentTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"
import { setAutonomyHookPort } from "../src/guard/autonomy-enforce"

// #2101 R26 B1: a click on a working agent opened its Task page, and the
// conversation stayed at "Waiting for the first words…". The agent was a
// one-shot claude-code agent (not a persistent process) and its run had no
// caller onDelta (a job wake, a schedule, a channel run), so `claude` ran
// in json mode and sent no events. A caller that listens to events must get
// them while the run goes, with the same answer as before.

function agent(workspace: string): AgentDef {
  return {
    name: "One Shot",
    workspace,
    tier: "claude-code",
    mentions: [],
    intents: [],
    maxDelegationDepth: 5,
    contextReferences: false,
    maxConcurrent: 1,
    maxExecutionMinutes: 1,
    permissionMode: "default",
    queueMode: "collect",
    heartbeat: { enabled: false, intervalMinutes: 30, prompt: "", channel: "heartbeat" },
  } as AgentDef
}

const task: AgentTask = { message: "read the file", agentId: "one-shot", taskId: "t-r26" }

/** A fake `claude`: writes its args to a file, then answers in the format asked for. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs")
const args = process.argv.slice(2)
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args))
// A daemon shutdown: something outside sends SIGTERM before any output.
if (process.env.FAKE_CLAUDE_SIGTERM) process.kill(process.pid, "SIGTERM")
const fmt = args[args.indexOf("--output-format") + 1]
if (fmt === "stream-json") {
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
  out({ type: "system", subtype: "init", model: "fake" })
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "a.ts" } }] } })
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "export const a = 1" }] } })
  out({ type: "assistant", message: { content: [{ type: "text", text: "It exports a = 1." }] } })
  out({ type: "result", subtype: "success", result: "It exports a = 1.", session_id: "s-1" })
} else {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "It exports a = 1.", session_id: "s-1" }))
}
`

describe("a one-shot claude-code run streams its events (#2101 R26 B1)", () => {
  let tmp: string
  const oldEnv = { ...process.env }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-claude-oneshot-"))
    writeFileSync(join(tmp, "claude"), FAKE)
    chmodSync(join(tmp, "claude"), 0o755)
    process.env.PATH = `${tmp}:${oldEnv.PATH || ""}`
    process.env.FAKE_CLAUDE_ARGS = join(tmp, "args.json")
  })

  afterEach(() => {
    setAutonomyHookPort(null)
    process.env = { ...oldEnv }
    rmSync(tmp, { recursive: true, force: true })
  })

  const args = (): string[] => JSON.parse(readFileSync(join(tmp, "args.json"), "utf-8"))

  it("sends events to a caller that listens, without an onDelta", async () => {
    const events: any[] = []
    const res = await executeTask(agent(tmp), task, {}, undefined, undefined, undefined, (e) => events.push(e))
    expect(args()).toContain("stream-json")
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "user", "assistant", "result"])
    expect(res.error).toBeUndefined()
    expect(res.content).toBe("It exports a = 1.")
  })

  it("keeps json mode for a caller that listens to nothing", async () => {
    const res = await executeTask(agent(tmp), task, {})
    expect(args()[args().indexOf("--output-format") + 1]).toBe("json")
    expect(res.content).toBe("It exports a = 1.")
  })

  it("streams a guarded run too (restricted autonomy, no onDelta)", async () => {
    setAutonomyHookPort(1)
    const events: any[] = []
    const guarded: AgentTask = { ...task, autonomy: "report" }
    const res = await executeTask(agent(tmp), guarded, {}, undefined, undefined, undefined, (e) => events.push(e))
    expect(args()).toContain("stream-json")
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "user", "assistant", "result"])
    expect(res.error).toBeUndefined()
    expect(res.content).toBe("It exports a = 1.")
    expect(res.autonomy).toBe("report")
  })

  it("keeps json mode for a guarded run that listens to nothing", async () => {
    setAutonomyHookPort(1)
    const res = await executeTask(agent(tmp), { ...task, autonomy: "report" }, {})
    expect(args()[args().indexOf("--output-format") + 1]).toBe("json")
    expect(res.content).toBe("It exports a = 1.")
  })

  it("labels an outside SIGTERM \"interrupted\" on the streaming path, as on the json path (B2)", async () => {
    process.env.FAKE_CLAUDE_SIGTERM = "1"
    const streamed = await executeTask(agent(tmp), task, {}, undefined, undefined, undefined, () => {})
    expect(args()).toContain("stream-json")
    expect(streamed.errorKind).toBe("interrupted")
    expect(streamed.error).toMatch(/stopped \(SIGTERM\)/)
  })
})
