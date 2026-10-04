import { describe, expect, it } from "vitest"
import { buildAgentContext, type ContextInput } from "../src/agents/context"
import { onDemandContextNote } from "../src/agents/session-profile"

// The lean profile (#615) swaps three pushed layers for one line.

const base: ContextInput = {
  channel: "github",
  chatId: "acme/widgets:issue:12",
  agentId: "coder",
  agentName: "Coder",
  sender: "octocat",
  message: "Please look at the failing build.",
}

describe("context on demand layer", () => {
  it("renders the note where the history would have been", () => {
    const out = buildAgentContext({ ...base, contextOnDemand: onDemandContextNote("github", "acme/widgets:issue:12") })
    expect(out).toContain("[Context on demand]")
    expect(out).toContain("agentx_recent")
    expect(out.indexOf("Channel: github")).toBeLessThan(out.indexOf("[Context on demand]"))
  })

  it("is absent when not asked for, so full sessions are unchanged", () => {
    const full = buildAgentContext({ ...base, sessionHistory: "[Conversation history for today (2026-10-04)]\nUser: hi\n[End of history]" })
    expect(full).not.toContain("[Context on demand]")
    expect(full).toContain("Conversation history")
  })

  it("stays short: one line never grows past its budget", () => {
    const out = buildAgentContext({ ...base, contextOnDemand: onDemandContextNote("a2a", "a2a:pm:coder") })
    const note = out.slice(out.indexOf("[Context on demand]"))
    expect(note.length).toBeLessThan(150 * 4)
    expect(note.endsWith("...")).toBe(false)
  })
})
