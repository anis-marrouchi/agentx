import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  autoMemoryBlock,
  autoMemoryPath,
  CLAUDE_MDS_OFF_ENV,
  claudeMdBlock,
  claudeMdFiles,
  withOwnClaudeMd,
} from "../src/agents/claude-md-chain"

// Layout copied from coder-agent's workspace; the expected text is the
// shape of message 1 block 0 in a Claude Code 2.1.329 session file.
const HEADER = "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n"
const sec = (p: string, c: string) => `\nContents of ${p} (project instructions, checked into the codebase):\n\n${c}`

let root: string
let home: string
let ws: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-md-chain-"))
  home = join(root, "home")
  ws = join(root, "ws")
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(join(ws, ".claude", "rules"), { recursive: true })
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Global\nUse `@human` in backticks.\n")
  writeFileSync(join(ws, "CLAUDE.md"), "# Workspace\n\n@AGENTS.md\n\n## After\n")
  writeFileSync(join(ws, "AGENTS.md"), "# Agents\n```\n@NOT-AN-IMPORT.md\n```\n")
  writeFileSync(join(ws, ".claude", "rules", "b-heavy.md"), "# Heavy\n")
  writeFileSync(join(ws, ".claude", "rules", "a-quality.md"), "# Quality\n")
  writeFileSync(join(ws, ".claude", "rules", "c-ts-only.md"), "---\npaths: src/**/*.ts\n---\n# TS\n")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("claudeMdBlock (#2000)", () => {
  it("renders the files in Claude Code's order and format", () => {
    expect(claudeMdBlock(ws, ["user", "project", "local"], home)).toBe(
      HEADER
        + sec(join(home, ".claude", "CLAUDE.md"), "# Global\nUse `@human` in backticks.\n")
        + sec(join(ws, "CLAUDE.md"), "# Workspace\n\n@AGENTS.md\n\n## After\n")
        + sec(join(ws, "AGENTS.md"), "# Agents\n```\n@NOT-AN-IMPORT.md\n```\n")
        + sec(join(ws, ".claude", "rules", "a-quality.md"), "# Quality\n")
        + sec(join(ws, ".claude", "rules", "b-heavy.md"), "# Heavy\n")
        + "\n</system-reminder>",
    )
  })

  it("follows the setting sources: no user file for a lean start", () => {
    const paths = claudeMdFiles(ws, ["project", "local"], home).map(([p]) => p)
    expect(paths).not.toContain(join(home, ".claude", "CLAUDE.md"))
    expect(paths[0]).toBe(join(ws, "CLAUDE.md"))
  })

  it("reads parent directories and CLAUDE.local.md", () => {
    writeFileSync(join(root, "CLAUDE.md"), "parent\n")
    writeFileSync(join(ws, "CLAUDE.local.md"), "local\n")
    const paths = claudeMdFiles(ws, ["project", "local"], home).map(([p]) => p)
    expect(paths.indexOf(join(root, "CLAUDE.md"))).toBeLessThan(paths.indexOf(join(ws, "CLAUDE.md")))
    expect(paths).toContain(join(ws, "CLAUDE.local.md"))
    expect(claudeMdFiles(ws, ["project"], home).map(([p]) => p)).not.toContain(join(ws, "CLAUDE.local.md"))
  })

  it("is byte-identical for two starts with the same files", () => {
    expect(claudeMdBlock(ws, ["user", "project", "local"], home)).toBe(claudeMdBlock(ws, ["user", "project", "local"], home))
  })

  it("is empty when there are no files", () => {
    expect(claudeMdBlock(join(root, "none"), ["project"], join(root, "nohome"))).toBe("")
  })
})

describe("autoMemoryBlock (#2000)", () => {
  it("reads MEMORY.md from Claude Code's project directory", () => {
    const path = autoMemoryPath("/Users/me/Developer/coder-workspace", home)
    expect(path).toBe(join(home, ".claude", "projects", "-Users-me-Developer-coder-workspace", "memory", "MEMORY.md"))
    const memDir = join(home, ".claude", "projects", ws.replace(/[^a-zA-Z0-9]/g, "-"), "memory")
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, "MEMORY.md"), "- [Note](note.md) — hook\n")
    expect(autoMemoryBlock(ws, home)).toBe(
      `<system-reminder>\nContents of ${join(memDir, "MEMORY.md")} (user's auto-memory, persists across conversations):\n\n- [Note](note.md) — hook\n</system-reminder>`,
    )
  })

  it("is empty without MEMORY.md", () => {
    expect(autoMemoryBlock(ws, home)).toBe("")
  })
})

describe("withOwnClaudeMd", () => {
  it("turns Claude Code's own loading off only when asked", () => {
    expect(withOwnClaudeMd({}, true)[CLAUDE_MDS_OFF_ENV]).toBe("1")
    expect(withOwnClaudeMd({}, undefined)[CLAUDE_MDS_OFF_ENV]).toBeUndefined()
  })
})
