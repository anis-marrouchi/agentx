import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { GraphStore } from "../src/graph/store"
import { indexFileSchema, nodesFileSchema } from "../src/graph/types"

// The classifier reads the fingerprint index and the nodes file several
// times per message. Both files grow without bound, and re-reading +
// re-validating them on every call blocked the daemon's event loop for
// seconds. These tests pin the in-memory cache that replaced that.

let tmp: string
let store: GraphStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-graph-cache-"))
  store = new GraphStore({ baseDir: tmp, log: () => undefined })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

/** Push the file's mtime forward so an external write is always visible,
 *  even on filesystems with coarse timestamps. */
function writeExternally(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2))
  const later = new Date(Date.now() + 5_000)
  utimesSync(file, later, later)
}

describe("GraphStore fingerprint index cache", () => {
  it("does not re-parse the index on repeated lookups", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    const parse = vi.spyOn(indexFileSchema, "safeParse")
    for (let i = 0; i < 5; i++) expect(store.getFingerprint("fp-1")?.leaf.output).toBe("a")
    expect(parse).not.toHaveBeenCalled()
  })

  it("does not re-validate the whole index when one entry is added", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    const parse = vi.spyOn(indexFileSchema, "safeParse")
    store.setFingerprint("fp-2", { path: ["b"], leaf: { output: "b" } })
    expect(parse).not.toHaveBeenCalled()
  })

  it("persists new entries in the existing file format", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    store.setFingerprint("fp-2", { path: ["b"], leaf: { output: "b" } })
    const raw = readFileSync(store.indexPath(), "utf-8")
    expect(raw).toContain('\n  "entries"')
    const onDisk = indexFileSchema.parse(JSON.parse(raw))
    expect(Object.keys(onDisk.entries).sort()).toEqual(["fp-1", "fp-2"])
    // A fresh store (another process) reads what this one wrote.
    const other = new GraphStore({ baseDir: tmp, log: () => undefined })
    expect(other.getFingerprint("fp-2")?.fingerprint).toBe("fp-2")
  })

  it("picks up a write made by another process", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    const file = indexFileSchema.parse(JSON.parse(readFileSync(store.indexPath(), "utf-8")))
    file.entries["fp-ext"] = { fingerprint: "fp-ext", path: ["x"], leaf: { output: "x" }, updatedAt: new Date().toISOString() }
    writeExternally(store.indexPath(), file)
    expect(store.getFingerprint("fp-ext")?.leaf.output).toBe("x")
  })

  it("rejects an invalid entry without changing the index", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    expect(() => store.setFingerprint("fp-bad", { path: "nope" as any, leaf: { output: "a" } })).toThrow()
    expect(store.getFingerprint("fp-bad")).toBeUndefined()
    expect(store.getFingerprint("fp-1")?.leaf.output).toBe("a")
  })

  it("mutating a loaded index does not change the cached one", () => {
    store.setFingerprint("fp-1", { path: ["a"], leaf: { output: "a" } })
    const loaded = store.loadIndex()
    delete loaded.entries["fp-1"]
    expect(store.getFingerprint("fp-1")?.leaf.output).toBe("a")
  })
})

describe("GraphStore nodes cache", () => {
  it("does not re-parse the nodes file on repeated loads", () => {
    store.loadNodes() // seeds the file
    store.loadNodes()
    const parse = vi.spyOn(nodesFileSchema, "safeParse")
    for (let i = 0; i < 5; i++) store.loadNodes()
    expect(parse).not.toHaveBeenCalled()
  })

  it("mutating loaded nodes does not change the cached copy", () => {
    const count = store.loadNodes().nodes.length
    expect(count).toBeGreaterThan(0)
    store.loadNodes().nodes.length = 0
    expect(store.loadNodes().nodes.length).toBe(count)
  })

  it("picks up a nodes file rewritten by another process", () => {
    const file = store.loadNodes()
    writeExternally(store.nodesPath(), { ...file, nodes: file.nodes.slice(0, 1) })
    expect(store.loadNodes().nodes.length).toBe(1)
  })
})
