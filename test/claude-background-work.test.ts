import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { BackgroundTasks, executeTask, type AgentTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

// #892: a claude-code run that leaves background work at the end of a turn
// keeps working, and the CLI runs a new turn when that work ends. The task
// must stay open (and stoppable) until then, and carry the later answer.

function baseAgent(workspace: string): AgentDef {
  return {
    name: "Bg Test",
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

const task: AgentTask = { message: "run the steps", agentId: "bg", taskId: "t-892" }

/** A fake `claude` that prints the stream-json events of a scenario. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs")
const marker = process.env.FAKE_CLAUDE_MARKER
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
const text = (t) => out({ type: "assistant", message: { content: [{ type: "text", text: t }] } })
const result = (t) => out({ type: "result", subtype: "success", result: t, session_id: "s-1" })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
process.on("SIGTERM", () => { fs.writeFileSync(marker, "killed"); process.exit(143) })
;(async () => {
  out({ type: "system", subtype: "init", model: "fake" })
  if (process.env.FAKE_CLAUDE_SCENARIO === "background") {
    text("Step 1 runs in the background.")
    out({ type: "system", subtype: "task_started", task_id: "b1", is_backgrounded: true })
    result("Step 1 runs in the background.")
    await wait(1600)
    out({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed" })
    text("All steps done.")
    result("All steps done.")
    fs.writeFileSync(marker, "finished")
    await wait(10000)
  } else if (process.env.FAKE_CLAUDE_SCENARIO === "foreground") {
    out({ type: "system", subtype: "task_started", task_id: "f1", is_backgrounded: false })
    text("Done.")
    result("Done.")
    await wait(10000)
    fs.writeFileSync(marker, "finished")
  } else {
    text("Done.")
    result("Done.")
    await wait(10000)
    fs.writeFileSync(marker, "finished")
  }
})()
`

describe("claude-code streaming run with background work (#892)", () => {
  let tmp: string
  let marker: string
  const oldEnv = { ...process.env }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-claude-bg-"))
    marker = join(tmp, "marker")
    writeFileSync(join(tmp, "claude"), FAKE)
    chmodSync(join(tmp, "claude"), 0o755)
    process.env.PATH = `${tmp}:${oldEnv.PATH || ""}`
    process.env.FAKE_CLAUDE_MARKER = marker
  })

  afterEach(() => {
    process.env = { ...oldEnv }
    rmSync(tmp, { recursive: true, force: true })
  })

  it("stays open past the first result and returns the answer of the last turn", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "background"
    let streamed = ""
    const res = await executeTask(baseAgent(tmp), task, {}, (_d, full) => { streamed = full })
    expect(res.error).toBeUndefined()
    expect(existsSync(marker)).toBe(true)
    expect(res.duration).toBeGreaterThanOrEqual(1500)
    expect(res.content).toBe("Step 1 runs in the background.\n\nAll steps done.")
    expect(streamed).toBe(res.content)
  })

  it("can be stopped while it waits on background work", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "background"
    const ac = new AbortController()
    setTimeout(() => ac.abort("stop"), 600)
    const res = await executeTask(baseAgent(tmp), task, {}, () => {}, undefined, undefined, undefined, ac.signal)
    expect(res.errorKind).toBe("cancelled")
    expect(res.duration).toBeLessThan(1500)
  })

  it("still settles right after the result when nothing runs in the background", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "plain"
    const res = await executeTask(baseAgent(tmp), task, {}, () => {})
    expect(res.content).toBe("Done.")
    expect(res.duration).toBeLessThan(5000)
  })

  it("does not wait on a subagent the turn already waited for", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "foreground"
    const res = await executeTask(baseAgent(tmp), task, {}, () => {})
    expect(res.content).toBe("Done.")
    expect(res.duration).toBeLessThan(5000)
  })
})

describe("BackgroundTasks", () => {
  it("counts started background tasks until their notification", () => {
    const bg = new BackgroundTasks()
    bg.observe({ type: "system", subtype: "task_started", task_id: "a" })
    bg.observe({ type: "system", subtype: "task_started", task_id: "b", is_backgrounded: true })
    bg.observe({ type: "system", subtype: "task_started", task_id: "c", is_backgrounded: false })
    expect(bg.pending).toBe(2)
    bg.observe({ type: "system", subtype: "task_notification", task_id: "a", status: "completed" })
    bg.observe({ type: "system", subtype: "task_notification", task_id: "b", status: "stopped" })
    expect(bg.pending).toBe(0)
  })

  it("ignores other events", () => {
    const bg = new BackgroundTasks()
    bg.observe({ type: "result", task_id: "x" })
    bg.observe({ type: "system", subtype: "init" })
    bg.observe(null)
    expect(bg.pending).toBe(0)
  })
})
