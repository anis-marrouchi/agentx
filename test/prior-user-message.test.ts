import { describe, it, expect } from "vitest"
import { priorUserMessage, type SessionMessage } from "../src/agents/sessions"

// Regression cover for a silent failure of the session-continuity seat.
//
// The seat asks Jev whether a new request continues the previous one. It
// read the previous one as "the last user message in the session" — but
// executeInternal appends the incoming request BEFORE the seat runs, so
// that read returned the request itself. Jev was asked whether a request
// continues itself, answered ~0.95 yes on every call, and shouldRotateEarly
// (which needs both nouls ≤ 0.2) could never fire.
//
// Nothing threw, nothing logged, and the seat reported healthy: the only
// visible symptom was a rotation that never happened. These tests pin the
// message-selection rule so it cannot regress back to the tail read.

const user = (content: string): SessionMessage => ({
  role: "user",
  name: "someone",
  content,
  timestamp: new Date().toISOString(),
})
const agent = (content: string): SessionMessage => ({
  role: "agent",
  name: "an-agent",
  content,
  timestamp: new Date().toISOString(),
})

describe("priorUserMessage", () => {
  it("skips the current turn's own message", () => {
    const messages = [user("what is a bloom filter?"), agent("..."), user("and the cost?")]
    expect(priorUserMessage(messages, "and the cost?")).toBe("what is a bloom filter?")
  })

  it("is not the tail read — the bug that kept the seat shut", () => {
    const messages = [user("first"), agent("..."), user("second")]
    // The tail read would return "second", which is the request itself.
    expect(priorUserMessage(messages, "second")).not.toBe("second")
  })

  it("ignores agent messages between the two user turns", () => {
    const messages = [user("first"), agent("a"), agent("b"), user("second")]
    expect(priorUserMessage(messages, "second")).toBe("first")
  })

  it("returns the tail when it is not the current message", () => {
    // addUserMessage collapses consecutive exact duplicates, so on a
    // re-send nothing was appended and the tail already is the prior turn.
    const messages = [user("first"), agent("..."), user("second")]
    expect(priorUserMessage(messages, "third")).toBe("second")
  })

  it("returns null on the opening turn, when there is nothing to continue", () => {
    expect(priorUserMessage([user("only message")], "only message")).toBeNull()
    expect(priorUserMessage([], "anything")).toBeNull()
    expect(priorUserMessage(undefined, "anything")).toBeNull()
  })

  it("returns null when the session holds only agent messages", () => {
    expect(priorUserMessage([agent("a"), agent("b")], "new request")).toBeNull()
  })

  it("handles a repeated question asked again later", () => {
    // "why?" appears twice. The current turn is the second one, so the
    // prior user message is the turn in between, not the earlier "why?".
    const messages = [user("why?"), agent("because"), user("and then?"), agent("then this"), user("why?")]
    expect(priorUserMessage(messages, "why?")).toBe("and then?")
  })
})
