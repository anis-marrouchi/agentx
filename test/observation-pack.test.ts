import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  answerPackHook,
  buildExcerpt,
  packToolOutput,
  pruneObservations,
  toolIsPacked,
  type ObservationPackConfig,
} from "../src/agents/observation-pack"
import { patchObservationPack } from "../src/agents/workspace-setup"
import { daemonConfigSchema } from "../src/daemon/config"

const config = (overrides: Partial<ObservationPackConfig> = {}): ObservationPackConfig => ({
  enabled: true,
  limitBytes: 10_240,
  headBytes: 1024,
  tailBytes: 1024,
  tools: ["Bash", "Grep", "WebFetch", "mcp__.*"],
  retentionDays: 0,
  ...overrides,
})

const big = Array.from({ length: 600 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")
const bash = (stdout: string) => ({
  session_id: "s1",
  tool_name: "Bash",
  tool_input: { command: "make test" },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
})

describe("ObservationPack", () => {
  let dir: string
  beforeEach(() => {
    dir = resolve(mkdtempSync(resolve(tmpdir(), "agentx-pack-")), "observations")
  })
  afterEach(() => {
    rmSync(resolve(dir, ".."), { recursive: true, force: true })
  })

  it("is off by default and has the paper's sizes as its starting values", () => {
    const pack = daemonConfigSchema.parse({ node: { id: "n", name: "N" } }).session.observationPack
    expect(pack).toMatchObject({ enabled: false, limitBytes: 10_240, headBytes: 1024, tailBytes: 1024, retentionDays: 0 })
    expect(pack.tools).not.toContain("Read")
  })

  it("leaves everything alone when off, under the limit or for a tool not listed", () => {
    expect(packToolOutput(bash(big), config({ enabled: false }), dir)).toBeNull()
    expect(packToolOutput(bash("short"), config(), dir)).toBeNull()
    expect(packToolOutput({ ...bash(big), tool_name: "Read" }, config(), dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  it("replaces a large Bash result with an excerpt and keeps the exact original", () => {
    const result = packToolOutput(bash(big), config(), dir)!
    const updated = result.updated as { stdout: string; stderr: string; interrupted: boolean }
    const [pack] = result.packs

    // Same shape, smaller text, both ends present.
    expect(updated.stderr).toBe("")
    expect(updated.interrupted).toBe(false)
    expect(Buffer.byteLength(updated.stdout)).toBeLessThan(3000)
    expect(updated.stdout).toContain("line 0 ")
    expect(updated.stdout).toContain("line 599 ")
    expect(updated.stdout).not.toContain("line 300 ")
    expect(updated.stdout).toContain(pack.path)

    // The original is byte for byte what the tool returned.
    expect(readFileSync(pack.path, "utf-8")).toBe(big)
    expect(pack.bytes).toBe(Buffer.byteLength(big))
  })

  it("packs text nested in an MCP result and skips pictures", () => {
    const image = { type: "image", data: "A".repeat(50_000) }
    const result = packToolOutput(
      { tool_name: "mcp__agentx__agentx_recent", tool_response: [{ type: "text", text: big }, image] },
      config(),
      dir,
    )!
    const [text, kept] = result.updated as [{ type: string; text: string }, typeof image]
    expect(text.type).toBe("text")
    expect(text.text).toContain("ObservationPack")
    expect(kept).toEqual(image)
    expect(packToolOutput({ tool_name: "Bash", tool_response: { stdout: big, isImage: true } }, config(), dir)).toBeNull()
  })

  it("leaves a result Claude Code already saved to a file", () => {
    const persisted = { stdout: big, stderr: "", persistedOutputPath: "/x/tool-results/abc.txt", persistedOutputSize: 52_889 }
    expect(packToolOutput({ tool_name: "Bash", tool_response: persisted }, config(), dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  it("returns a saved original whole when the agent reads it back", () => {
    const cfg = config({ tools: ["Bash", "Read"] })
    const { packs } = packToolOutput(bash(big), cfg, dir)!
    const read = (file_path: string) => ({
      tool_name: "Read",
      tool_input: { file_path },
      tool_response: { type: "text", file: { filePath: file_path, content: big } },
    })
    expect(packToolOutput(read(packs[0].path), cfg, dir)).toBeNull()
    expect(packToolOutput(read("/somewhere/else.log"), cfg, dir)).not.toBeNull()
  })

  it("does not split a multi-byte character at the cut", () => {
    const text = "é".repeat(8000) // 16,000 bytes, every character two bytes
    const excerpt = buildExcerpt(text, "/p", { headBytes: 1023, tailBytes: 1023 })
    expect(excerpt).not.toContain("�")
  })

  it("refuses sizes where the excerpt would not be smaller than the original", () => {
    expect(packToolOutput(bash(big), config({ limitBytes: 2048, headBytes: 1024, tailBytes: 1024 }), dir)).toBeNull()
  })

  it("matches whole tool names only", () => {
    expect(toolIsPacked("Bash", ["Bash"])).toBe(true)
    expect(toolIsPacked("BashOutput", ["Bash"])).toBe(false)
    expect(toolIsPacked("mcp__agentx__agentx_recent", ["mcp__.*"])).toBe(true)
  })

  it("answers the hook in Claude Code's shape and counts the pack", () => {
    expect(answerPackHook(bash("short"), config(), { dir })).toBe("")
    const out = JSON.parse(answerPackHook(bash(big), config(), { dir, agentId: "coder-agent" }))
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain("ObservationPack")
    const row = JSON.parse(readFileSync(resolve(dir, "index.jsonl"), "utf-8").trim())
    expect(row).toMatchObject({ agent: "coder-agent", session: "s1", tool: "Bash", bytes: Buffer.byteLength(big) })
  })

  it("prunes only originals older than the retention, and nothing at 0", () => {
    const { packs } = packToolOutput(bash(big), config(), dir)!
    const old = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(packs[0].path, old, old)
    expect(pruneObservations(dir, 0)).toBe(0)
    expect(pruneObservations(dir, 30)).toBe(0)
    expect(pruneObservations(dir, 7)).toBe(1)
    expect(existsSync(packs[0].path)).toBe(false)
  })

  describe("workspace hook", () => {
    const settingsPath = () => resolve(dir, "../.claude/settings.json")
    const read = () => JSON.parse(readFileSync(settingsPath(), "utf-8"))
    const write = (s: unknown) => {
      mkdirSync(resolve(dir, "../.claude"), { recursive: true })
      writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
    }
    const ws = () => resolve(dir, "..")
    const pack = (enabled: boolean) => ({ enabled, tools: ["Bash", "mcp__.*"], dir: "/data/.agentx/observations" })

    it("adds one hook, keeps the others, and is idempotent", () => {
      const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }
      write({ permissions: { allow: ["Bash(git *)"] }, hooks: { PostToolUse: [userHook] } })

      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(true))).toBe(true)
      const s = read()
      expect(s.hooks.PostToolUse).toHaveLength(2)
      expect(s.hooks.PostToolUse[0]).toEqual(userHook)
      expect(s.hooks.PostToolUse[1].matcher).toBe("Bash|mcp__.*")
      const command: string = s.hooks.PostToolUse[1].hooks[0].command
      expect(command).toContain("http://127.0.0.1:18800/observation/pack?agent=coder-agent")
      // With the daemon down the hook must print nothing and exit 0.
      expect(command.trim().endsWith("|| true")).toBe(true)
      expect(s.permissions.allow).toEqual(["Bash(git *)", "Read(//data/.agentx/observations/**)"])

      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(true))).toBe(false)
    })

    it("takes its hook and its read rule out when switched off", () => {
      write({ permissions: { allow: ["Bash(git *)"] }, hooks: {} })
      patchObservationPack(ws(), "coder-agent", "18800", pack(true))
      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(false))).toBe(true)
      expect(read()).toEqual({ permissions: { allow: ["Bash(git *)"] }, hooks: { PostToolUse: [] } })
    })

    it("does not touch a workspace that never had the pack", () => {
      write({ env: { A: "1" } })
      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(false))).toBe(false)
      expect(read()).toEqual({ env: { A: "1" } })
    })
  })
})
