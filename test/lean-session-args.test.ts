import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { leanSessionArgs } from "../src/agents/claude-process-factory"

describe("leanSessionArgs", () => {
  it("keeps only the workspace's own MCP servers and project-level settings", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentx-lean-"))
    writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {} }))
    expect(leanSessionArgs(workspace)).toEqual([
      "--strict-mcp-config",
      "--mcp-config", join(workspace, ".mcp.json"),
      "--setting-sources", "project,local",
    ])
  })

  it("passes no MCP config when the workspace has none", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentx-lean-"))
    expect(leanSessionArgs(workspace)).toEqual(["--strict-mcp-config", "--setting-sources", "project,local"])
  })

  it("never restricts built-in tools", () => {
    expect(leanSessionArgs(tmpdir())).not.toContain("--tools")
  })
})
