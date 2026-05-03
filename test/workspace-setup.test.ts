import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  generateClaudeMd,
  readManagedHash,
  setupWorkspace,
} from "../src/agents/workspace-setup"
import type { AgentDef } from "../src/daemon/config"

const baseAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  name: "Test Agent",
  workspace: "/tmp/agentx-ws-test-nonexistent",
  tier: "claude-code",
  ...overrides,
}) as AgentDef

describe("generateClaudeMd", () => {
  it("emits a multi-paragraph systemPrompt verbatim under ## Role", () => {
    const systemPrompt = [
      "You are a sales assistant.",
      "",
      "## Lead capture protocol",
      "1. Greet the visitor.",
      "2. Ask their name and email.",
      "3. Confirm consent before storing anything.",
      "",
      "## Tone",
      "Friendly, concise, never pushy.",
    ].join("\n")

    const md = generateClaudeMd("sales", baseAgent({ systemPrompt }), "19900")

    // Every line of the systemPrompt must survive
    for (const line of systemPrompt.split("\n")) {
      if (line.trim().length === 0) continue
      expect(md).toContain(line)
    }
    // The whole prompt should appear contiguously, not header-by-header
    expect(md).toContain(systemPrompt.trimEnd())
  })

  it("preserves prompts longer than the legacy 3-line cap", () => {
    const systemPrompt = Array.from({ length: 25 }, (_, i) => `Instruction ${i + 1}.`).join("\n")
    const md = generateClaudeMd("worker", baseAgent({ systemPrompt }), "19900")
    expect(md).toContain("Instruction 1.")
    expect(md).toContain("Instruction 25.")
  })

  it("omits the Role section when systemPrompt is empty", () => {
    const md = generateClaudeMd("blank", baseAgent({ systemPrompt: "" }), "19900")
    expect(md).not.toContain("## Role")
  })

  it("omits the Role section when systemPrompt is whitespace-only", () => {
    const md = generateClaudeMd("ws", baseAgent({ systemPrompt: "   \n  \n" }), "19900")
    expect(md).not.toContain("## Role")
  })

  it("stamps a managed-marker on line 1 with a hash of the systemPrompt", () => {
    const md = generateClaudeMd("a", baseAgent({ systemPrompt: "hello" }), "19900")
    const firstLine = md.split("\n", 1)[0]
    expect(firstLine).toMatch(/^<!-- agentx-managed: hash=[0-9a-f]{16} -->$/)
    const hash = readManagedHash(md)
    expect(hash).not.toBeNull()
    expect(hash).toHaveLength(16)
  })

  it("changes the marker hash when the systemPrompt changes", () => {
    const a = generateClaudeMd("a", baseAgent({ systemPrompt: "v1" }), "19900")
    const b = generateClaudeMd("a", baseAgent({ systemPrompt: "v2" }), "19900")
    expect(readManagedHash(a)).not.toBe(readManagedHash(b))
  })
})

describe("readManagedHash", () => {
  it("returns the hash when the marker is present on line 1", () => {
    const md = "<!-- agentx-managed: hash=abc123abc123abc1 -->\n# Title\n"
    expect(readManagedHash(md)).toBe("abc123abc123abc1")
  })

  it("returns null for files without the marker (user-edited)", () => {
    expect(readManagedHash("# My CLAUDE.md\nContent\n")).toBeNull()
    expect(readManagedHash("")).toBeNull()
  })

  it("returns null for malformed markers", () => {
    expect(readManagedHash("<!-- agentx-managed: hash=abc -->\n")).toBe("abc")
    expect(readManagedHash("<!-- agentx-managed: -->\n")).toBeNull()
    expect(readManagedHash("# agentx-managed: hash=abc\n")).toBeNull()
  })
})

describe("setupWorkspace CLAUDE.md refresh", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(resolve(tmpdir(), "agentx-ws-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const setup = (def: Partial<AgentDef>) =>
    setupWorkspace(
      "ws-test",
      baseAgent({ workspace, ...def }),
      "19900",
      () => {},
    )

  it("creates CLAUDE.md on first run", () => {
    const result = setup({ systemPrompt: "First version" })
    expect(result.created.some((p) => p.endsWith("CLAUDE.md"))).toBe(true)
    const md = readFileSync(resolve(workspace, "CLAUDE.md"), "utf8")
    expect(md).toContain("First version")
  })

  it("refreshes managed CLAUDE.md when systemPrompt changes", () => {
    setup({ systemPrompt: "Old prompt" })
    const before = readFileSync(resolve(workspace, "CLAUDE.md"), "utf8")
    expect(before).toContain("Old prompt")

    const result = setup({ systemPrompt: "Brand new prompt with multiple paragraphs.\n\nSecond paragraph survives." })
    const after = readFileSync(resolve(workspace, "CLAUDE.md"), "utf8")
    expect(after).toContain("Brand new prompt with multiple paragraphs.")
    expect(after).toContain("Second paragraph survives.")
    expect(after).not.toContain("Old prompt")
    expect(result.created.some((p) => p.endsWith("CLAUDE.md (refreshed)"))).toBe(true)
  })

  it("does NOT refresh when systemPrompt is unchanged", () => {
    setup({ systemPrompt: "Stable" })
    const result = setup({ systemPrompt: "Stable" })
    expect(result.created.some((p) => p.endsWith("CLAUDE.md") || p.endsWith("CLAUDE.md (refreshed)"))).toBe(false)
    expect(result.skipped.some((p) => p.endsWith("CLAUDE.md"))).toBe(true)
  })

  it("never overwrites a user-edited CLAUDE.md (no marker)", () => {
    const path = resolve(workspace, "CLAUDE.md")
    const userContent = "# My handcrafted CLAUDE.md\n\nDo not touch.\n"
    writeFileSync(path, userContent)

    const result = setup({ systemPrompt: "Some prompt" })
    const after = readFileSync(path, "utf8")
    expect(after).toBe(userContent)
    expect(result.skipped.some((p) => p.endsWith("CLAUDE.md"))).toBe(true)
  })
})
