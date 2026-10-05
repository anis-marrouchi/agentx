import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  agentObservationDir,
  answerPackHook,
  buildExcerpt,
  packToolOutput,
  pruneObservations,
  toolIsPacked,
  type ObservationPackConfig,
} from "../src/agents/observation-pack"
import { patchObservationPack, setupAllWorkspaces } from "../src/agents/workspace-setup"
import type { AgentDef } from "../src/daemon/config"
import { daemonConfigSchema } from "../src/daemon/config"

const config = (overrides: Partial<ObservationPackConfig> = {}): ObservationPackConfig => ({
  enabled: true,
  limitBytes: 10_240,
  headBytes: 1024,
  tailBytes: 1024,
  tools: ["Bash", "Grep", "Read", "WebFetch", "mcp__.*"],
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
/** A Read result as Claude Code hands it to a PostToolUse hook. */
const read = (content: string, input: { file_path: string; offset?: number; limit?: number } = { file_path: "/src/app.ts" }, startLine = input.offset ?? 1) => ({
  session_id: "s1",
  tool_name: "Read",
  tool_input: input,
  tool_response: {
    type: "text",
    file: { filePath: input.file_path, content, numLines: content.split("\n").length, startLine, totalLines: content.split("\n").length },
  },
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
    // Owner decision on #621 (2026-10-05): file reads are packed too.
    expect(pack.tools).toEqual(["Bash", "Grep", "Read", "WebFetch", "mcp__.*"])
  })

  it("leaves everything alone when off, under the limit or for a tool not listed", () => {
    expect(packToolOutput(bash(big), config({ enabled: false }), dir)).toBeNull()
    expect(packToolOutput(bash("short"), config(), dir)).toBeNull()
    expect(packToolOutput({ ...bash(big), tool_name: "Glob" }, config(), dir)).toBeNull()
    expect(packToolOutput(read(big), config({ tools: ["Bash"] }), dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  describe("file reads", () => {
    it("keeps whole lines from both ends, names the file and the lines left out, and copies nothing", () => {
      const result = packToolOutput(read(big), config(), dir)!
      const updated = result.updated as { type: string; file: { filePath: string; content: string; startLine: number; totalLines: number } }
      const [pack] = result.packs

      // Same shape around the content; the file's own path, not a copy.
      expect(updated.type).toBe("text")
      expect(updated.file.filePath).toBe("/src/app.ts")
      expect(updated.file.startLine).toBe(1)
      expect(updated.file.totalLines).toBe(600)
      expect(pack.path).toBe("/src/app.ts")
      expect(pack.bytes).toBe(Buffer.byteLength(big))
      expect(existsSync(dir)).toBe(false)

      // Whole lines: 1024 bytes is 21 lines of 48 bytes plus a break.
      const content = updated.file.content
      expect(Buffer.byteLength(content)).toBeLessThan(3000)
      expect(content.startsWith("line 0 ")).toBe(true)
      expect(content).toContain("line 20 x")
      expect(content).not.toContain("line 21 x")
      expect(content).not.toContain("line 300 ")
      expect(content).toContain("\nline 580 x")
      expect(content).not.toContain("line 579 x")
      expect(content.endsWith("line 599 " + "x".repeat(40))).toBe(true)

      // The head comes first, so Claude Code's own line numbers hold for it;
      // the notice says where the rest is and which lines follow it.
      const notice = content.split("\n").find((l) => l.startsWith("[ObservationPack"))!
      expect(content.indexOf("[ObservationPack")).toBeGreaterThan(content.indexOf("line 20 x"))
      expect(notice).toContain("lines 1 to 600 of /src/app.ts")
      expect(content).toContain("Lines 22 to 580 (")
      expect(content).toContain("Lines 581 to 600 follow")
      expect(content).toContain("offset and limit")
      expect(content).not.toContain("saved at")
    })

    it("counts lines from the offset of a paged read", () => {
      const page = read(big, { file_path: "/src/app.ts", offset: 1001, limit: 600 })
      page.tool_response.file.totalLines = 2400
      const updated = (packToolOutput(page, config(), dir)!.updated as { file: { content: string } }).file.content
      expect(updated).toContain("lines 1001 to 1600 of /src/app.ts (2400 lines in all)")
      expect(updated).toContain("Lines 1022 to 1580 (")
      expect(updated).toContain("Lines 1581 to 1600 follow")
    })

    it("says so when a line longer than the budget is cut", () => {
      const oneLine = "x".repeat(20_000)
      const updated = (packToolOutput(read(oneLine), config(), dir)!.updated as { file: { content: string } }).file.content
      expect(updated).toContain("lines 1 to 1 of /src/app.ts")
      expect(updated).toContain("Line 1 (17952 bytes) is not shown (line 1 only in part)")
      expect(updated).not.toContain("follow")

      const longEnds = ["y".repeat(3000), ...big.split("\n"), "z".repeat(3000)].join("\n")
      const cut = (packToolOutput(read(longEnds), config(), dir)!.updated as { file: { content: string } }).file.content
      expect(cut).toContain("Lines 1 to 602 (")
      expect(cut).toContain("(lines 1 and 602 only in part)")
      expect(cut.startsWith("yyyy")).toBe(true)
      expect(cut.endsWith("zzzz")).toBe(true)
    })

    it("starts with the notice when no head is kept, and ends with it when no tail is", () => {
      const noHead = (packToolOutput(read(big), config({ headBytes: 0 }), dir)!.updated as { file: { content: string } }).file.content
      expect(noHead.startsWith("[ObservationPack")).toBe(true)
      expect(noHead).toContain("Lines 1 to 580 (")
      const noTail = (packToolOutput(read(big), config({ tailBytes: 0 }), dir)!.updated as { file: { content: string } }).file.content
      expect(noTail.endsWith("Do not guess at what is not shown.]")).toBe(true)
      expect(noTail).toContain("Lines 22 to 600 (")
      expect(noTail).not.toContain("follow")
    })

    it("leaves a notebook, a PDF or a picture read alone", () => {
      const cells = { type: "notebook", file: { filePath: "/n.ipynb", cells: [{ cellType: "code", source: big }] } }
      const pdf = { type: "pdf", file: { filePath: "/d.pdf", base64: "A".repeat(50_000), originalSize: 37_500 } }
      const image = { type: "image", file: { base64: "A".repeat(50_000), type: "image/png" } }
      for (const tool_response of [cells, pdf, image]) {
        expect(packToolOutput({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_response }, config(), dir)).toBeNull()
      }
      expect(existsSync(dir)).toBe(false)
    })

    it("counts a packed read in the index like any other pack", () => {
      const out = JSON.parse(answerPackHook(read(big), config(), { dir, agentId: "coder-agent" }))
      expect(out.hookSpecificOutput.updatedToolOutput.file.content).toContain("ObservationPack")
      const row = JSON.parse(readFileSync(resolve(dir, "index.jsonl"), "utf-8").trim())
      expect(row).toMatchObject({ agent: "coder-agent", tool: "Read", bytes: Buffer.byteLength(big) })
      expect(row.keptBytes).toBeLessThan(3000)
    })
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

  it("leaves base64 sound and resource bodies alone, and packs a resource's text", () => {
    const base64 = "A".repeat(20_000)
    const audio = { type: "audio", data: base64, mimeType: "audio/wav" }
    const blob = { type: "resource", resource: { uri: "file:///a.bin", mimeType: "application/octet-stream", blob: base64 } }
    expect(packToolOutput({ tool_name: "mcp__x__y", tool_response: [audio, blob] }, config(), dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)

    const text = { type: "resource", resource: { uri: "file:///a.log", mimeType: "text/plain", text: big } }
    const result = packToolOutput({ tool_name: "mcp__x__y", tool_response: [audio, blob, text] }, config(), dir)!
    const [keptAudio, keptBlob, packed] = result.updated as [typeof audio, typeof blob, typeof text]
    expect(keptAudio).toEqual(audio)
    expect(keptBlob).toEqual(blob)
    expect(packed.resource.text).toContain("ObservationPack")
    expect(result.packs).toHaveLength(1)
  })

  it("leaves a result Claude Code already saved to a file", () => {
    const persisted = { stdout: big, stderr: "", persistedOutputPath: "/x/tool-results/abc.txt", persistedOutputSize: 52_889 }
    expect(packToolOutput({ tool_name: "Bash", tool_response: persisted }, config(), dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  it("returns a saved original whole when the agent reads it back", () => {
    const cfg = config()
    const { packs } = packToolOutput(bash(big), cfg, dir)!
    const readBack = (file_path: string) => read(big, { file_path })
    expect(packToolOutput(readBack(packs[0].path), cfg, dir)).toBeNull()
    expect(packToolOutput(readBack("/somewhere/else.log"), cfg, dir)).not.toBeNull()

    // The same file reached through a symlink is still the original.
    const link = resolve(dir, "../link")
    symlinkSync(dir, link)
    expect(packToolOutput(readBack(packs[0].path.replace(dir, link)), cfg, dir)).toBeNull()
  })

  it("points at byte ranges, not lines, when the original is a few very long lines", () => {
    const cfg = { headBytes: 1024, tailBytes: 1024 }
    expect(buildExcerpt(big, "/p", cfg)).toContain("offset and limit")
    const minified = buildExcerpt(JSON.stringify({ rows: "x".repeat(25_000) }), "/p", cfg)
    expect(minified).toContain("(1 lines)")
    expect(minified).toContain("byte range")
    expect(minified).not.toContain("offset and limit")
  })

  it("gives each agent its own folder, inside the store whatever the id", () => {
    expect(agentObservationDir(dir, "coder-agent")).toBe(resolve(dir, "coder-agent"))
    for (const id of ["..", "../x", "a/b", "."]) {
      expect(agentObservationDir(dir, id).startsWith(dir + "/")).toBe(true)
      expect(resolve(agentObservationDir(dir, id), "..")).toBe(dir)
    }
    expect(agentObservationDir(dir, "a")).not.toBe(agentObservationDir(dir, "b"))
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
    expect(answerPackHook(null as never, config(), { dir })).toBe("")
    const out = JSON.parse(answerPackHook(bash(big), config(), { dir, agentId: "coder-agent" }))
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain("ObservationPack")
    const row = JSON.parse(readFileSync(resolve(dir, "index.jsonl"), "utf-8").trim())
    expect(row).toMatchObject({ agent: "coder-agent", session: "s1", tool: "Bash", bytes: Buffer.byteLength(big) })
  })

  it("prunes only originals older than the retention, and nothing at 0", () => {
    const { packs } = packToolOutput(bash(big), config(), agentObservationDir(dir, "coder-agent"))!
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
      // Its own folder of the store, not the store.
      expect(s.permissions.allow).toEqual(["Bash(git *)", "Read(//data/.agentx/observations/coder-agent/**)"])

      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(true))).toBe(false)
    })

    it("takes its hook and its read rule out when switched off", () => {
      write({ permissions: { allow: ["Bash(git *)"] }, hooks: {} })
      patchObservationPack(ws(), "coder-agent", "18800", pack(true))
      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(false))).toBe(true)
      expect(read()).toEqual({ permissions: { allow: ["Bash(git *)"] }, hooks: { PostToolUse: [] } })
    })

    it("skips an agent that could not read an original back, and takes its hook out", () => {
      const store = "/data/.agentx/observations"
      const hooksOf = (ws: string) => JSON.parse(readFileSync(resolve(ws, ".claude/settings.json"), "utf-8")).hooks?.PostToolUse ?? []
      const isPack = (e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes("/observation/pack"))
      const agent = (name: string, permissionMode: string) => {
        const workspace = resolve(dir, "..", name)
        mkdirSync(workspace, { recursive: true })
        return { name, workspace, tier: "claude-code", permissionMode } as AgentDef
      }
      const agents = { open: agent("open", "bypassPermissions"), asks: agent("asks", "default") }
      const logs: string[] = []
      const log = (...a: unknown[]) => void logs.push(a.join(" "))

      // A hook left by an earlier start in the workspace of the agent that asks.
      setupAllWorkspaces(agents, "18800", () => {})
      patchObservationPack(agents.asks.workspace, "asks", "18800", { enabled: true, tools: ["Bash"], dir: store })
      expect(hooksOf(agents.asks.workspace).some(isPack)).toBe(true)

      setupAllWorkspaces(agents, "18800", log, { enabled: true, tools: ["Bash"], dir: store })
      expect(hooksOf(agents.open.workspace).some(isPack)).toBe(true)
      expect(hooksOf(agents.asks.workspace).some(isPack)).toBe(false)
      expect(logs.some((l) => l.includes("written to 1 workspace"))).toBe(true)
      expect(logs.some((l) => l.includes("removed from 1 workspace"))).toBe(true)
      expect(logs.some((l) => l.includes("1 agent(s) not packed"))).toBe(true)
    })

    it("does not touch a workspace that never had the pack", () => {
      write({ env: { A: "1" } })
      expect(patchObservationPack(ws(), "coder-agent", "18800", pack(false))).toBe(false)
      expect(read()).toEqual({ env: { A: "1" } })
    })
  })
})
