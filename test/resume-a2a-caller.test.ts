import { describe, it, expect } from "vitest"
import { callerAgentOf, serializeOrigin, RESUME_DELIVERY_FLAG, type RunOrigin } from "../src/agents/resume/origin"
import { planResume, DEFAULT_RESUME_SETTINGS } from "../src/agents/resume/policy"
import { resumedAnswerText } from "../src/agents/resume/note"
import type { InterruptedRun } from "../src/storage/traces"

// An agent-to-agent run used to be reported after a restart ("nothing would
// deliver its answer"), so delegated work was lost. When the run's context
// names the agent that asked, the answer can go to that agent as a turn.

const a2a: RunOrigin = { kind: "direct", context: { channel: "a2a", sender: "agent:secretary-agent", chatId: "secretary-agent" } }
const run = (over: Partial<InterruptedRun> = {}): InterruptedRun => ({
  taskId: "t1", agentId: "coder-agent", channel: "a2a", chatId: "secretary-agent", workflowRunId: null,
  startedAt: Date.now() - 60_000, originalMessage: "review MR 5", resumeOrigin: serializeOrigin(a2a), resumeAttempt: 0, toolCalls: [], ...over,
})
const plan = (r: InterruptedRun) => planResume([r], DEFAULT_RESUME_SETTINGS, { now: Date.now(), boots: [Date.now()] })[0]

describe("callerAgentOf", () => {
  it("names the calling agent of a direct agent-to-agent run", () => {
    expect(callerAgentOf(a2a)).toBe("secretary-agent")
  })
  it("is null for other senders, other channels, mesh runs and delivery turns", () => {
    expect(callerAgentOf({ kind: "direct", context: { channel: "a2a", sender: "bench" } })).toBeNull()
    expect(callerAgentOf({ kind: "direct", context: { channel: "voice", sender: "agent:x" } })).toBeNull()
    expect(callerAgentOf({ kind: "mesh", channel: "a2a", chatId: "x" })).toBeNull()
    expect(callerAgentOf({ kind: "direct", context: { ...a2a.context, [RESUME_DELIVERY_FLAG]: true } })).toBeNull()
    expect(callerAgentOf(null)).toBeNull()
  })
})

describe("planResume for agent-to-agent runs", () => {
  it("resumes a run that names its caller, with the caller as the delivery target", () => {
    expect(plan(run())).toMatchObject({ action: "resume", reason: expect.stringContaining("secretary-agent") })
  })
  it("still reports one with no caller, and a delivery turn, and an api run", () => {
    const anon = serializeOrigin({ kind: "direct", context: { channel: "a2a", sender: "curl" } })
    expect(plan(run({ resumeOrigin: anon }))).toMatchObject({ action: "report" })
    const delivery = serializeOrigin({ kind: "direct", context: { ...a2a.context, [RESUME_DELIVERY_FLAG]: true } })
    expect(plan(run({ resumeOrigin: delivery }))).toMatchObject({ action: "report" })
    const api = serializeOrigin({ kind: "direct", context: { channel: "api", sender: "agent:x" } })
    expect(plan(run({ channel: "api", resumeOrigin: api }))).toMatchObject({ action: "report" })
  })
  it("the other rules still come first", () => {
    expect(plan(run({ startedAt: Date.now() - 3600_000 }))).toMatchObject({ action: "report", reason: expect.stringContaining("min ago") })
    expect(plan(run({ resumeAttempt: 1 }))).toMatchObject({ action: "report" })
  })
})

describe("resumedAnswerText", () => {
  it("tells the caller what was asked and what came back, bounded", () => {
    const t = resumedAnswerText(run(), { content: "x".repeat(20) }, 10)
    expect(t).toMatch(/cut off by a daemon restart and has been run again/)
    expect(t).toMatch(/The request was: review MR 5/)
    expect(t).toMatch(/xxxxxxxxxx\n\[answer cut at 10 characters\]/)
  })
  it("reports a failed re-run as such", () => {
    expect(resumedAnswerText(run(), { error: "boom" })).toMatch(/failed this time: boom/)
  })
})
