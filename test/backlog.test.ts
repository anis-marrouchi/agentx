import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { BacklogStore, sourceBacklogId } from "../src/business/backlog-store"
import { BacklogWorkSource } from "../src/business/work-pool"

let tmp: string
let storePath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agentx-backlog-"))
  storePath = join(tmp, "backlog.json")
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("BacklogStore", () => {
  it("starts empty and round-trips an item", () => {
    const store = new BacklogStore(storePath)
    expect(store.exists()).toBe(false)
    expect(store.list()).toEqual([])

    const item = store.add({
      id: "manual:1",
      title: "First task",
      labels: ["bug"],
      status: "todo",
    })

    expect(item.createdAt).toBeTruthy()
    expect(item.updatedAt).toBeTruthy()
    expect(store.exists()).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.findById("manual:1")?.title).toBe("First task")

    // Markdown view is regenerated alongside the JSON.
    expect(existsSync(store.mdPath())).toBe(true)
    expect(readFileSync(store.mdPath(), "utf-8")).toMatch(/First task/)
  })

  it("rejects duplicate ids and addMany skips them", () => {
    const store = new BacklogStore(storePath)
    store.add({ id: "x:1", title: "A", labels: [], status: "todo" })
    expect(() => store.add({ id: "x:1", title: "dup", labels: [], status: "todo" })).toThrow()

    const added = store.addMany([
      { id: "x:1", title: "still-dup", labels: [], status: "todo" },
      { id: "x:2", title: "B", labels: [], status: "todo" },
    ])
    expect(added).toHaveLength(1)
    expect(added[0].id).toBe("x:2")
  })

  it("updates preserve createdAt and bump updatedAt", async () => {
    const store = new BacklogStore(storePath)
    const a = store.add({ id: "x:1", title: "A", labels: [], status: "todo" })
    await new Promise((r) => setTimeout(r, 5))
    const b = store.update("x:1", { status: "doing", assignee: "alice" })
    expect(b.createdAt).toBe(a.createdAt)
    expect(b.updatedAt).not.toBe(a.updatedAt)
    expect(b.status).toBe("doing")
    expect(b.assignee).toBe("alice")
  })

  it("sourceBacklogId is stable per source ref", () => {
    const id = sourceBacklogId({ type: "gitlab", project: "g/p", iid: 42, url: "x" })
    expect(id).toBe("gitlab:g/p:42")
  })
})

describe("BacklogWorkSource (structured store)", () => {
  it("listOpen returns todo+doing+blocked but not done", async () => {
    const store = new BacklogStore(storePath)
    store.add({ id: "x:1", title: "A", labels: [], status: "todo", assignee: "alice" })
    store.add({ id: "x:2", title: "B", labels: [], status: "doing", assignee: "alice" })
    store.add({ id: "x:3", title: "C", labels: [], status: "done", assignee: "alice" })
    store.add({ id: "x:4", title: "D", labels: [], status: "todo", assignee: "bob" })

    const ws = new BacklogWorkSource(storePath)
    const items = await ws.listOpen("alice")
    const ids = items.map((i) => i.id).sort()
    expect(ids).toEqual(["x:1", "x:2"])
  })

  it("listOpen includes unassigned items (anyone can claim)", async () => {
    const store = new BacklogStore(storePath)
    store.add({ id: "x:1", title: "A", labels: [], status: "todo" })
    const ws = new BacklogWorkSource(storePath)
    const items = await ws.listOpen("alice")
    expect(items.map((i) => i.id)).toContain("x:1")
  })

  it("report transitions status; done items leave listOpen", async () => {
    const store = new BacklogStore(storePath)
    store.add({ id: "x:1", title: "A", labels: [], status: "doing", assignee: "alice" })
    const ws = new BacklogWorkSource(storePath)
    await ws.report("x:1", { status: "done" })
    expect(store.findById("x:1")?.status).toBe("done")
    const open = await ws.listOpen("alice")
    expect(open).toHaveLength(0)
  })

  it("falls back to legacy markdown when no JSON store exists", async () => {
    const fs = await import("fs")
    const legacyPath = join(tmp, "legacy-backlog.md")
    fs.writeFileSync(legacyPath, "- [ ] @alice Legacy task\n- [x] @alice Done one\n")
    const ws = new BacklogWorkSource(legacyPath)
    const items = await ws.listOpen("alice")
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Legacy task")
  })
})
