import { describe, it, expect } from "vitest"
import {
  tallyToolUses,
  firstMissingRequiredTool,
} from "../src/agents/registry"

describe("tallyToolUses", () => {
  it("counts tool_use blocks per tool name", () => {
    const c = new Map<string, number>()
    tallyToolUses(c, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Read", input: { file: "/x" } },
          { type: "tool_use", name: "Bash", input: { command: "pwd" } },
        ],
      },
    })
    expect(c.get("Bash")).toBe(2)
    expect(c.get("Read")).toBe(1)
    expect(c.has("Edit")).toBe(false)
  })

  it("ignores non-assistant events and missing message bodies", () => {
    const c = new Map<string, number>()
    tallyToolUses(c, { type: "system", subtype: "init" })
    tallyToolUses(c, { type: "result", subtype: "success" })
    tallyToolUses(c, { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })
    tallyToolUses(c, null)
    tallyToolUses(c, { type: "assistant" })
    tallyToolUses(c, { type: "assistant", message: {} })
    expect(c.size).toBe(0)
  })

  it("ignores tool_use blocks without a name", () => {
    const c = new Map<string, number>()
    tallyToolUses(c, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use" }, // no name
          { type: "tool_use", name: "" }, // empty name
          { type: "tool_use", name: "Bash" },
        ],
      },
    })
    expect(c.get("Bash")).toBe(1)
    expect(c.size).toBe(1)
  })

  it("accumulates across multiple assistant snapshots", () => {
    const c = new Map<string, number>()
    tallyToolUses(c, { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })
    tallyToolUses(c, { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })
    expect(c.get("Read")).toBe(2)
  })
})

describe("firstMissingRequiredTool", () => {
  it("returns null when no requirements set", () => {
    expect(firstMissingRequiredTool([], new Map())).toBeNull()
    expect(firstMissingRequiredTool(undefined, new Map())).toBeNull()
  })

  it("returns null when every required tool was invoked at least once", () => {
    const c = new Map([["Write", 1], ["Edit", 2], ["Bash", 5]])
    expect(firstMissingRequiredTool(["Write"], c)).toBeNull()
    expect(firstMissingRequiredTool(["Write", "Edit"], c)).toBeNull()
    expect(firstMissingRequiredTool(["Bash"], c)).toBeNull()
  })

  it("returns the first required tool that wasn't invoked", () => {
    expect(firstMissingRequiredTool(["Write"], new Map())).toBe("Write")
    expect(firstMissingRequiredTool(["Edit", "Write"], new Map([["Edit", 1]]))).toBe("Write")
    expect(firstMissingRequiredTool(["Write", "Edit"], new Map([["Edit", 1]]))).toBe("Write")
  })

  it("treats count=0 the same as not invoked at all", () => {
    expect(firstMissingRequiredTool(["Write"], new Map([["Write", 0]]))).toBe("Write")
  })
})
