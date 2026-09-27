import { describe, expect, it } from "vitest"
import { markBody, ownEchoOf } from "../src/channels/outbound-marker"

describe("ownEchoOf", () => {
  it("treats an agent's own signed comment as an echo", () => {
    expect(ownEchoOf(markBody("Done.", "coder-agent"), "coder-agent")).toBe("coder-agent")
  })

  it("lets another agent's signed review through to the handler", () => {
    expect(ownEchoOf(markBody("Verdict: two changes needed.", "devops-agent"), "coder-agent")).toBeNull()
  })

  it("ignores unsigned comments", () => {
    expect(ownEchoOf("Please fix the typo.", "coder-agent")).toBeNull()
  })

  it("skips every signed comment when no handler is resolved", () => {
    expect(ownEchoOf(markBody("Hi", "devops-agent"), undefined)).toBe("devops-agent")
  })
})
