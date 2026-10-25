import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildTimeLimitNote, DEFAULT_TIME_LIMIT_SETTINGS, planTimeLimit, reportedTimeLimitError,
  timeLimitContinuations, timeLimitMinutes,
} from "../src/agents/resume/time-limit"
import { sendTimeoutMs } from "../src/daemon/delegation-wiring"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"

// A run stopped at its agent's time limit used to end as a bare error and
// was never picked up again (#1257). It is now continued once in the same
// chat, with a note, and answers the same caller; when it can't be, the
// error says why.

const LIMIT_ERR = `Claude Code timed out after 30m. Bump agent.maxExecutionMinutes for "Ops" if tasks need longer.`
const plan = (over: Partial<Parameters<typeof planTimeLimit>[0]> = {}) => planTimeLimit({
  error: LIMIT_ERR, errorKind: "timeout", channel: "a2a", chatId: "a2a:sec:ops",
  continuation: 0, elapsedMs: 30 * 60_000, callerGone: false, settings: DEFAULT_TIME_LIMIT_SETTINGS, ...over,
})

describe("timeLimitMinutes", () => {
  it("reads the runtimes' own time-limit messages", () => {
    expect(timeLimitMinutes(LIMIT_ERR, "timeout")).toBe(30)
    expect(timeLimitMinutes("Claude Code timed out after 90m (SIGTERM). Bump …", "timeout")).toBe(90)
    expect(timeLimitMinutes("Codex CLI timed out after 20m. Bump …", "timeout")).toBe(20)
    expect(timeLimitMinutes("OpenCode timed out after 5m. Bump …", "timeout")).toBe(5)
  })
  it("ignores a caller's deadline, a busy slot, a pre-spawn stall and other errors", () => {
    expect(timeLimitMinutes("timed out after 1800s", "timeout")).toBeNull()
    expect(timeLimitMinutes(`Agent "ops" busy — slot wait timed out after 25m`, undefined)).toBeNull()
    expect(timeLimitMinutes(`timed out before spawn after 300s in step "skills"`, "timeout")).toBeNull()
    expect(timeLimitMinutes(LIMIT_ERR, "interrupted")).toBeNull()
    expect(timeLimitMinutes(undefined, undefined)).toBeNull()
  })
})

describe("planTimeLimit", () => {
  it("continues a time-limit stop once", () => {
    expect(plan()).toEqual({ action: "continue", minutes: 30, continuation: 1 })
    expect(plan({ continuation: 1 })).toMatchObject({ action: "report", reason: "already continued once" })
  })
  it("leaves other errors and mesh runs alone", () => {
    expect(plan({ error: "boom", errorKind: "unknown" })).toEqual({ action: "none" })
    expect(plan({ viaMesh: "peer-a" })).toEqual({ action: "none" })
  })
  it("reports scheduled jobs, workflow steps and runs nobody waits for", () => {
    expect(plan({ channel: "cron" })).toMatchObject({ action: "report", reason: expect.stringMatching(/scheduled job/) })
    expect(plan({ workflowRunId: "run-1" })).toMatchObject({ action: "report", reason: expect.stringMatching(/workflow step/) })
    expect(plan({ chatId: "workflow:run-1" })).toMatchObject({ action: "report", reason: expect.stringMatching(/workflow step/) })
    expect(plan({ callerGone: true })).toMatchObject({ action: "report", reason: expect.stringMatching(/nobody is waiting/) })
  })
  it("reports when turned off or capped at 0", () => {
    expect(plan({ settings: { enabled: false, maxContinuations: 1 } })).toMatchObject({ action: "report", reason: expect.stringMatching(/turned off/) })
    expect(plan({ settings: { enabled: true, maxContinuations: 0 } })).toMatchObject({ action: "report", reason: expect.stringMatching(/turned off/) })
  })
  it("keeps within the caller's own deadline", () => {
    expect(plan({ timeoutMinutes: 90 })).toEqual({ action: "continue", minutes: 30, continuation: 1, timeoutMinutes: 60 })
    expect(plan({ timeoutMinutes: 31 })).toMatchObject({ action: "report", reason: expect.stringMatching(/caller's own time limit/) })
  })
})

describe("the continuation note", () => {
  it("says it hit the limit, lists the tool calls, and asks to finish or report on the last run", () => {
    const note = buildTimeLimitNote(30, [{ action: "Bash", inputSummary: "render  video.mp4" }], true)
    expect(note).toMatch(/^\[Continued after the time limit\] You worked on this request for 30 min/)
    expect(note).toContain("1. Bash: render video.mp4")
    expect(note).toMatch(/check whether it already happened/)
    expect(note).toMatch(/last run for it.*say what is done, what is left/s)
    expect(buildTimeLimitNote(30, [], false)).toMatch(/No tool calls were recorded[\s\S]*Carry on from where you stopped/)
  })
  it("keeps the runtime's message when not continued", () => {
    expect(reportedTimeLimitError(LIMIT_ERR, "already continued once"))
      .toBe(`${LIMIT_ERR} It was not continued (already continued once).`)
  })
})

describe("a send's wait covers the continuation", () => {
  it("adds the agent's time limit once per continuation", () => {
    expect(timeLimitContinuations(DEFAULT_TIME_LIMIT_SETTINGS)).toBe(1)
    expect(timeLimitContinuations({ enabled: false, maxContinuations: 2 })).toBe(0)
    expect(sendTimeoutMs(90, 1)).toBe(210 * 60_000)
    expect(sendTimeoutMs(90)).toBe(120 * 60_000)
  })
  it("defaults to one continuation in the config", () => {
    const config = daemonConfigSchema.parse({ node: { id: "t", name: "t" } })
    expect(config.resume.timeLimit).toEqual({ enabled: true, maxContinuations: 1 })
  })
})

describe("registry.execute after a time-limit stop", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-time-limit-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function registry(results: AgentResponse[], resume: Record<string, unknown> = {}) {
    const config = daemonConfigSchema.parse({
      node: { id: "t", name: "t" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
      resume,
    })
    const logs: string[] = []
    const r = new AgentRegistry(config, (...a: unknown[]) => logs.push(a.join(" ")))
    const seen: AgentTask[] = []
    let n = 0
    ;(r as any).executeInternal = async (task: AgentTask) => {
      task.taskId = `trace-${n}`
      seen.push({ ...task })
      return results[n++] ?? { content: "done" }
    }
    r.setTraceToolCalls((id) => id === "trace-0" ? [{ action: "Bash", inputSummary: "make render" }] : [])
    return { r, seen, logs }
  }
  const stopped: AgentResponse = { content: "", error: LIMIT_ERR, errorKind: "timeout" }

  it("continues the same chat with the note and answers the caller", async () => {
    const { r, seen, logs } = registry([stopped, { content: "render finished" }])
    const res = await r.execute({ agentId: "ops", message: "render the intro", context: { channel: "a2a", chatId: "a2a:sec:ops" } })
    expect(res).toMatchObject({ content: "render finished" })
    expect(res.error).toBeUndefined()
    expect(seen).toHaveLength(2)
    expect(seen[1].context).toEqual({ channel: "a2a", chatId: "a2a:sec:ops" })
    expect(seen[1].message).toMatch(/^\[Continued after the time limit\][\s\S]*1\. Bash: make render[\s\S]*\nrender the intro$/)
    expect(seen[1]).toMatchObject({ timeLimitContinuation: 1, resumedFrom: "trace-0", timeLimitRequest: "render the intro" })
    expect(logs.some((l) => /stopped at its 30m time limit; continuing \(1\/1\)/.test(l))).toBe(true)
  })

  it("stops after the cap and says so", async () => {
    const { r, seen } = registry([stopped, stopped])
    const res = await r.execute({ agentId: "ops", message: "render", context: { channel: "a2a", chatId: "x" } })
    expect(seen).toHaveLength(2)
    expect(res.error).toBe(`${LIMIT_ERR} It was not continued (already continued once).`)
    expect(res.errorKind).toBe("timeout")
  })

  it("never continues a scheduled job, and can be turned off", async () => {
    const cron = registry([stopped])
    const res = await cron.r.execute({ agentId: "ops", message: "nightly", context: { channel: "cron", chatId: "job" } })
    expect(cron.seen).toHaveLength(1)
    expect(res.error).toMatch(/not continued \(scheduled job/)

    const off = registry([stopped], { timeLimit: { enabled: false } })
    await off.r.execute({ agentId: "ops", message: "render", context: { channel: "a2a", chatId: "x" } })
    expect(off.seen).toHaveLength(1)
  })
})
