import { describe, expect, it } from "vitest"
import { codingInstructions, EDIT_TOOL_INSTRUCTION } from "../src/agents/registry"

// #455: Claude Code agents are told to edit with the Edit tool; a
// multi-line sed that misses cost a third of bug-fix runs extra calls.
describe("coding instructions", () => {
  it("gives Claude Code the code-first principle and the edit rule", () => {
    const text = codingInstructions("claude-code")
    expect(text).toContain("[Operating principle]")
    expect(text).toContain(EDIT_TOOL_INSTRUCTION)
  })

  it("gives Codex the principle without the edit rule, and other tiers nothing", () => {
    expect(codingInstructions("codex-cli")).toContain("[Operating principle]")
    expect(codingInstructions("codex-cli")).not.toContain("Edit tool")
    expect(codingInstructions("opencode")).toBe("")
  })
})
