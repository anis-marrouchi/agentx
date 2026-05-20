import { describe, it, expect } from "vitest"
import { effectiveMcpConfig, codegraphClaudeMdSection, CODEGRAPH_TOOLS } from "../src/agents/codegraph-bootstrap"
import type { AgentDef } from "../src/daemon/config"

const baseAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  name: "test",
  workspace: "/tmp/agentx-cg-test",
  tier: "claude-code",
  codegraph: false,
  ...overrides,
}) as AgentDef

describe("effectiveMcpConfig", () => {
  it("returns the operator-declared mcp unchanged when codegraph=false", () => {
    const def = baseAgent({ codegraph: false, mcp: { foo: { command: "foo", args: [] } } as any })
    const eff = effectiveMcpConfig(def)
    expect(Object.keys(eff)).toEqual(["foo"])
    expect(eff.codegraph).toBeUndefined()
  })

  it("returns empty when no mcp declared and codegraph=false", () => {
    const def = baseAgent({ codegraph: false })
    expect(Object.keys(effectiveMcpConfig(def))).toEqual([])
  })

  it("synthesizes the codegraph entry when codegraph=true", () => {
    const def = baseAgent({ codegraph: true })
    const eff = effectiveMcpConfig(def)
    expect(eff.codegraph).toEqual({ command: "codegraph", args: ["serve", "--mcp"] })
  })

  it("merges codegraph with operator-declared mcp entries (codegraph wins only when absent)", () => {
    const def = baseAgent({
      codegraph: true,
      mcp: { canva: { command: "canva-mcp", args: [] } } as any,
    })
    const eff = effectiveMcpConfig(def)
    expect(Object.keys(eff).sort()).toEqual(["canva", "codegraph"])
  })

  it("operator-declared codegraph entry wins over the synthesized one", () => {
    const customCmd = { command: "codegraph", args: ["serve", "--mcp", "--verbose"] }
    const def = baseAgent({
      codegraph: true,
      mcp: { codegraph: customCmd } as any,
    })
    const eff = effectiveMcpConfig(def)
    expect(eff.codegraph).toEqual(customCmd)
  })
})

describe("codegraphClaudeMdSection", () => {
  it("includes the tool table and the Explore-subagent rule", () => {
    const section = codegraphClaudeMdSection()
    expect(section).toContain("## CodeGraph")
    expect(section).toMatch(/Explore subagent/i)
    expect(section).toContain("codegraph_search")
    expect(section).toContain("codegraph_callers")
    expect(section).toContain("codegraph_impact")
  })
})

describe("CODEGRAPH_TOOLS", () => {
  it("covers the eight upstream MCP tools (no duplicates)", () => {
    expect(CODEGRAPH_TOOLS.length).toBe(8)
    expect(new Set(CODEGRAPH_TOOLS).size).toBe(8)
    for (const tool of CODEGRAPH_TOOLS) {
      expect(tool.startsWith("mcp__codegraph__codegraph_")).toBe(true)
    }
  })
})
