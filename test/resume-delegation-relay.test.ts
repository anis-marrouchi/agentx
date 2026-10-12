import { describe, it, expect } from "vitest"
import { serializeOrigin, type RunOrigin } from "../src/agents/resume/origin"
import { planResume, DEFAULT_RESUME_SETTINGS } from "../src/agents/resume/policy"
import { DELEGATION_RESULT_MARKER, isDelegationRelay } from "../src/a2a/delegation"
import type { InterruptedRun } from "../src/storage/traces"

// A delegation result's relay turn stopped by a restart is re-run by the
// delegation manager (#846). The resume step leaves it alone, and leaves
// every other cut-off run to its usual rules.

const chat: RunOrigin = { kind: "direct", context: { channel: "telegram", chatId: "chat-1", sender: "agent:worker" } }
const run = (over: Partial<InterruptedRun> = {}): InterruptedRun => ({
  taskId: "t1", agentId: "front", channel: "telegram", chatId: "chat-1", workflowRunId: null,
  startedAt: Date.now() - 60_000, originalMessage: "What is on my calendar?", resumeOrigin: serializeOrigin(chat), resumeAttempt: 0, toolCalls: [], ...over,
})
const handledElsewhere = (r: InterruptedRun) => (isDelegationRelay(r.originalMessage) ? "delegation result relay" : null)
const plan = (r: InterruptedRun) =>
  planResume([r], { ...DEFAULT_RESUME_SETTINGS, directChannels: ["telegram"] }, { now: Date.now(), boots: [Date.now()], handledElsewhere })[0]

describe("resume and delegation relays", () => {
  it("skips a relay turn: the delegation manager re-runs it", () => {
    const p = plan(run({ originalMessage: `${DELEGATION_RESULT_MARKER} task=dlg-1 from=worker status=done]\nEarlier…` }))
    expect(p).toMatchObject({ action: "skip", reason: "delegation result relay" })
  })

  it("does not treat a normal turn stopped by a restart as a relay", () => {
    expect(plan(run()).action).toBe("resume")
  })
})
