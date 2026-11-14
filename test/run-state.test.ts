import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describeJobState, JOB_STATE_ASK, jobStateFrom, jobStateInText, needsJobState } from "../src/agents/run-state"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"

describe("which runs state their job's state", () => {
  const on = { enabled: true, channels: ["a2a", "cron", "reminder", "events"] }
  it("agent channels only, never a person's chat or a workflow step", () => {
    expect(needsJobState(on, "a2a")).toBe(true)
    expect(needsJobState(on, "cron")).toBe(true)
    expect(needsJobState(on, "telegram")).toBe(false)
    expect(needsJobState(on, "whatsapp")).toBe(false)
    expect(needsJobState(on, "workflow")).toBe(false)
    expect(needsJobState(on, undefined)).toBe(false)
    expect(needsJobState({ ...on, enabled: false }, "a2a")).toBe(false)
  })
  it("is on for a2a, cron, reminder and events by default", () => {
    const c = daemonConfigSchema.parse({ node: { id: "t", name: "t" }, agents: {} })
    expect(c.jobState).toEqual(on)
  })
})

describe("the four states", () => {
  it("each needs its own detail", () => {
    expect(jobStateFrom({ state: "done", proof: "PR #9" })).toEqual({ state: "done", proof: "PR #9" })
    expect(jobStateFrom({ state: "done" })).toMatch(/proof/)
    expect(jobStateFrom({ state: "continue", left: "tests", when: "18:00" })).toEqual({ state: "continue", left: "tests", when: "18:00" })
    expect(jobStateFrom({ state: "continue" })).toMatch(/left/)
    expect(jobStateFrom({ state: "waiting", on: "devops", until: "2030-01-01T00:00:00Z" })).toEqual({ state: "waiting", on: "devops", until: "2030-01-01T00:00:00Z" })
    expect(jobStateFrom({ state: "waiting" })).toMatch(/on whom/)
    expect(jobStateFrom({ state: "blocked", why: "no token" })).toEqual({ state: "blocked", why: "no token" })
    expect(jobStateFrom({ state: "blocked" })).toMatch(/why/)
    expect(jobStateFrom({ state: "finished" })).toMatch(/one of done, continue, waiting, blocked/)
  })
  it("reads a state from one of the last lines of a reply", () => {
    expect(jobStateInText("Merged.\n\nState: done — https://x/pr/9")).toEqual({ state: "done", proof: "https://x/pr/9" })
    expect(jobStateInText("ok\n**State:** waiting: devops review, until 18:00")).toEqual({ state: "waiting", on: "devops review, until 18:00" })
    expect(jobStateInText("Job state: blocked - no token")).toEqual({ state: "blocked", why: "no token" })
    expect(jobStateInText("state: continue — tests, tonight")).toEqual({ state: "continue", left: "tests, tonight" })
    expect(jobStateInText("State: done")).toBeNull()
    expect(jobStateInText("The state: done is reached")).toBeNull()
    expect(jobStateInText("State: done — x\n1\n2\n3\n4\n5")).toBeNull()
    expect(jobStateInText("")).toBeNull()
  })
  it("says each in one line", () => {
    expect(describeJobState({ state: "waiting", on: "devops", until: "18:00" })).toBe("waiting on devops until 18:00")
    expect(describeJobState({ state: "continue", left: "docs", when: "tomorrow" })).toBe("continue — docs (tomorrow)")
  })
})

describe("registry.execute on an agent channel", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-run-state-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function registry(results: Array<AgentResponse | ((task: AgentTask, r: AgentRegistry) => AgentResponse)>, jobState: Record<string, unknown> = {}) {
    const config = daemonConfigSchema.parse({
      node: { id: "t", name: "t" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
      jobState,
    })
    const logs: string[] = []
    const r = new AgentRegistry(config, (...a: unknown[]) => logs.push(a.join(" ")))
    const seen: AgentTask[] = []
    let n = 0
    ;(r as any).runningTaskOwner = (id: string) => (id.startsWith("run-") ? { agentId: "ops", channel: "a2a" } : null)
    ;(r as any).executeInternal = async (task: AgentTask) => {
      task.taskId = `trace-${n}`
      task.runningTaskId = `run-${n}`
      seen.push({ ...task })
      const next = results[n++] ?? { content: "ok" }
      return typeof next === "function" ? next(task, r) : next
    }
    return { r, seen, logs }
  }
  const a2a = { channel: "a2a", chatId: "a2a:pm:ops" }

  it("tells the run the rule, and takes a state on its last line without asking", async () => {
    const { r, seen } = registry([{ content: "Shipped.\nState: done — PR #9" }])
    const res = await r.execute({ agentId: "ops", message: "ship it", context: a2a })
    expect(seen).toHaveLength(1)
    expect(seen[0].message).toMatch(/^\[Job state\][\s\S]*\nship it$/)
    expect(res.content).toBe("Shipped.\nState: done — PR #9")
    expect(res.jobState).toEqual({ state: "done", proof: "PR #9" })
  })

  it("takes a state stated with the tool, and adds it to the answer", async () => {
    const { r, seen } = registry([(task, reg) => {
      reg.recordJobState(task.runningTaskId!, { state: "waiting", on: "devops review" })
      return { content: "PR open." }
    }])
    const res = await r.execute({ agentId: "ops", message: "open the PR", context: a2a })
    expect(seen).toHaveLength(1)
    expect(res.content).toBe("PR open.\n\n[Job state] waiting on devops review")
    expect(res.jobState).toEqual({ state: "waiting", on: "devops review" })
  })

  it("asks once in the same chat, and keeps the run's own answer", async () => {
    const { r, seen, logs } = registry([{ content: "Built it." }, { content: "State: continue — docs, tonight" }])
    const res = await r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(seen).toHaveLength(2)
    expect(seen[1].message).toBe(JOB_STATE_ASK)
    expect(seen[1]).toMatchObject({ context: a2a, jobStateAsk: true, freshSession: false, resumedFrom: "trace-0" })
    expect(res.content).toBe("Built it.\n\n[Job state] continue — docs, tonight")
    expect(res.jobState).toEqual({ state: "continue", left: "docs, tonight" })
    expect(logs.some((l) => /ended with no state; asking once/.test(l))).toBe(true)
  })

  it("marks the job stalled and says so in the answer when still nothing", async () => {
    const { r, seen } = registry([{ content: "Built it." }, { content: "I did the build." }])
    const res = await r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(seen).toHaveLength(2)
    expect(res.content).toMatch(/^Built it\.\n\n\[Job stalled\] ops ended its run without saying/)
    expect(res.jobState).toEqual({ state: "stalled" })
  })

  it("an ask that fails counts as no state", async () => {
    const { r } = registry([{ content: "Built it." }, { content: "", error: "boom" }])
    const res = await r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(res.jobState).toEqual({ state: "stalled" })
    expect(res.error).toBeUndefined()
  })

  it("leaves a person's chat, a failed run and a turned-off setting alone", async () => {
    const chat = registry([{ content: "Hello!" }])
    const res = await chat.r.execute({ agentId: "ops", message: "hi", context: { channel: "telegram", chatId: "1" } })
    expect(chat.seen).toHaveLength(1)
    expect(chat.seen[0].message).toBe("hi")
    expect(res.jobState).toBeUndefined()

    const failed = registry([{ content: "", error: "auth" }])
    const f = await failed.r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(failed.seen).toHaveLength(1)
    expect(f.jobState).toBeUndefined()

    const off = registry([{ content: "Built it." }], { enabled: false })
    const o = await off.r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(off.seen).toHaveLength(1)
    expect(off.seen[0].message).toBe("build")
    expect(o).toMatchObject({ content: "Built it." })
  })

  it("tells the listener what each run said, for its job", async () => {
    const { r } = registry([{ content: "Built it." }, { content: "nothing" }])
    const told: Array<[Array<string | undefined>, string]> = []
    r.setJobStateListener((ids, ev) => told.push([ids, ev.kind]))
    await r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(told).toEqual([
      [["trace-0", "run-0"], "asked"],
      [["trace-0", "run-0", "trace-1", "run-1"], "stalled"],
    ])
  })

  it("refuses a state for a run that is not going", () => {
    const { r } = registry([])
    expect(r.recordJobState("gone", { state: "blocked", why: "x" })).toBe(false)
    expect(r.recordJobState("run-7", { state: "blocked", why: "x" })).toBe(true)
  })
})
