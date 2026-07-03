import { describe, expect, it } from "vitest"
import { groupIntoConversations, type ActivityEpisode } from "../src/procedures/mine/load"
import { clusterKey } from "../src/procedures/mine/cluster"

const MIN = 60_000

function turn(over: Partial<ActivityEpisode>): ActivityEpisode {
  return {
    taskId: over.taskId ?? "t0",
    agentId: "coo-agent",
    channel: "telegram",
    chatId: "12345",
    startedAt: 0,
    userMessage: "",
    userTurns: [],
    actions: [],
    actionSummaries: [],
    ...over,
  }
}

describe("groupIntoConversations", () => {
  it("merges turns within the gap into one episode keyed by the first turn", () => {
    const turns = [
      turn({ taskId: "t1", startedAt: 0, userMessage: "We need to download the attachment and transcribe it", actions: ["Bash"] }),
      turn({ taskId: "t2", startedAt: 5 * MIN, userMessage: "go ahead", actions: ["Bash", "Read"] }),
      turn({ taskId: "t3", startedAt: 12 * MIN, userMessage: "did you receive it", actions: ["mcp__gitlab__create_issue"] }),
    ]
    const convos = groupIntoConversations(turns)
    expect(convos).toHaveLength(1)
    expect(convos[0].taskId).toBe("t1")
    expect(convos[0].userMessage).toContain("download the attachment")
    expect(convos[0].actions).toEqual(["Bash", "Bash", "Read", "mcp__gitlab__create_issue"])
    expect(convos[0].userTurns).toEqual(["go ahead", "did you receive it"])
  })

  it("splits on gaps larger than the conversation window", () => {
    const turns = [
      turn({ taskId: "t1", startedAt: 0, userMessage: "Check the weekly requests recorded on gitlab please" }),
      turn({ taskId: "t2", startedAt: 3 * 60 * MIN, userMessage: "Check the weekly requests recorded on gitlab please" }),
    ]
    const convos = groupIntoConversations(turns)
    expect(convos).toHaveLength(2)
    expect(convos.map((c) => c.taskId)).toEqual(["t1", "t2"])
  })

  it("keeps different chats separate even when interleaved in time", () => {
    const turns = [
      turn({ taskId: "t1", chatId: "alice", startedAt: 0, userMessage: "Prepare the monthly report for the lab" }),
      turn({ taskId: "t2", chatId: "bob", startedAt: 1 * MIN, userMessage: "Book the flight to Tunis for next week" }),
      turn({ taskId: "t3", chatId: "alice", startedAt: 2 * MIN, userMessage: "add the totals" }),
    ]
    const convos = groupIntoConversations(turns)
    expect(convos).toHaveLength(2)
    const alice = convos.find((c) => c.chatId === "alice")
    expect(alice?.userTurns).toEqual(["add the totals"])
  })

  it("promotes the first substantive turn to opener when the chat starts with a pleasantry", () => {
    const turns = [
      turn({ taskId: "t1", startedAt: 0, userMessage: "hey" }),
      turn({ taskId: "t2", startedAt: 1 * MIN, userMessage: "Process the Zitouna bank notification and send the invoice back" }),
    ]
    const convos = groupIntoConversations(turns)
    expect(convos).toHaveLength(1)
    expect(convos[0].taskId).toBe("t1")
    expect(convos[0].userMessage).toContain("Zitouna")
  })

  it("recurring conversations cluster together across weeks", () => {
    const week = 7 * 24 * 60 * 60 * 1000
    const mkWeek = (i: number, prefix: string) => [
      turn({ taskId: `${prefix}-open-${i}`, startedAt: i * week, userMessage: "Process the Zitouna bank notification for June and reply with the invoice", actions: ["mcp__gog__gmail_read"] }),
      turn({ taskId: `${prefix}-mid-${i}`, startedAt: i * week + 4 * MIN, userMessage: "go ahead", actions: ["Bash", "Write"] }),
      turn({ taskId: `${prefix}-end-${i}`, startedAt: i * week + 9 * MIN, userMessage: "send it", actions: ["mcp__gog__gmail_send"] }),
    ]
    const convos = groupIntoConversations([...mkWeek(0, "a"), ...mkWeek(1, "b"), ...mkWeek(2, "c")])
    expect(convos).toHaveLength(3)
    const keys = new Set(convos.map(clusterKey))
    expect(keys.size).toBe(1)
  })
})
