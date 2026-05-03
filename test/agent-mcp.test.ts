import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { syncMcpToWorkspace, type McpServerMap } from "../src/agents/agent-mcp"

const ROOT = resolve(__dirname, "../.test-agent-mcp")

describe("syncMcpToWorkspace", () => {
  let ws: string

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    ws = resolve(ROOT, "workspace-a")
    mkdirSync(ws, { recursive: true })
  })
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

  const cfg: McpServerMap = {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  }

  it("noop when no config and no file", () => {
    expect(syncMcpToWorkspace(ws, {})).toBe("noop")
    expect(existsSync(resolve(ws, ".mcp.json"))).toBe(false)
  })

  it("installs a fresh .mcp.json with the marker + standard mcpServers shape", () => {
    expect(syncMcpToWorkspace(ws, cfg)).toBe("installed")
    const written = JSON.parse(readFileSync(resolve(ws, ".mcp.json"), "utf-8"))
    expect(written._agentxManaged).toBe(true)
    expect(written.mcpServers.github.command).toBe("npx")
    expect(written.mcpServers.github.args).toEqual(["-y", "@modelcontextprotocol/server-github"])
  })

  it("updates an agentx-managed file in place", () => {
    syncMcpToWorkspace(ws, cfg)
    const updated: McpServerMap = {
      github: cfg.github,
      gitlab: { command: "uvx", args: ["mcp-server-gitlab"], env: { GITLAB_TOKEN: "t" } },
    }
    expect(syncMcpToWorkspace(ws, updated)).toBe("updated")
    const written = JSON.parse(readFileSync(resolve(ws, ".mcp.json"), "utf-8"))
    expect(Object.keys(written.mcpServers).sort()).toEqual(["github", "gitlab"])
    expect(written.mcpServers.gitlab.env.GITLAB_TOKEN).toBe("t")
  })

  it("removes a managed file when the config is emptied", () => {
    syncMcpToWorkspace(ws, cfg)
    expect(existsSync(resolve(ws, ".mcp.json"))).toBe(true)
    expect(syncMcpToWorkspace(ws, {})).toBe("removed")
    expect(existsSync(resolve(ws, ".mcp.json"))).toBe(false)
  })

  it("skips operator-owned files (no marker) regardless of config", () => {
    const operatorMcp = { mcpServers: { custom: { command: "operator" } } }
    writeFileSync(resolve(ws, ".mcp.json"), JSON.stringify(operatorMcp))

    expect(syncMcpToWorkspace(ws, cfg)).toBe("skipped-operator-owned")
    const after = JSON.parse(readFileSync(resolve(ws, ".mcp.json"), "utf-8"))
    expect(after.mcpServers.custom.command).toBe("operator")
    expect(after._agentxManaged).toBeUndefined()
  })

  it("treats marker:false as operator-owned (operator opted out by setting it false)", () => {
    writeFileSync(resolve(ws, ".mcp.json"), JSON.stringify({ _agentxManaged: false, mcpServers: {} }))
    expect(syncMcpToWorkspace(ws, cfg)).toBe("skipped-operator-owned")
  })

  it("treats malformed JSON as operator-owned (don't clobber a half-saved edit)", () => {
    writeFileSync(resolve(ws, ".mcp.json"), "{ not valid json")
    expect(syncMcpToWorkspace(ws, cfg)).toBe("skipped-operator-owned")
    expect(readFileSync(resolve(ws, ".mcp.json"), "utf-8")).toBe("{ not valid json")
  })

  it("emitted JSON has trailing newline (Unix-friendly)", () => {
    syncMcpToWorkspace(ws, cfg)
    const raw = readFileSync(resolve(ws, ".mcp.json"), "utf-8")
    expect(raw.endsWith("\n")).toBe(true)
  })
})
