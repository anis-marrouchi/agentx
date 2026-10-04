import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DEFAULT_LEAN, describeProfile, leanClaudeArgs, leanConfig, leanTools } from "../src/agents/session-profile"
import { daemonConfigSchema } from "../src/daemon/config"

// #615 — a lean session may get a short list of built-in tools (`--tools`).
// The built-in tool schemas are about 14k tokens of a first turn; this is
// the lever that brings a lean start under 20k. Off by default: an agent
// that lacks a tool it needs fails mid-task.

const agentx = { type: "stdio" as const, command: "node", args: ["cli.js", "serve", "--stdio"] }

describe("leanTools", () => {
  it("is empty by default: every built-in tool, no --tools flag", () => {
    expect(leanTools(DEFAULT_LEAN)).toEqual([])
    expect(leanTools(DEFAULT_LEAN, "github")).toEqual([])
  })

  it("uses the shared list, and a channel's own list over it", () => {
    const lean = { ...DEFAULT_LEAN, tools: ["Bash", "Read", "Edit"], toolsByChannel: { cron: ["Bash"] } }
    expect(leanTools(lean, "github")).toEqual(["Bash", "Read", "Edit"])
    expect(leanTools(lean, "cron")).toEqual(["Bash"])
    expect(leanTools(lean)).toEqual(["Bash", "Read", "Edit"])
  })

  it("falls back to the shared list when a channel's list is empty, and never produces an all-off list", () => {
    const lean = { ...DEFAULT_LEAN, tools: ["Bash"], toolsByChannel: { a2a: [] } }
    expect(leanTools(lean, "a2a")).toEqual(["Bash"])
    expect(leanTools({ ...DEFAULT_LEAN, tools: [" ", ""] }, "github")).toEqual([])
  })

  it("trims and de-duplicates names", () => {
    expect(leanTools({ ...DEFAULT_LEAN, tools: [" Bash", "Bash", "Read "] })).toEqual(["Bash", "Read"])
  })
})

describe("leanClaudeArgs with tools", () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "lean-tools-")) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it("adds --tools after --strict-mcp-config, only when a list is set", () => {
    const plain = leanClaudeArgs(ws, DEFAULT_LEAN, agentx, "github")
    expect(plain).not.toContain("--tools")

    const lean = { ...DEFAULT_LEAN, tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"] }
    const args = leanClaudeArgs(ws, lean, agentx, "github")
    expect(args.indexOf("--strict-mcp-config")).toBeGreaterThanOrEqual(0)
    expect(args.indexOf("--tools")).toBeGreaterThan(args.indexOf("--strict-mcp-config"))
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Read,Edit,Write,Grep,Glob")
    // The strict MCP config and the setting sources are unchanged.
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: { agentx } })
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local")
  })

  it("picks the channel's own list", () => {
    const lean = { ...DEFAULT_LEAN, tools: ["Bash", "Read"], toolsByChannel: { cron: ["Bash"] } }
    expect(leanClaudeArgs(ws, lean, agentx, "cron")).toContain("Bash")
    expect(leanClaudeArgs(ws, lean, agentx, "cron")[leanClaudeArgs(ws, lean, agentx, "cron").indexOf("--tools") + 1]).toBe("Bash")
    expect(leanClaudeArgs(ws, lean, agentx, "workflow")[leanClaudeArgs(ws, lean, agentx, "workflow").indexOf("--tools") + 1]).toBe("Bash,Read")
  })

  it("never passes an empty --tools: that loads every MCP schema instead of saving", () => {
    const args = leanClaudeArgs(ws, { ...DEFAULT_LEAN, tools: [""], toolsByChannel: { github: [] } }, agentx, "github")
    expect(args).not.toContain("--tools")
  })
})

describe("describeProfile with tools", () => {
  it("names the tools only when a list applies", () => {
    expect(describeProfile("lean", DEFAULT_LEAN, "github")).toBe("lean (mcp=agentx settings=project,local context=on-demand)")
    const lean = { ...DEFAULT_LEAN, tools: ["Bash", "Read"], toolsByChannel: { cron: ["Bash"] } }
    expect(describeProfile("lean", lean, "github")).toContain("tools=Bash+Read")
    expect(describeProfile("lean", lean, "cron")).toContain("tools=Bash")
    expect(describeProfile("lean", lean, "cron")).not.toContain("tools=Bash+Read")
    expect(describeProfile("full", lean, "cron")).toBe("full")
  })
})

describe("config", () => {
  it("defaults to no tool list and no memory index cap", () => {
    const parsed = daemonConfigSchema.parse({ node: { id: "n", name: "N" } })
    expect(parsed.session.lean.tools).toEqual([])
    expect(parsed.session.lean.toolsByChannel).toEqual({})
    expect(parsed.session.memoryIndexMaxChars).toBe(0)
    expect(leanConfig(parsed.session)).toEqual(DEFAULT_LEAN)
  })

  it("accepts the lists and the cap, and rejects nonsense", () => {
    const parsed = daemonConfigSchema.parse({
      node: { id: "n", name: "N" },
      session: { lean: { tools: ["Bash", "Read"], toolsByChannel: { cron: ["Bash"] } }, memoryIndexMaxChars: 4000 },
    })
    expect(leanTools(leanConfig(parsed.session), "cron")).toEqual(["Bash"])
    expect(leanTools(leanConfig(parsed.session), "github")).toEqual(["Bash", "Read"])
    expect(parsed.session.memoryIndexMaxChars).toBe(4000)
    for (const session of [{ lean: { tools: [""] } }, { lean: { toolsByChannel: { cron: "Bash" } } }, { memoryIndexMaxChars: -1 }, { memoryIndexMaxChars: 1.5 }]) {
      expect(daemonConfigSchema.safeParse({ node: { id: "n", name: "N" }, session }).success, JSON.stringify(session)).toBe(false)
    }
  })
})
