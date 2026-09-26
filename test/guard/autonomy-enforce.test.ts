import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync, spawn } from "child_process"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import {
  autonomyClaudeArgs,
  autonomyHookCommand,
  autonomyUnsupported,
  checkAutonomyPayload,
  setAutonomyHookPort,
  takeAutonomyBlocks,
} from "../../src/guard/autonomy-enforce"
import { listDecisions } from "../../src/guard/audit"
import { closeDb } from "../../src/storage/sqlite"

let root: string

beforeEach(() => {
  closeDb()
  root = mkdtempSync(path.join(tmpdir(), "guard-autonomy-"))
  setAutonomyHookPort("19999")
})
afterEach(() => {
  closeDb()
  setAutonomyHookPort(null)
  rmSync(root, { recursive: true, force: true })
})

describe("autonomyClaudeArgs — per-spawn flags", () => {
  it("adds nothing for act / unset", () => {
    expect(autonomyClaudeArgs("act", "a", "T1")).toEqual({ args: [] })
    expect(autonomyClaudeArgs(undefined, "a", "T1")).toEqual({ args: [] })
  })

  it("report: disallows file tools and installs a match-all hook carrying level + task", () => {
    const r = autonomyClaudeArgs("report", "coder", "01TASK")
    if (!("args" in r)) throw new Error(r.error)
    expect(r.args.slice(0, 2)).toEqual(["--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit"])
    expect(r.args[2]).toBe("--settings")
    const settings = JSON.parse(r.args[3])
    const entry = settings.hooks.PreToolUse[0]
    expect(entry.matcher).toBe("*")
    const cmd: string = entry.hooks[0].command
    expect(cmd).toContain("http://127.0.0.1:19999/guard/check?agent=coder&autonomy=report&task=01TASK")
    expect(cmd).toContain("exit 2")
  })

  it("propose: hook only, file tools stay available", () => {
    const r = autonomyClaudeArgs("propose", "coder", "01TASK")
    if (!("args" in r)) throw new Error(r.error)
    expect(r.args).not.toContain("--disallowedTools")
    expect(r.args[0]).toBe("--settings")
    expect(r.args[1]).toContain("autonomy=propose")
  })

  it("refuses when the daemon hook port is unknown", () => {
    setAutonomyHookPort(null)
    const r = autonomyClaudeArgs("report", "coder", "T")
    expect("error" in r && r.error).toMatch(/cannot be enforced/)
  })
})

describe("autonomyUnsupported — tiers that cannot enforce refuse", () => {
  it("claude-code enforces; every other tier refuses restricted levels", () => {
    expect(autonomyUnsupported("report", "claude-code")).toBeNull()
    expect(autonomyUnsupported("act", "codex-cli")).toBeNull()
    for (const tier of ["codex-cli", "opencode", "sdk", "orchestrator"]) {
      expect(autonomyUnsupported("report", tier)).toMatch(/only enforceable on the claude-code tier/)
      expect(autonomyUnsupported("propose", tier)).toMatch(/refusing/)
    }
  })
})

describe("checkAutonomyPayload — daemon side of the hook", () => {
  it("allows a read with an empty body and records nothing", () => {
    const r = checkAutonomyPayload(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      { root, agentId: "coder", level: "report", taskId: "T-allow" },
    )
    expect(r).toEqual({ stdout: "", blocked: null })
    expect(takeAutonomyBlocks("T-allow")).toEqual([])
    expect(listDecisions({ root, taskId: "T-allow" })).toHaveLength(0)
  })

  it("denies a write, logs it to the guard log under the task, and keeps it for the run result", () => {
    const r = checkAutonomyPayload(
      { tool_name: "Write", tool_input: { file_path: "/w/notes.md", content: "x" } },
      { root, agentId: "coder", level: "report", taskId: "T-block" },
    )
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/autonomy "report"/)

    const rows = listDecisions({ root, taskId: "T-block" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent_id: "coder", tool: "Write", command: "/w/notes.md",
      matched_rule: "autonomy.report.write", verdict: "deny", effective_action: "deny", mode: "enforce",
    })

    const blocks = takeAutonomyBlocks("T-block")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ tool: "Write", target: "/w/notes.md", ruleId: "autonomy.report.write" })
    // take() drains
    expect(takeAutonomyBlocks("T-block")).toEqual([])
  })

  it("denies a propose-level merge and records the MCP tool name when there is no command", () => {
    const r = checkAutonomyPayload(
      { tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 3 } },
      { root, agentId: "coder", level: "propose", taskId: "T-mcp" },
    )
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    const rows = listDecisions({ root, taskId: "T-mcp" })
    expect(rows[0]).toMatchObject({ tool: "mcp__github__merge_pull_request", matched_rule: "autonomy.propose.outward" })
  })

  it("act allows everything; an unknown level fails closed", () => {
    expect(checkAutonomyPayload(
      { tool_name: "Bash", tool_input: { command: "git push --force origin main" } },
      { root, level: "act", taskId: "T-act" },
    ).stdout).toBe("")
    const bad = checkAutonomyPayload(
      { tool_name: "Read", tool_input: { file_path: "/w/a" } },
      { root, level: "sudo", taskId: "T-bad" },
    )
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
  })
})

describe("hook command transport", () => {
  const run = (cmd: string, input: string) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn("sh", ["-c", cmd])
      let stdout = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.on("close", (status) => resolve({ status, stdout }))
      child.stdin.end(input)
    })

  it("blocks (exit 2) when the daemon is unreachable — fail closed", () => {
    // Port 9 (discard) on loopback: nothing listens in a test environment.
    const r = spawnSync("sh", ["-c", autonomyHookCommand("9", "coder", "report", "T")], { input: "{}" })
    expect(r.status).toBe(2)
    expect(String(r.stderr)).toMatch(/fail-closed/)
  })

  describe("with a live endpoint", () => {
    let server: Server
    let port: string
    let lastUrl = ""
    beforeEach(async () => {
      server = createServer((req, res) => {
        lastUrl = req.url ?? ""
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end('{"hookSpecificOutput":{"permissionDecision":"deny"}}')
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
      port = String((server.address() as AddressInfo).port)
    })
    afterEach(() => new Promise<void>((r) => server.close(() => r())))

    it("passes the daemon's decision through verbatim with exit 0", async () => {
      const r = await run(autonomyHookCommand(port, "coder", "propose", "01T"), '{"tool_name":"Bash"}')
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('{"hookSpecificOutput":{"permissionDecision":"deny"}}')
      expect(lastUrl).toBe("/guard/check?agent=coder&autonomy=propose&task=01T")
    })
  })
})
