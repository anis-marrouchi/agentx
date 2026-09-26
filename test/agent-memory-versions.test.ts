import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { AgentMemory } from "../src/agents/agent-memory"
import { MAX_VERSIONS, MemoryConflictError } from "../src/agents/memory-versions"

let root: string
const store = () => new AgentMemory({ baseDir: root })
const base = { agentId: "atlas", type: "feedback" as const, name: "no-mock-db", description: "Use a real database in tests" }

beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), "agentx-mem-")); mkdirSync(root, { recursive: true }) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("AgentMemory — history", () => {
  it("keeps the replaced version on every save, newest first", () => {
    const s = store()
    s.save({ ...base, body: "v1" })
    s.save({ ...base, body: "v2" })
    s.save({ ...base, body: "v3" })
    expect(s.get("atlas", "no-mock-db")!.body).toBe("v3")
    expect(s.versions("atlas", "no-mock-db").map((v) => v.record?.body)).toEqual(["v2", "v1"])
  })

  it("keeps a removed memory in history and can restore it", () => {
    const s = store()
    s.save({ ...base, body: "keep me" })
    expect(s.remove("atlas", "no-mock-db")).toBe(true)
    expect(s.get("atlas", "no-mock-db")).toBeNull()
    const [v] = s.versions("atlas", "no-mock-db")
    expect(v.record?.body).toBe("keep me")
    const restored = s.restore("atlas", "no-mock-db", v.id, { author: "operator" })
    expect(restored?.body).toBe("keep me")
    expect(s.get("atlas", "no-mock-db")?.author).toBe("operator")
  })

  it("a restore is itself undoable", () => {
    const s = store()
    s.save({ ...base, body: "old" })
    s.save({ ...base, body: "new" })
    const old = s.versions("atlas", "no-mock-db").find((v) => v.record?.body === "old")!
    s.restore("atlas", "no-mock-db", old.id)
    expect(s.get("atlas", "no-mock-db")!.body).toBe("old")
    expect(s.versions("atlas", "no-mock-db").some((v) => v.record?.body === "new")).toBe(true)
  })

  it("prunes history past MAX_VERSIONS", () => {
    const s = store()
    for (let i = 0; i <= MAX_VERSIONS + 5; i++) s.save({ ...base, body: `v${i}` })
    expect(s.versions("atlas", "no-mock-db")).toHaveLength(MAX_VERSIONS)
  })

  it("returns null when restoring a version that doesn't exist", () => {
    const s = store()
    s.save({ ...base, body: "x" })
    expect(s.restore("atlas", "no-mock-db", "1999-01-01T00-00-00-000Z")).toBeNull()
  })

  it("history and temp files never show up as memories or in MEMORY.md", () => {
    const s = store()
    s.save({ ...base, body: "a" })
    s.save({ ...base, body: "b" })
    expect(s.list("atlas").map((r) => r.name)).toEqual(["no_mock_db"])
    const dir = resolve(root, "agent-memory", "atlas")
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
    expect(s.indexMarkdown("atlas").match(/no_mock_db/g)).toHaveLength(1)
  })
})

describe("AgentMemory — conditional writes", () => {
  it("returns an etag that changes with the content", () => {
    const s = store()
    const a = s.save({ ...base, body: "one" })
    expect(a.etag).toMatch(/^[0-9a-f]{16}$/)
    expect(s.get("atlas", "no-mock-db")!.etag).toBe(a.etag)
    const b = s.save({ ...base, body: "two" })
    expect(b.etag).not.toBe(a.etag)
  })

  it("refuses to overwrite a version the caller hasn't seen", () => {
    const s = store()
    const first = s.save({ ...base, body: "one" })
    s.save({ ...base, body: "someone else's edit" })
    expect(() => s.save({ ...base, body: "mine" }, { ifMatch: first.etag })).toThrow(MemoryConflictError)
    expect(s.get("atlas", "no-mock-db")!.body).toBe("someone else's edit")
  })

  it("reports the current etag on conflict so the caller can re-read and retry", () => {
    const s = store()
    s.save({ ...base, body: "one" })
    const now = s.save({ ...base, body: "two" })
    try {
      s.save({ ...base, body: "x" }, { ifMatch: "0000000000000000" })
      expect.unreachable()
    } catch (e) {
      expect((e as MemoryConflictError).currentEtag).toBe(now.etag)
    }
  })

  it("If-None-Match: * creates but never overwrites", () => {
    const s = store()
    s.save({ ...base, body: "first" }, { ifNoneMatch: "*" })
    expect(() => s.save({ ...base, body: "second" }, { ifNoneMatch: "*" })).toThrow(MemoryConflictError)
  })

  it("remove honours ifMatch", () => {
    const s = store()
    const a = s.save({ ...base, body: "one" })
    s.save({ ...base, body: "two" })
    expect(() => s.remove("atlas", "no-mock-db", { ifMatch: a.etag })).toThrow(MemoryConflictError)
    expect(s.get("atlas", "no-mock-db")).not.toBeNull()
  })

  it("append adds to the current body in one step", () => {
    const s = store()
    s.append({ ...base, body: "first lesson" })
    s.append({ ...base, body: "second lesson" })
    expect(s.get("atlas", "no-mock-db")!.body).toBe("first lesson\n\nsecond lesson")
  })
})

describe("AgentMemory — provenance", () => {
  it("records author and task in frontmatter and reads them back", () => {
    const s = store()
    s.save({ ...base, body: "x", author: "atlas", taskId: "1700000000000-abc123" })
    const rec = s.get("atlas", "no-mock-db")!
    expect(rec.author).toBe("atlas")
    expect(rec.taskId).toBe("1700000000000-abc123")
    const file = readFileSync(resolve(root, "agent-memory", "atlas", "feedback_no_mock_db.md"), "utf-8")
    expect(file).toContain("author: atlas")
    expect(file).toContain("task: 1700000000000-abc123")
  })

  it("keeps files without provenance readable (older memories)", () => {
    const s = store()
    s.save({ ...base, body: "x" })
    const rec = s.get("atlas", "no-mock-db")!
    expect(rec.author).toBeUndefined()
    expect(rec.body).toBe("x")
  })
})
