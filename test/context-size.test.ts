import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { claudeLoadedFiles, estimateTokens, promptOverhead, unmeasured } from "../bench/context-size"

const REPO = resolve(__dirname, "..")

describe("context-size helpers", () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "ctx-size-")) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it("estimates about four characters per token", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcdefgh")).toBe(2)
  })

  it("strips the task out of the prompt, leaving only what wraps it", () => {
    expect(promptOverhead("[context]\n\nDo the thing\n\n[footer]", "Do the thing")).toBe("[context]\n\n\n\n[footer]")
    expect(promptOverhead("just the task", "just the task")).toBe("")
  })

  it("finds CLAUDE.md, rules and their @imports, once each", () => {
    writeFileSync(join(ws, "CLAUDE.md"), "See @AGENTS.md for roles.\n")
    writeFileSync(join(ws, "AGENTS.md"), "Roles. Back to @CLAUDE.md\n")
    writeFileSync(join(ws, "UNUSED.md"), "never imported")
    mkdirSync(join(ws, ".claude/rules"), { recursive: true })
    writeFileSync(join(ws, ".claude/rules/style.md"), "style")
    const files = claudeLoadedFiles(ws).map((f) => f.slice(ws.length + 1)).sort()
    expect(files).toEqual([".claude/rules/style.md", "AGENTS.md", "CLAUDE.md"])
  })

  it("lists hooks and MCP servers it cannot count", () => {
    mkdirSync(join(ws, ".claude"))
    writeFileSync(join(ws, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{}] } }))
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { codegraph: {} } }))
    expect(unmeasured(ws)).toEqual(["hook SessionStart (1)", "mcp server codegraph"])
  })
})

describe("context-size end to end", () => {
  it("measures a clean agent through the real exec path without calling a model", () => {
    const out = execFileSync(join(REPO, "node_modules/.bin/tsx"),
      [join(REPO, "bench/context-size.ts"), "--json", "--message", "Rename foo to bar."],
      { cwd: REPO, encoding: "utf8", timeout: 60_000 })
    const result = JSON.parse(out)
    const names = result.sections.map((s: any) => s.name)
    expect(names).toContain("preamble (--append-system-prompt)")
    expect(names).toContain("workspace CLAUDE.md")
    expect(result.total).toBeGreaterThan(0)
    expect(result.total).toBe(result.sections.reduce((n: number, s: any) => n + s.tokens, 0))
  }, 60_000)
})
