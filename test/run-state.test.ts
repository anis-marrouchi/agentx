import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describeJobState, endStateInAnswer, JOB_STATE_ASK, jobStateFrom, jobStateInText, needsJobState, stalledLine } from "../src/agents/run-state"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"
import { isQuietRun, NOTHING_TO_REPORT, withQuietRule } from "../src/crons/quiet"
import { withoutExitMarker } from "../src/crons/exit-check"

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
    expect(jobStateInText("ok\n**State:** waiting: devops review, until 18:00")).toEqual({ state: "waiting", on: "devops review", until: "18:00" })
    expect(jobStateInText("Job state: blocked - no token")).toEqual({ state: "blocked", why: "no token" })
    expect(jobStateInText("state: continue — tests, tonight")).toEqual({ state: "continue", left: "tests, tonight" })
    expect(jobStateInText("State: done")).toBeNull()
    expect(jobStateInText("The state: done is reached")).toBeNull()
    expect(jobStateInText("State: done — x\n1\n2\n3\n4\n5")).toBeNull()
    expect(jobStateInText("")).toBeNull()
  })
  it("reads the format as a model copies it: backticks, a bullet, a quote", () => {
    expect(jobStateInText("Merged.\n`State: done — https://x/1`")).toEqual({ state: "done", proof: "https://x/1" })
    expect(jobStateInText("- State: blocked — no token")).toEqual({ state: "blocked", why: "no token" })
    expect(jobStateInText("* `State: done — PR #9`")).toEqual({ state: "done", proof: "PR #9" })
    expect(jobStateInText("> **State: done** — PR #9")).toEqual({ state: "done", proof: "PR #9" })
    expect(jobStateInText("`State: done`")).toBeNull()
    expect(jobStateInText("- the state: done is reached")).toBeNull()
  })
  it("reads until when a wait lasts and when a continue carries on", () => {
    expect(jobStateInText("State: waiting — devops review, until 2030-01-31T17:00:00Z")).toEqual({ state: "waiting", on: "devops review", until: "2030-01-31T17:00:00Z" })
    expect(jobStateInText("State: waiting — the build")).toEqual({ state: "waiting", on: "the build" })
    expect(jobStateInText("State: continue — docs (tomorrow)")).toEqual({ state: "continue", left: "docs", when: "tomorrow" })
    expect(jobStateInText("State: continue — docs, 2030-01-31T17:00:00Z")).toEqual({ state: "continue", left: "docs", when: "2030-01-31T17:00:00Z" })
    expect(jobStateInText("State: continue — docs, tonight")).toEqual({ state: "continue", left: "docs, tonight" })
  })
  it("reads back the line the registry adds to an answer", () => {
    for (const s of [
      { state: "done", proof: "PR #9" }, { state: "blocked", why: "no token" },
      { state: "waiting", on: "devops", until: "18:00" }, { state: "continue", left: "docs", when: "tomorrow" },
    ] as const) {
      expect(endStateInAnswer(`Answer.\n\n[Job state] ${describeJobState(s)}`)).toEqual(s)
    }
    expect(endStateInAnswer(`Answer.\n\n${stalledLine("ops")}`)).toEqual({ state: "stalled" })
    expect(endStateInAnswer("Answer.")).toBeNull()
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

  it("the question is not the work again: no intent to settle", async () => {
    const { r, seen } = registry([{ content: "Built it." }, { content: "`State: done — PR #9`" }])
    const res = await r.execute({
      agentId: "ops", message: "build", context: { channel: "cron", chatId: "nightly" },
      intentRef: { eventId: "ev-1", decidedBy: "cron" },
    })
    expect(seen).toHaveLength(2)
    expect(seen[0].intentRef).toEqual({ eventId: "ev-1", decidedBy: "cron" })
    expect(seen[1]).toMatchObject({ jobStateAsk: true, message: JOB_STATE_ASK })
    expect(seen[1].intentRef).toBeUndefined()
    expect(res.jobState).toEqual({ state: "done", proof: "PR #9" })
  })

  it("marks the job stalled and says so in the answer when still nothing", async () => {
    const { r, seen } = registry([{ content: "Built it." }, { content: "I did the build." }])
    const res = await r.execute({ agentId: "ops", message: "build", context: a2a })
    expect(seen).toHaveLength(2)
    expect(res.content).toMatch(/^Built it\.\n\n\[Job stalled\] ops ended its run without saying/)
    expect(res.jobState).toEqual({ state: "stalled" })
  })

  it("a quiet schedule stays quiet: no ask, no added line, nothing to post (#1289)", async () => {
    const cron = { channel: "cron", chatId: "nightly" }
    const quiet = async (result: Parameters<typeof registry>[0][number], report: "exceptions" = "exceptions") => {
      const { r, seen } = registry([result, { content: "State: done — checked" }])
      const res = await r.execute({ agentId: "ops", message: withQuietRule("check", report), context: cron })
      expect(seen).toHaveLength(1)
      // As the scheduler reads it (an exit-code schedule without its marker).
      expect(isQuietRun(report, withoutExitMarker(res.content))).toBe(true)
      return res
    }
    // The quiet word alone: done, nothing sent.
    const bare = await quiet({ content: NOTHING_TO_REPORT })
    expect(bare.content).toBe(NOTHING_TO_REPORT)
    expect(bare.jobState).toEqual({ state: "done", proof: "nothing to report" })
    // The run followed the state rule as well: the state is kept, the line is not posted.
    const withLine = await quiet({ content: `${NOTHING_TO_REPORT}\nState: done — all 4 checks green` })
    expect(withLine.content).toBe(NOTHING_TO_REPORT)
    expect(withLine.jobState).toEqual({ state: "done", proof: "all 4 checks green" })
    // Stated with the tool: no "[Job state]" line goes on the quiet word.
    const tool = await quiet((task, reg) => {
      reg.recordJobState(task.runningTaskId!, { state: "done", proof: "checked" })
      return { content: NOTHING_TO_REPORT }
    })
    expect(tool.content).toBe(NOTHING_TO_REPORT)
    // An exit-code schedule keeps its marker last.
    const exit = await quiet({ content: `${NOTHING_TO_REPORT}\nState: done — ran it\nEXIT=0` })
    expect(exit.content).toBe(`${NOTHING_TO_REPORT}\nEXIT=0`)
  })

  it("a schedule with something to say is still asked, but its answer is posted as it is", async () => {
    const cron = { channel: "cron", chatId: "nightly" }
    const { r, seen } = registry([{ content: "Disk is 95% full.\nEXIT=0" }, { content: "State: blocked — needs cleanup" }])
    const res = await r.execute({ agentId: "ops", message: "check", context: cron })
    expect(seen).toHaveLength(2)
    // The state is on the job's row only; the exit marker stays last.
    expect(res.content).toBe("Disk is 95% full.\nEXIT=0")
    expect(res.jobState).toEqual({ state: "blocked", why: "needs cleanup" })
    const tool = registry([(task, reg) => {
      reg.recordJobState(task.runningTaskId!, { state: "done", proof: "checked" })
      return { content: "Disk is 80% full." }
    }])
    expect((await tool.r.execute({ agentId: "ops", message: "check", context: cron })).content).toBe("Disk is 80% full.")
    const stalled = registry([{ content: "Disk is 95% full." }, { content: "no idea" }])
    const s = await stalled.r.execute({ agentId: "ops", message: "check", context: cron })
    expect(s).toMatchObject({ content: "Disk is 95% full.", jobState: { state: "stalled" } })
  })

  it("a reminder's answer goes to a person: an approvals check-in text stays as composed", async () => {
    const checkin = { channel: "reminder", chatId: "checkin:r-1", sender: "approvals" }
    const text = "Anis, 2 approvals wait for you:\n1. Merge PR #12\n2. Pay invoice 44"
    // Stated with the tool: no line added.
    const tool = registry([(task, reg) => {
      reg.recordJobState(task.runningTaskId!, { state: "done", proof: "composed" })
      return { content: text }
    }])
    const t = await tool.r.execute({ agentId: "secretary", message: "compose", context: checkin })
    expect(tool.seen).toHaveLength(1)
    expect(t).toMatchObject({ content: text, jobState: { state: "done", proof: "composed" } })
    // Its own State line is kept on the row, not posted.
    const own = registry([{ content: `${text}\nState: done — composed` }])
    const o = await own.r.execute({ agentId: "secretary", message: "compose", context: checkin })
    expect(own.seen).toHaveLength(1)
    expect(o).toMatchObject({ content: text, jobState: { state: "done", proof: "composed" } })
    // Stated when asked, or never: no [Job state] or [Job stalled] line.
    const asked = registry([{ content: text }, { content: "State: done — composed" }])
    expect((await asked.r.execute({ agentId: "secretary", message: "compose", context: checkin })).content).toBe(text)
    const stalled = registry([{ content: text }, { content: "no idea" }])
    expect(await stalled.r.execute({ agentId: "secretary", message: "compose", context: checkin })).toMatchObject({ content: text, jobState: { state: "stalled" } })
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
  // The due-time gate (#1908): beside the answer, never before it.
  describe("the due-time gate", () => {
    const telegram = { channel: "telegram", chatId: "chat-1" }
    const tick = () => new Promise((res) => setTimeout(res, 0))

    it("gets each clean run with a reply, and can ask one question in the same session", async () => {
      const { r, seen } = registry([{ content: "I will post the review by 15:00Z" }, { content: "Due: none" }])
      const runs: any[] = []
      const answers: any[] = []
      r.setDueTimeGate(async (run, askAgent) => {
        runs.push(run)
        answers.push(await askAgent("[Due time] record it"))
      })
      const before = Date.now()
      const res = await r.execute({ agentId: "ops", message: "review it", context: telegram })
      // The caller has the run's own answer, unchanged.
      expect(res.content).toBe("I will post the review by 15:00Z")
      await tick()
      await tick()
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ agentId: "ops", channel: "telegram", chatId: "chat-1", runIds: ["trace-0", "run-0"], reply: "I will post the review by 15:00Z" })
      expect(runs[0].startedAt).toBeGreaterThanOrEqual(before)
      expect(seen).toHaveLength(2)
      expect(seen[1]).toMatchObject({ message: "[Due time] record it", context: telegram, jobStateAsk: true, freshSession: false, resumedFrom: "trace-0" })
      expect(answers).toEqual([{ reply: "Due: none", error: undefined }])
      // The question's own turn is not checked again.
      expect(runs).toHaveLength(1)
    })

    it("is not given a failed run, an empty reply, or a run with no gate set", async () => {
      const { r } = registry([{ content: "", error: "boom" }, { content: "  " }, { content: "fine" }])
      const runs: any[] = []
      r.setDueTimeGate(async (run) => { runs.push(run) })
      await r.execute({ agentId: "ops", message: "a", context: telegram })
      await r.execute({ agentId: "ops", message: "b", context: telegram })
      await tick()
      expect(runs).toEqual([])
      r.setDueTimeGate(undefined)
      expect((await r.execute({ agentId: "ops", message: "c", context: telegram })).content).toBe("fine")
    })

    it("never fails the run when the gate throws", async () => {
      const { r, logs } = registry([{ content: "done by 15:00Z" }])
      r.setDueTimeGate(async () => { throw new Error("gate down") })
      expect((await r.execute({ agentId: "ops", message: "a", context: telegram })).content).toBe("done by 15:00Z")
      await tick()
      expect(logs.join("\n")).toContain("gate down")
    })
  })
})
