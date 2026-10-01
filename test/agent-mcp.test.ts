import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { agentxToolServer, syncMcpToWorkspace, withAgentXToolServer, type McpServerMap } from "../src/agents/agent-mcp"

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

describe("this install's own tool server (#400)", () => {
  it("runs the CLI file the daemon runs from, pointed at the install folder", () => {
    const stanza = agentxToolServer({ execPath: "/opt/node/bin/node", argv: ["/opt/node/bin/node", "/srv/agentx/dist/cli.js", "daemon", "start"], cwd: () => "/srv/install" })
    expect(stanza).toEqual({ type: "stdio", command: "/opt/node/bin/node", args: ["/srv/agentx/dist/cli.js", "serve", "--stdio", "--cwd", "/srv/install"] })
  })

  it("falls back to the agentx command when the daemon was not started from a CLI file", () => {
    const stanza = agentxToolServer({ execPath: "/opt/node/bin/node", argv: ["agentx"], cwd: () => "/srv/install" })
    expect(stanza).toEqual({ type: "stdio", command: "agentx", args: ["serve", "--stdio", "--cwd", "/srv/install"] })
  })

  it("is added as agentx unless the operator declared one, or none is wanted", () => {
    const server = agentxToolServer({ execPath: "node", argv: ["node", "/x/cli.js"], cwd: () => "/x" })
    const own: McpServerMap = { agentx: { command: "mine" } }
    expect(withAgentXToolServer({}, server)).toEqual({ agentx: server })
    expect(withAgentXToolServer({ github: { command: "gh" } }, server)).toEqual({ github: { command: "gh" }, agentx: server })
    expect(withAgentXToolServer(own, server)).toBe(own)
    expect(withAgentXToolServer({ github: { command: "gh" } }, null)).toEqual({ github: { command: "gh" } })
  })
})
