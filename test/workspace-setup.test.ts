import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  generateClaudeMd,
  patchGuardrails,
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

describe("codegraph opt-in", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(resolve(tmpdir(), "agentx-ws-cg-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("CLAUDE.md omits the CodeGraph section when codegraph=false", () => {
    const md = generateClaudeMd("a", baseAgent({ codegraph: false, systemPrompt: "p" }), "19900")
    expect(md).not.toContain("## CodeGraph")
    expect(md).not.toContain("codegraph_search")
  })

  it("CLAUDE.md includes the CodeGraph section when codegraph=true", () => {
    const md = generateClaudeMd("a", baseAgent({ codegraph: true, systemPrompt: "p" }), "19900")
    expect(md).toContain("## CodeGraph")
    expect(md).toContain("codegraph_search")
    expect(md).toContain("codegraph_callers")
    // The block instructs Explore-subagent usage for the heavy tools.
    expect(md).toMatch(/Explore subagent/i)
  })

  it("settings.json adds codegraph tools to permissions.allow when codegraph=true", () => {
    setupWorkspace("ws-cg", baseAgent({ workspace, codegraph: true }), "19900", () => {})
    const settings = JSON.parse(readFileSync(resolve(workspace, ".claude/settings.json"), "utf8"))
    const allow = settings.permissions?.allow ?? []
    expect(allow).toContain("mcp__codegraph__codegraph_search")
    expect(allow).toContain("mcp__codegraph__codegraph_callers")
    expect(allow).toContain("mcp__codegraph__codegraph_impact")
  })

  it("settings.json omits the codegraph allow entries when codegraph=false", () => {
    setupWorkspace("ws-cg", baseAgent({ workspace, codegraph: false }), "19900", () => {})
    const settings = JSON.parse(readFileSync(resolve(workspace, ".claude/settings.json"), "utf8"))
    const allow = settings.permissions?.allow ?? []
    expect(allow).not.toContain("mcp__codegraph__codegraph_search")
  })

  it("flipping codegraph false → true refreshes CLAUDE.md", () => {
    setupWorkspace("ws-cg", baseAgent({ workspace, codegraph: false, systemPrompt: "p" }), "19900", () => {})
    const before = readFileSync(resolve(workspace, "CLAUDE.md"), "utf8")
    expect(before).not.toContain("## CodeGraph")

    // managedHashInputs folds the codegraph flag into the marker hash so
    // flipping the flag triggers a refresh on next setup, even when the
    // systemPrompt is unchanged.
    const result = setupWorkspace("ws-cg", baseAgent({ workspace, codegraph: true, systemPrompt: "p" }), "19900", () => {})
    const after = readFileSync(resolve(workspace, "CLAUDE.md"), "utf8")
    expect(after).toContain("## CodeGraph")
    expect(result.created.some((p) => p.endsWith("CLAUDE.md (refreshed)"))).toBe(true)
  })
})

describe("destructive-action guardrails wiring", () => {
  let workspace: string
  const readSettings = () => JSON.parse(readFileSync(resolve(workspace, ".claude/settings.json"), "utf8"))

  beforeEach(() => {
    workspace = mkdtempSync(resolve(tmpdir(), "agentx-ws-guard-"))
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("generated settings.json includes the guardrail deny list in every mode", () => {
    for (const mode of ["bypassPermissions", "plan", "default"] as const) {
      const ws = mkdtempSync(resolve(tmpdir(), "agentx-ws-guard-m-"))
      setupWorkspace("a", baseAgent({ workspace: ws, permissionMode: mode }), "19900", () => {})
      const deny: string[] = readFileSync(resolve(ws, ".claude/settings.json"), "utf8")
        ? JSON.parse(readFileSync(resolve(ws, ".claude/settings.json"), "utf8")).permissions.deny
        : []
      expect(deny).toContain("Bash(npx prisma migrate reset*)")
      expect(deny).toContain("Bash(prisma db push*)")
      expect(deny).toContain("Bash(dropdb*)")
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("generated settings.json wires the PreToolUse guard hook on Bash + Write/Edit", () => {
    setupWorkspace("devops-agent", baseAgent({ workspace }), "19900", () => {})
    const s = readSettings()
    const pre = s.hooks.PreToolUse
    expect(Array.isArray(pre)).toBe(true)
    const matchers = pre.map((e: any) => e.matcher)
    expect(matchers).toContain("Bash")
    expect(matchers).toContain("Write|Edit")
    const cmds = pre.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(cmds.every((c: string) => c.includes("guard check --agent devops-agent"))).toBe(true)
  })

  it("patchGuardrails backfills an existing settings.json and is idempotent", () => {
    // Simulate a pre-guardrails workspace: settings without deny/PreToolUse.
    mkdirSync(resolve(workspace, ".claude"), { recursive: true })
    writeFileSync(
      resolve(workspace, ".claude/settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] }, hooks: {} }, null, 2),
    )

    expect(patchGuardrails(workspace, "coder-agent")).toBe(true)
    const s = readSettings()
    expect(s.permissions.deny).toContain("Bash(rm -rf /)") // preserved
    expect(s.permissions.deny).toContain("Bash(npx prisma migrate reset*)") // added
    expect(s.hooks.PreToolUse.some((e: any) => e.matcher === "Bash")).toBe(true)

    // Second run is a no-op.
    expect(patchGuardrails(workspace, "coder-agent")).toBe(false)
  })
})
