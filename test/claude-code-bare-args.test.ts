import { describe, it, expect } from "vitest"
import { BARE_CLI_ARGS, buildCliGenerateArgs, describeCliFailure } from "../src/agent/providers/claude-code"

// Helper calls (classifier, summaries, extraction) went through the same
// `claude -p` startup as an interactive agent: plugins, hooks, MCP servers,
// settings, session files. That startup was ~19s per task on the critical
// path. `bare` strips it.

describe("buildCliGenerateArgs", () => {
  it("keeps the agentic shape by default", () => {
    const args = buildCliGenerateArgs({ model: "haiku", systemPrompt: "sys", prompt: "hi" })
    expect(args).toEqual([
      "-p", "--output-format", "json", "--model", "haiku", "--dangerously-skip-permissions",
      "--append-system-prompt", "sys", "hi",
    ])
    for (const flag of BARE_CLI_ARGS) expect(args).not.toContain(flag === "" ? "__never__" : flag)
  })

  it("disables tools, MCP, hooks, settings and session files when bare", () => {
    const args = buildCliGenerateArgs({ model: "haiku", systemPrompt: "sys", prompt: "hi", bare: true })
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "json", "--model", "haiku", "--dangerously-skip-permissions"])
    expect(args).toContain("--strict-mcp-config")
    expect(args).toContain("--no-session-persistence")
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} })
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true })
    // The system prompt replaces the CLI's own instead of appending to it.
    expect(args).toContain("--system-prompt")
    expect(args).not.toContain("--append-system-prompt")
    expect(args[args.length - 1]).toBe("hi")
  })

  it("omits the system prompt flag when there is none", () => {
    const args = buildCliGenerateArgs({ model: "haiku", prompt: "hi", bare: true })
    expect(args).not.toContain("--system-prompt")
    expect(args[args.length - 1]).toBe("hi")
  })
})

describe("describeCliFailure", () => {
  it("prefers what the CLI printed", () => {
    expect(describeCliFailure({ stderr: " rate limited \n", exitCode: 1 })).toBe("rate limited")
  })

  it("names an abort, a timeout or a signal when the CLI printed nothing", () => {
    // The classifier's 30s abort was the bare "Claude CLI failed" in daemon logs.
    expect(describeCliFailure({ stderr: "", stdout: "", isCanceled: true, signal: "SIGTERM" })).toMatch(/aborted/)
    expect(describeCliFailure({ timedOut: true })).toMatch(/timed out/)
    expect(describeCliFailure({ signal: "SIGKILL" })).toMatch(/SIGKILL/)
    expect(describeCliFailure({ exitCode: 2 })).toMatch(/exit 2/)
  })
})
