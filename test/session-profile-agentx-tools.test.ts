import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  AGENTX_MCP_TOOLS_ENV,
  DEFAULT_LEAN,
  describeProfile,
  leanAgentxTools,
  leanClaudeArgs,
  leanConfig,
  leanMcpServers,
} from "../src/agents/session-profile"
import { daemonConfigSchema } from "../src/daemon/config"
import { listedTools } from "../src/mcp"

// #696 — the agentx MCP server's tool descriptions are about 10k tokens of
// a lean first turn on Claude Code 2.1.291, the largest share once the
// built-in tool descriptions are deferred. A lean session may list fewer
// agentx tools. Off by default.

const agentx = { type: "stdio" as const, command: "node", args: ["cli.js", "serve", "--stdio"] }
const CORE = ["agentx_approval", "agentx_request"]
const ON_DEMAND = ["agentx_agents", "agentx_recent", "agentx_wiki_query"]

describe("leanAgentxTools", () => {
  it("is empty by default: every agentx tool", () => {
    expect(leanAgentxTools(DEFAULT_LEAN)).toEqual([])
    expect(leanAgentxTools(DEFAULT_LEAN, "github")).toEqual([])
  })

  it("keeps the prompted tools, and the on-demand ones while contextOnDemand is on", () => {
    const lean = { ...DEFAULT_LEAN, agentxTools: ["agentx_channel_reply"] }
    expect(leanAgentxTools(lean, "github")).toEqual([...CORE, ...ON_DEMAND, "agentx_channel_reply"])
    expect(leanAgentxTools({ ...lean, contextOnDemand: false }, "github")).toEqual([...CORE, "agentx_channel_reply"])
  })

  it("uses a channel's own list over the shared one, and the shared one when the channel's is empty", () => {
    const lean = {
      ...DEFAULT_LEAN,
      contextOnDemand: false,
      agentxTools: ["agentx_channel_reply"],
      agentxToolsByChannel: { a2a: ["agentx_send_agent"], cron: [] },
    }
    expect(leanAgentxTools(lean, "a2a")).toEqual([...CORE, "agentx_send_agent"])
    expect(leanAgentxTools(lean, "cron")).toEqual([...CORE, "agentx_channel_reply"])
  })

  it("trims and de-duplicates, and an all-blank list means every tool", () => {
    const lean = { ...DEFAULT_LEAN, contextOnDemand: false, agentxTools: [" agentx_request", "agentx_crons", "agentx_crons "] }
    expect(leanAgentxTools(lean)).toEqual([...CORE, "agentx_crons"])
    expect(leanAgentxTools({ ...DEFAULT_LEAN, agentxTools: [" ", ""] })).toEqual([])
  })
})

describe("lean MCP config with an agentx tool list", () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "lean-agentx-tools-")) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it("leaves the agentx server untouched without a list", () => {
    const args = leanClaudeArgs(ws, DEFAULT_LEAN, agentx, "github")
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: { agentx } })
  })

  it("passes the list to the agentx stdio server in its environment", () => {
    const lean = { ...DEFAULT_LEAN, contextOnDemand: false, agentxTools: ["agentx_channel_reply"] }
    const args = leanClaudeArgs(ws, lean, agentx, "github")
    const { mcpServers } = JSON.parse(args[args.indexOf("--mcp-config") + 1])
    expect(mcpServers.agentx).toEqual({ ...agentx, env: { [AGENTX_MCP_TOOLS_ENV]: "agentx_approval,agentx_request,agentx_channel_reply" } })
  })

  it("adds to the env of an agentx entry the workspace declares, and leaves an http one as written", () => {
    const own = { command: "agentx", args: ["serve", "--stdio"], env: { AGENTX_DAEMON_URL: "http://127.0.0.1:1" } }
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { agentx: own } }))
    const lean = { ...DEFAULT_LEAN, contextOnDemand: false, agentxTools: ["agentx_crons"] }
    expect(leanMcpServers(ws, lean, agentx, "cron").agentx).toEqual({
      ...own,
      env: { AGENTX_DAEMON_URL: "http://127.0.0.1:1", [AGENTX_MCP_TOOLS_ENV]: "agentx_approval,agentx_request,agentx_crons" },
    })

    const http = { type: "http", url: "http://127.0.0.1:1/mcp" }
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { agentx: http } }))
    expect(leanMcpServers(ws, lean, agentx, "cron").agentx).toEqual(http)
  })

  it("shows the count in the daemon log line", () => {
    const lean = { ...DEFAULT_LEAN, contextOnDemand: false, agentxTools: ["agentx_crons"] }
    expect(describeProfile("lean", lean, "cron")).toContain("agentx-tools=3")
    expect(describeProfile("lean", DEFAULT_LEAN, "cron")).not.toContain("agentx-tools")
  })
})

describe("the agentx server's tool list", () => {
  it("lists every tool when the variable is unset or names no known tool", () => {
    const all = listedTools({})
    expect(all.length).toBeGreaterThan(10)
    expect(listedTools({ AGENTX_MCP_TOOLS: "" })).toEqual(all)
    expect(listedTools({ AGENTX_MCP_TOOLS: "not_a_tool" })).toEqual(all)
  })

  it("lists only the named tools", () => {
    const names = listedTools({ AGENTX_MCP_TOOLS: "agentx_request, agentx_recent,unknown" }).map((t) => t.name)
    expect(names.sort()).toEqual(["agentx_recent", "agentx_request"])
  })

  it("knows every tool a shortened list always keeps", () => {
    const known = new Set(listedTools({}).map((t) => t.name))
    for (const name of [...CORE, ...ON_DEMAND]) expect(known.has(name)).toBe(true)
  })
})

describe("config", () => {
  it("defaults to empty lists and reads per-channel ones", () => {
    const empty = daemonConfigSchema.parse({ node: { id: "n", name: "N" } })
    expect(leanConfig(empty.session).agentxTools).toEqual([])
    expect(leanConfig(empty.session).agentxToolsByChannel).toEqual({})

    const parsed = daemonConfigSchema.parse({
      node: { id: "n", name: "N" },
      session: { lean: { agentxTools: ["agentx_channel_reply"], agentxToolsByChannel: { a2a: ["agentx_send_agent"] } } },
    })
    expect(leanAgentxTools(leanConfig(parsed.session), "a2a")).toContain("agentx_send_agent")
    expect(leanAgentxTools(leanConfig(parsed.session), "github")).toContain("agentx_channel_reply")
  })
})
