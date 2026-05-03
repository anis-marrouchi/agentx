import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  registerAllBuiltins,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"

let workspace: string
const origRoots = process.env.AGENTX_BUILTIN_FILE_ROOTS

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
  workspace = mkdtempSync(path.join(tmpdir(), "agentx-builtin-file-"))
  process.env.AGENTX_BUILTIN_FILE_ROOTS = workspace
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  if (origRoots === undefined) delete process.env.AGENTX_BUILTIN_FILE_ROOTS
  else process.env.AGENTX_BUILTIN_FILE_ROOTS = origRoots
})

describe("file.read_lines", () => {
  it("reads all lines under maxLines (truncated=false)", async () => {
    const p = path.join(workspace, "a.log")
    writeFileSync(p, "one\ntwo\nthree\n")
    const out: any = await runBuiltin("file.read_lines", { path: p })
    expect(out.lines).toEqual(["one", "two", "three"])
    expect(out.totalLines).toBe(3)
    expect(out.truncated).toBe(false)
  })

  it("returns the head when totalLines > maxLines (default fromEnd=false)", async () => {
    const p = path.join(workspace, "many.log")
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n") + "\n")
    const out: any = await runBuiltin("file.read_lines", { path: p, maxLines: 3 })
    expect(out.lines).toEqual(["line-0", "line-1", "line-2"])
    expect(out.totalLines).toBe(10)
    expect(out.truncated).toBe(true)
  })

  it("returns the tail when fromEnd=true", async () => {
    const p = path.join(workspace, "tail.log")
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n") + "\n")
    const out: any = await runBuiltin("file.read_lines", { path: p, maxLines: 3, fromEnd: true })
    expect(out.lines).toEqual(["line-7", "line-8", "line-9"])
  })

  it("rejects paths outside the allowed roots (path traversal guard)", async () => {
    await expect(runBuiltin("file.read_lines", { path: "/etc/passwd" })).rejects.toThrow(/outside the allowed roots/)
    await expect(runBuiltin("file.read_lines", { path: path.join(workspace, "..", "..", "etc", "hosts") }))
      .rejects.toThrow(/outside the allowed roots/)
  })

  it("returns an error for missing files instead of throwing internals", async () => {
    await expect(runBuiltin("file.read_lines", { path: path.join(workspace, "nope.log") }))
      .rejects.toThrow(/file not found/)
  })
})

describe("file.write_jsonl", () => {
  it("appends one JSON record per line and reports written count", async () => {
    const p = path.join(workspace, "out.jsonl")
    const out: any = await runBuiltin("file.write_jsonl", {
      path: p,
      records: [{ a: 1 }, { b: "two" }, { c: [1, 2, 3] }],
    })
    expect(out.written).toBe(3)
    expect(out.bytesAppended).toBeGreaterThan(0)
    const lines = readFileSync(p, "utf8").trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual({ a: 1 })
    expect(JSON.parse(lines[2])).toEqual({ c: [1, 2, 3] })
  })

  it("appends to an existing file without overwriting", async () => {
    const p = path.join(workspace, "out.jsonl")
    writeFileSync(p, '{"existing":true}\n')
    await runBuiltin("file.write_jsonl", { path: p, records: [{ added: 1 }] })
    const lines = readFileSync(p, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ existing: true })
    expect(JSON.parse(lines[1])).toEqual({ added: 1 })
  })

  it("creates parent dirs only when createDirs=true", async () => {
    const p = path.join(workspace, "nested", "dir", "out.jsonl")
    await expect(runBuiltin("file.write_jsonl", { path: p, records: [{ x: 1 }] }))
      .rejects.toThrow()
    await runBuiltin("file.write_jsonl", { path: p, records: [{ x: 1 }], createDirs: true })
    const lines = readFileSync(p, "utf8").trim().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ x: 1 })
  })

  it("rejects paths outside the allowed roots", async () => {
    await expect(runBuiltin("file.write_jsonl", { path: "/tmp/outside.jsonl", records: [{}] }))
      .rejects.toThrow(/outside the allowed roots/)
  })

  it("rejects empty records array (Zod min(1))", async () => {
    await expect(runBuiltin("file.write_jsonl", { path: path.join(workspace, "x.jsonl"), records: [] }))
      .rejects.toThrow()
  })
})
