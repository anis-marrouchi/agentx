import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  DEFAULT_LEAN,
  DEFAULT_LEAN_CHANNELS,
  describeProfile,
  fullClaudeArgs,
  leanClaudeArgs,
  leanConfig,
  leanLoadsWorkspace,
  leanMcpServers,
  onDemandContextNote,
  resolveSessionProfile,
} from "../src/agents/session-profile"
import { daemonConfigSchema } from "../src/daemon/config"

const agentx = { type: "stdio" as const, command: "node", args: ["cli.js", "serve", "--stdio"] }

describe("resolveSessionProfile", () => {
  it("is lean for the automation channels and full for chat channels by default", () => {
    for (const ch of DEFAULT_LEAN_CHANNELS) expect(resolveSessionProfile(undefined, ch, "claude-code")).toBe("lean")
    for (const ch of ["telegram", "whatsapp", "voice", "dashboard", "desktop", "api", "exec"]) {
      expect(resolveSessionProfile(undefined, ch, "claude-code")).toBe("full")
    }
  })

  it("lets the config override one channel without losing the other defaults", () => {
    const cfg = { profileByChannel: { github: "full" as const, telegram: "lean" as const } }
    expect(resolveSessionProfile(cfg, "github", "claude-code")).toBe("full")
    expect(resolveSessionProfile(cfg, "telegram", "claude-code")).toBe("lean")
    expect(resolveSessionProfile(cfg, "a2a", "claude-code")).toBe("lean")
    expect(resolveSessionProfile(cfg, "whatsapp", "claude-code")).toBe("full")
  })

  it("is always full for tiers without the agentx MCP tools", () => {
    for (const tier of ["sdk", "orchestrator", "opencode"]) {
      expect(resolveSessionProfile({ profileByChannel: { github: "lean" } }, "github", tier)).toBe("full")
    }
    expect(resolveSessionProfile(undefined, "github", "codex-cli")).toBe("lean")
  })

  it("reads the parsed daemon config as is", () => {
    const parsed = daemonConfigSchema.parse({ node: { id: "n", name: "N" }, session: { profileByChannel: { cron: "full" } } })
    expect(resolveSessionProfile(parsed.session, "cron", "claude-code")).toBe("full")
    expect(resolveSessionProfile(parsed.session, "github", "claude-code")).toBe("lean")
    expect(leanConfig(parsed.session)).toEqual(DEFAULT_LEAN)
  })
})

describe("leanMcpServers / leanClaudeArgs", () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "lean-ws-")) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it("keeps only the named servers from the workspace .mcp.json and always adds agentx", () => {
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
      _agentxManaged: true,
      mcpServers: { codegraph: { command: "codegraph" }, canva: { type: "http", url: "https://example.com/mcp" } },
    }))
    expect(leanMcpServers(ws, DEFAULT_LEAN, agentx)).toEqual({ agentx })
    expect(leanMcpServers(ws, { ...DEFAULT_LEAN, mcpServers: ["agentx", "codegraph"] }, agentx))
      .toEqual({ codegraph: { command: "codegraph" }, agentx })
    // Dropping agentx from the list does not drop the tool server.
    expect(Object.keys(leanMcpServers(ws, { ...DEFAULT_LEAN, mcpServers: ["codegraph"] }, agentx))).toEqual(["codegraph", "agentx"])
  })

  it("prefers the workspace's own agentx entry when the operator declared one", () => {
    const own = { command: "/opt/agentx/bin/agentx", args: ["serve", "--stdio"] }
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { agentx: own } }))
    expect(leanMcpServers(ws, DEFAULT_LEAN, agentx)).toEqual({ agentx: own })
  })

  it("copes with a missing or broken .mcp.json", () => {
    expect(leanMcpServers(ws, DEFAULT_LEAN, agentx)).toEqual({ agentx })
    writeFileSync(join(ws, ".mcp.json"), "{ not json")
    expect(leanMcpServers(ws, DEFAULT_LEAN, agentx)).toEqual({ agentx })
    mkdirSync(join(ws, "sub"))
    expect(leanMcpServers(join(ws, "sub"), DEFAULT_LEAN, agentx)).toEqual({ agentx })
  })

  it("produces the strict MCP config and the setting sources", () => {
    const args = leanClaudeArgs(ws, DEFAULT_LEAN, agentx)
    expect(args).toContain("--strict-mcp-config")
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: { agentx } })
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local")
    expect(leanClaudeArgs(ws, { ...DEFAULT_LEAN, settingSources: [] }, agentx)).toContain("")
    expect(leanClaudeArgs(ws, { ...DEFAULT_LEAN, settingSources: ["project"] }, agentx)).toContain("project")
  })

  // Full sessions add the agentx tool server to what they load anyway, so
  // agentx_approval is there on a node with no user-level servers (#668).
  it("full sessions get the agentx server on top of the rest, never instead of it", () => {
    const args = fullClaudeArgs(ws, agentx)
    expect(args).toEqual(["--mcp-config", JSON.stringify({ mcpServers: { agentx } })])
    expect(args).not.toContain("--strict-mcp-config")
    expect(args).not.toContain("--setting-sources")
    // The operator's own agentx entry wins here as in lean sessions; the
    // workspace's other servers are left to Claude Code to load.
    const own = { command: "/opt/agentx/bin/agentx", args: ["serve", "--stdio"] }
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { agentx: own, codegraph: { command: "codegraph" } } }))
    expect(JSON.parse(fullClaudeArgs(ws, agentx)[1])).toEqual({ mcpServers: { agentx: own } })
    writeFileSync(join(ws, ".mcp.json"), "{ not json")
    expect(JSON.parse(fullClaudeArgs(ws, agentx)[1])).toEqual({ mcpServers: { agentx } })
  })

  it("knows when Claude Code reads the workspace itself", () => {
    expect(leanLoadsWorkspace(DEFAULT_LEAN)).toBe(true)
    expect(leanLoadsWorkspace({ ...DEFAULT_LEAN, settingSources: ["local"] })).toBe(false)
    expect(leanLoadsWorkspace({ ...DEFAULT_LEAN, settingSources: [] })).toBe(false)
  })
})

describe("onDemandContextNote / describeProfile", () => {
  it("names the tool for each piece of context and the chat it belongs to", () => {
    const note = onDemandContextNote("github", "acme/widgets:issue:12")
    expect(note.startsWith("[Context on demand]")).toBe(true)
    expect(note).toContain("agentx_agents")
    expect(note).toContain("agentx_recent")
    expect(note).toContain("agentx_wiki_query")
    expect(note).toContain('channel="github"')
    expect(note).toContain('chatId="acme/widgets:issue:12"')
    expect(note.split("\n")).toHaveLength(2)
  })

  it("describes what a lean start keeps, for the log", () => {
    expect(describeProfile("full", DEFAULT_LEAN)).toBe("full")
    expect(describeProfile("lean", DEFAULT_LEAN)).toBe("lean (mcp=agentx settings=project,local context=on-demand)")
    expect(describeProfile("lean", { ...DEFAULT_LEAN, contextOnDemand: false })).toContain("context=pushed")
  })
})
