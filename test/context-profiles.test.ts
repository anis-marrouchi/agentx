import { describe, expect, it } from "vitest"
import { leanFlags, loadsWorkspace, measure, splitSections } from "../bench/context-size"
import { compareRows, renderTable } from "../bench/context-profiles"

// The measurement behind #615: what a fresh session on an automation
// channel is handed, full profile against lean, section by section.

describe("context-size section helpers", () => {
  it("splits on layer headers and keeps the landscape's sub-blocks together", () => {
    const text = [
      "Channel: a2a", "", "[Landscape]", "Node: n", "", "[Rules]", "- one", "", "[Cross-Channel Messaging]", "curl …",
      "", "[Intent: bugfix, testing]", "", "[Conversation history for today (2026-10-04)]", "User: hi", "[End of history — respond]",
      "", "[Cross-chat context — recent activity]", "From c2", "[End cross-chat context — note]",
    ].join("\n")
    const names = splitSections(text, "channel and scope").map(([n]) => n)
    expect(names).toEqual(["channel and scope", "landscape", "intent", "conversation history for today", "cross-chat context"])
    const landscape = splitSections(text, "lead").find(([n]) => n === "landscape")![1]
    expect(landscape).toContain("[Rules]")
    expect(landscape).toContain("[Cross-Channel Messaging]")
  })

  it("drops empty parts and names the lead", () => {
    expect(splitSections("", "lead")).toEqual([])
    expect(splitSections("[Memory]\nfact", "lead")).toEqual([["memory", "[Memory]\nfact"]])
  })

  it("reads the lean flags off a claude command line", () => {
    const argv = ["-p", "x", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{"agentx":{},"codegraph":{}}}', "--setting-sources", "project,local"]
    expect(leanFlags(argv)).toEqual(["strict mcp config: agentx,codegraph", "setting sources: project,local"])
    expect(leanFlags(["-p", "x"])).toEqual([])
    expect(leanFlags(["--setting-sources", ""])).toEqual(["setting sources: none"])
  })

  it("knows when Claude Code still reads the workspace files", () => {
    expect(loadsWorkspace(["-p", "x"])).toBe(true)
    expect(loadsWorkspace(["--setting-sources", "project,local"])).toBe(true)
    expect(loadsWorkspace(["--setting-sources", "local"])).toBe(false)
    expect(loadsWorkspace(["--setting-sources", ""])).toBe(false)
  })

  it("renders a before/after table with the saving per section", () => {
    const section = (name: string, text: string) => ({ name, text, tokens: Math.ceil(text.length / 4), exact: false })
    const full = { exact: false, total: 30, flags: [], unmeasured: [], sections: [section("prompt: landscape", "x".repeat(80)), section("workspace CLAUDE.md", "y".repeat(40))] }
    const lean = { exact: false, total: 15, flags: ["strict mcp config: agentx"], unmeasured: [], sections: [section("workspace CLAUDE.md", "y".repeat(40)), section("prompt: context on demand", "z".repeat(20))] }
    const rows = compareRows(full, lean)
    expect(rows.map((r) => [r.section, r.full, r.lean])).toEqual([
      ["prompt: landscape", 20, 0], ["workspace CLAUDE.md", 10, 10], ["prompt: context on demand", 0, 5],
    ])
    const table = renderTable([{ channel: "github", rows, fullTotal: 30, leanTotal: 15, fullFlags: [], leanFlags: lean.flags }], false)
    expect(table).toContain("| github | prompt: landscape | ≈20 / 80 | ≈0 / 0 | 100% |")
    expect(table).toContain("**≈30** | **≈15** | **50%**")
    expect(table).toContain("| github | claude flags | none | strict mcp config: agentx |")
  })
})

describe("context profiles end to end", () => {
  it("a lean github session is handed less than half the prompt a full one gets, with the rest a tool call away", async () => {
    const task = "Continuing from what @helper_bot mentioned earlier: fix the failing test."
    const full = await measure({ task, channel: "github", profile: "full", sections: true, warmTurns: 1 })
    const lean = await measure({ task, channel: "github", profile: "lean", sections: true, warmTurns: 1 })
    const names = (m: typeof full) => m.sections.map((s) => s.name)
    const promptTokens = (m: typeof full) => m.sections.filter((s) => s.name.startsWith("prompt:") || s.name.startsWith("preamble:")).reduce((n, s) => n + s.tokens, 0)

    // Full: history and cross-chat pushed, the project CLAUDE.md twice.
    expect(names(full)).toContain("prompt: conversation history for today")
    expect(names(full)).toContain("prompt: cross-chat context")
    expect(names(full)).toContain("preamble: project claude.md")
    expect(names(full)).toContain("workspace CLAUDE.md")
    expect(full.flags).toEqual([])

    // Lean: none of those, one line instead, CLAUDE.md loaded once by Claude Code.
    expect(names(lean)).not.toContain("prompt: conversation history for today")
    expect(names(lean)).not.toContain("prompt: cross-chat context")
    expect(names(lean)).not.toContain("prompt: landscape")
    expect(names(lean)).not.toContain("preamble: project claude.md")
    expect(names(lean)).toContain("prompt: context on demand")
    expect(names(lean)).toContain("workspace CLAUDE.md")
    expect(lean.flags).toEqual(["strict mcp config: agentx", "setting sources: project,local"])

    expect(promptTokens(lean)).toBeLessThan(promptTokens(full) / 2)
    expect(lean.total).toBeLessThan(full.total)
  }, 120_000)

  it("a chat channel is unchanged by the lean profile's defaults", async () => {
    const task = "Continuing from what @helper_bot mentioned earlier: fix the failing test."
    const telegram = await measure({ task, channel: "telegram", sections: true, warmTurns: 1 })
    expect(telegram.flags).toEqual([])
    expect(telegram.sections.map((s) => s.name)).toContain("prompt: conversation history for today")
    expect(telegram.sections.map((s) => s.name)).not.toContain("prompt: context on demand")
  }, 60_000)
})
