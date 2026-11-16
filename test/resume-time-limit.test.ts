import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildTimeLimitNote, DEFAULT_TIME_LIMIT_SETTINGS, handedOffTimeLimitError, planTimeLimit, reportedTimeLimitError,
  timeLimitMinutes,
} from "../src/agents/resume/time-limit"
import { sendTimeoutMs } from "../src/daemon/delegation-wiring"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"

// A run stopped at its agent's time limit used to end as a bare error and
// was never picked up again (#1257). Then the registry continued it once
// itself. Now its job continues it (#1861): the stop is handed to the
// job's wake, and the caller gets the stop at once; when no wake takes
// it, the error says why.

const LIMIT_ERR = `Claude Code timed out after 30m. Bump agent.maxExecutionMinutes for "Ops" if tasks need longer.`
const plan = (over: Partial<Parameters<typeof planTimeLimit>[0]> = {}) => planTimeLimit({
  error: LIMIT_ERR, errorKind: "timeout", channel: "a2a", chatId: "a2a:sec:ops", settings: DEFAULT_TIME_LIMIT_SETTINGS, ...over,
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
  it("hands a time-limit stop to its job", () => {
    expect(plan()).toEqual({ action: "handoff", minutes: 30 })
  })
  it("leaves other errors and mesh runs alone", () => {
    expect(plan({ error: "boom", errorKind: "unknown" })).toEqual({ action: "none" })
    expect(plan({ viaMesh: "peer-a" })).toEqual({ action: "none" })
  })
  it("reports scheduled jobs and workflow steps", () => {
    expect(plan({ channel: "cron" })).toMatchObject({ action: "report", reason: expect.stringMatching(/scheduled job/) })
    expect(plan({ workflowRunId: "run-1" })).toMatchObject({ action: "report", reason: expect.stringMatching(/workflow step/) })
    expect(plan({ chatId: "workflow:run-1" })).toMatchObject({ action: "report", reason: expect.stringMatching(/workflow step/) })
  })
  it("reports when turned off", () => {
    expect(plan({ settings: { enabled: false } })).toMatchObject({ action: "report", reason: expect.stringMatching(/turned off/) })
  })
})

describe("the wake note", () => {
  it("says it hit the limit and lists the tool calls, short enough for a job note", () => {
    const note = buildTimeLimitNote(30, [{ action: "Bash", inputSummary: "render  video.mp4" }])
    expect(note).toMatch(/^your last run was stopped at its 30 min time limit/)
    expect(note).toContain("1. Bash: render video.mp4")
    expect(note).toMatch(/Carry on from where it stopped\.$/)
    expect(buildTimeLimitNote(30, [])).toMatch(/No tool calls were recorded/)
    const many = Array.from({ length: 40 }, () => ({ action: "Bash", inputSummary: "x".repeat(500) }))
    const long = buildTimeLimitNote(90, many)
    expect(long).toContain("…and 32 more")
    expect(long.length).toBeLessThanOrEqual(1000)
  })
  it("keeps the runtime's message, and says who continues it", () => {
    expect(reportedTimeLimitError(LIMIT_ERR, "workflow step")).toBe(`${LIMIT_ERR} It was not continued (workflow step).`)
    expect(handedOffTimeLimitError(LIMIT_ERR, "job-1")).toBe(`${LIMIT_ERR} Its job job-1 continues it in a new run.`)
  })
})

describe("a send's wait", () => {
  it("is the callee's own time limit: no continuation inside the send", () => {
    expect(sendTimeoutMs(90)).toBe(120 * 60_000)
  })
  it("has no continuation cap in the config", () => {
    const config = daemonConfigSchema.parse({ node: { id: "t", name: "t" } })
    expect(config.resume.timeLimit).toEqual({ enabled: true })
    // An old config with the cap still parses: the key is dropped.
    const old = daemonConfigSchema.parse({ node: { id: "t", name: "t" }, resume: { timeLimit: { enabled: true, maxContinuations: 2 } } })
    expect(old.resume.timeLimit).toEqual({ enabled: true })
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
      // The job-state ask (run-state.test.ts) would add a turn here.
      jobState: { enabled: false },
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

  it("hands the stop to its job's wake, with the note, and runs nothing more itself", async () => {
    const { r, seen, logs } = registry([stopped, { content: "never run" }])
    const handed: Array<{ runIds: Array<string | undefined>; note: string }> = []
    r.setTimeLimitHandoff((runIds, note) => { handed.push({ runIds, note }); return "job-7" })
    const res = await r.execute({ agentId: "ops", message: "render the intro", context: { channel: "a2a", chatId: "a2a:sec:ops" } })
    expect(seen).toHaveLength(1)
    expect(res.error).toBe(handedOffTimeLimitError(LIMIT_ERR, "job-7"))
    expect(res.errorKind).toBe("timeout")
    expect(handed).toHaveLength(1)
    expect(handed[0].runIds[0]).toBe("trace-0")
    expect(handed[0].note).toMatch(/30 min time limit[\s\S]*1\. Bash: make render/)
    expect(logs.some((l) => /stopped at its 30m time limit; its job job-7 continues it/.test(l))).toBe(true)
  })

  it("says so when no job's wake takes it", async () => {
    const { r, seen } = registry([stopped])
    r.setTimeLimitHandoff(() => null)
    const res = await r.execute({ agentId: "ops", message: "render", context: { channel: "a2a", chatId: "x" } })
    expect(seen).toHaveLength(1)
    expect(res.error).toMatch(/not continued \(no job's wake took it/)
    // Unset, the same.
    const bare = registry([stopped])
    expect((await bare.r.execute({ agentId: "ops", message: "render", context: { channel: "a2a", chatId: "x" } })).error)
      .toMatch(/no job's wake took it/)
  })

  it("never hands off a scheduled job, and can be turned off", async () => {
    let calls = 0
    const cron = registry([stopped])
    cron.r.setTimeLimitHandoff(() => { calls++; return "job-1" })
    const res = await cron.r.execute({ agentId: "ops", message: "nightly", context: { channel: "cron", chatId: "job" } })
    expect(cron.seen).toHaveLength(1)
    expect(res.error).toMatch(/not continued \(scheduled job/)

    const off = registry([stopped], { timeLimit: { enabled: false } })
    off.r.setTimeLimitHandoff(() => { calls++; return "job-1" })
    expect((await off.r.execute({ agentId: "ops", message: "render", context: { channel: "a2a", chatId: "x" } })).error).toMatch(/turned off/)
    expect(calls).toBe(0)
  })
})
