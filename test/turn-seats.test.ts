import { describe, it, expect, vi, beforeEach } from "vitest"

const hoisted = vi.hoisted(() => ({
  askSeat: vi.fn(),
  getSeatMode: vi.fn(() => "shadow"),
  label: vi.fn(),
}))
vi.mock("../src/decisions/seat", () => ({
  askSeat: hoisted.askSeat,
  getSeatMode: hoisted.getSeatMode,
  decisionsRuntime: () => ({ store: { label: hoisted.label } }),
}))

import { endsWithQuestion, isBareApproval } from "../src/decisions/seats/turn-handoff"
import { onAgentReply, onUserMessage, resetTurnSeatsForTesting, startTurnWatch } from "../src/agents/turn-seats"

const flush = () => new Promise(r => setTimeout(r, 0))
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id: string, content: string, is_error = false) =>
  ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } })

beforeEach(() => {
  hoisted.askSeat.mockReset().mockResolvedValue({ answers: {}, callId: "call-1", mode: "shadow" })
  hoisted.getSeatMode.mockReset().mockReturnValue("shadow")
  hoisted.label.mockReset()
  resetTurnSeatsForTesting()
})

describe("handoff detectors", () => {
  it("recognises replies that hand the turn back with a question", () => {
    expect(endsWithQuestion("Next I can write the tour lessons, then run one end to end. Should I go ahead?")).toBe(true)
    expect(endsWithQuestion("Want me to split the invoice line into those three so the client sees the breakdown")).toBe(true)
    expect(endsWithQuestion("All five replies are live.")).toBe(false)
  })

  it("treats only short, plain approvals as approvals", () => {
    expect(isBareApproval("yes go ahead but check first if any ongoing work")).toBe(true)
    expect(isBareApproval("ok do it")).toBe(true)
    expect(isBareApproval("I think there is a confusion here, your task is the teach redesign")).toBe(false)
    expect(isBareApproval(`yes ${"x".repeat(200)}`)).toBe(false)
  })
})

describe("turn-progress watch", () => {
  it("asks immediately when one tool call repeats three times, once per call", () => {
    const watch = startTurnWatch({ agent: "coder", request: "run the tour", taskId: "t1", budgetMinutes: 60, checkpointMs: 60_000 })
    for (const id of ["a", "b", "c", "d"]) {
      watch.observe(toolUse(id, "Bash", { command: "node cli.js teach tour" }))
      watch.observe(toolResult(id, "setup stopped: 59% sure", true))
    }
    watch.stop()
    expect(hoisted.askSeat).toHaveBeenCalledTimes(1)
    const [seat, state, , opts] = hoisted.askSeat.mock.calls[0]
    expect(seat).toBe("turn-progress")
    expect(state.trigger).toBe("repetition")
    expect(state.mostRepeatedCall.times).toBe(3)
    expect(state.recentSteps[1]).toMatchObject({ tool: "Bash", result: "setup stopped: 59% sure", failed: true })
    expect(opts.links).toEqual([{ kind: "task", id: "t1" }])
  })

  it("checkpoints only when new steps arrived since the last ask", async () => {
    vi.useFakeTimers()
    try {
      const watch = startTurnWatch({ agent: "coder", request: "r", taskId: "t2", budgetMinutes: 60, checkpointMs: 1000 })
      watch.observe(toolUse("a", "Read", { file_path: "x.ts" }))
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
      expect(hoisted.askSeat).toHaveBeenCalledTimes(1)
      expect(hoisted.askSeat.mock.calls[0][1].trigger).toBe("checkpoint")
      watch.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does nothing when the seat is off", () => {
    hoisted.getSeatMode.mockReturnValue("off")
    const watch = startTurnWatch({ agent: "coder", request: "r", taskId: "t3", budgetMinutes: 60 })
    for (const id of ["a", "b", "c"]) watch.observe(toolUse(id, "Bash", { command: "ls" }))
    watch.stop()
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })
})

describe("handoff seats", () => {
  const convo = { agent: "coder", channel: "opencode", chatId: "ses_1" }

  it("asks turn-handoff on a question ending and labels it from the user's next message", async () => {
    onAgentReply({ ...convo, request: "write the lessons", reply: "The lessons are drafted. Should I run them end to end?", taskId: "t1" })
    await flush()
    expect(hoisted.askSeat.mock.calls[0][0]).toBe("turn-handoff")

    onUserMessage({ ...convo, message: "yes go ahead", previousReply: "The lessons are drafted. Should I run them end to end?", taskId: "t2" })
    expect(hoisted.label).toHaveBeenCalledWith("call-1", "userReply", "approved", expect.objectContaining({ kind: "outcome" }))
    expect(hoisted.askSeat.mock.calls[1][0]).toBe("approval-binding")
    expect(hoisted.askSeat.mock.calls[1][1]).toMatchObject({ userMessage: "yes go ahead" })
  })

  it("labels a redirect and skips approval-binding for a long message", async () => {
    onAgentReply({ ...convo, request: "r", reply: "Which task should I pick up?", taskId: "t1" })
    await flush()
    const long = `No, your task is the teach redesign. ${"Details. ".repeat(30)}`
    onUserMessage({ ...convo, message: long, previousReply: "Which task should I pick up?", taskId: "t2" })
    expect(hoisted.label).toHaveBeenCalledWith("call-1", "userReply", "redirected", expect.anything())
    expect(hoisted.askSeat).toHaveBeenCalledTimes(1)
  })

  it("ignores statements and automated channels", async () => {
    onAgentReply({ ...convo, request: "r", reply: "Done, all tests pass.", taskId: "t1" })
    onAgentReply({ ...convo, channel: "cron", request: "r", reply: "Should I retry?", taskId: "t2" })
    onUserMessage({ ...convo, channel: "cron", message: "ok", previousReply: "Should I retry?", taskId: "t3" })
    await flush()
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })
})
