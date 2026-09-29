import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { MemoryStore } from "../src/agents/memory-store"

// The memory file is read on every turn and only grows. Parsing a
// hundred-kilobyte log per task on the event loop was part of the
// pre-spawn cost; the parse is now keyed on the file's mtime and size.

let tmp: string
let store: MemoryStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-memory-cache-"))
  store = new MemoryStore(tmp)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

const fact = (content: string) => ({
  agentId: "a", category: "fact" as const, content, keywords: [content],
  source: { channel: "telegram", chatId: "c", sender: "s", date: "2026-01-01" },
})

describe("MemoryStore.getAll cache", () => {
  it("serves the parsed facts while mtime and size hold", () => {
    store.addMemory("a", fact("one"))
    expect(store.getAll("a").map((m) => m.content)).toEqual(["one"])
    // Rewrite the file behind the store's back with the same size and the
    // same mtime: a cache hit is the only way "one" still comes back.
    const file = path.join(tmp, ".agentx/memory/a.jsonl")
    // Whole-second timestamps: utimes cannot restore sub-millisecond mtimes.
    const fixed = new Date("2026-01-01T00:00:00Z")
    utimesSync(file, fixed, fixed)
    expect(store.getAll("a").map((m) => m.content)).toEqual(["one"])
    const before = statSync(file)
    const original = JSON.parse(readFileSync(file, "utf-8").trim())
    const swapped = JSON.stringify({ ...original, content: "two" }) // same length
    writeFileSync(file, swapped + "\n")
    utimesSync(file, fixed, fixed)
    expect(statSync(file).size).toBe(before.size)
    expect(store.getAll("a").map((m) => m.content)).toEqual(["one"])
  })

  it("sees a fact appended through the store", () => {
    store.addMemory("a", fact("one"))
    store.getAll("a")
    store.addMemory("a", fact("two"))
    expect(store.getAll("a").map((m) => m.content)).toEqual(["one", "two"])
  })

  it("sees an external rewrite with a newer mtime", () => {
    store.addMemory("a", fact("one"))
    store.getAll("a")
    const file = path.join(tmp, ".agentx/memory/a.jsonl")
    const line = JSON.stringify({ ...fact("other"), id: "x", createdAt: "2026-01-01T00:00:00Z" })
    writeFileSync(file, line + "\n")
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    expect(store.getAll("a").map((m) => m.content)).toEqual(["other"])
  })

  it("hands each caller its own array", () => {
    store.addMemory("a", fact("one"))
    const a = store.getAll("a")
    a.pop()
    expect(store.getAll("a")).toHaveLength(1)
  })
})
