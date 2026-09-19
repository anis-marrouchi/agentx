import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiStore } from "../src/wiki/store"

let dir: string
let store: WikiStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wiki-meta-")); store = new WikiStore(dir) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("raw entry meta round-trip", () => {
  it("reads back intentPath, which absorb needs for graphPath", () => {
    // The regression: addEntry wrote intentPath into the frontmatter and
    // parseEntry returned no meta at all, so `wiki absorb` could never
    // propagate it and every article compiled with graphPath undefined —
    // zeroing 0.6 of the hybrid retrieval score.
    store.addEntry({
      id: "e1", date: "2026-09-02", agentId: "devops-agent", source: "gitlab",
      sourceContext: "Saber Salhi", content: "User: something\n\nAgent: reply",
      meta: { intentPath: ["code", "set.constraints"], intentPathLabel: "code › set.constraints" },
    })
    const [entry] = store.listEntries()
    expect(entry.meta?.intentPath).toEqual(["code", "set.constraints"])
    expect(entry.meta?.intentPathLabel).toBe("code › set.constraints")
  })

  it("still parses the five named fields", () => {
    store.addEntry({
      id: "e2", date: "2026-09-03", agentId: "atlas", source: "telegram",
      sourceContext: "group", content: "body text",
    })
    const [e] = store.listEntries()
    expect({ id: e.id, date: e.date, agentId: e.agentId, source: e.source, sourceContext: e.sourceContext })
      .toEqual({ id: "e2", date: "2026-09-03", agentId: "atlas", source: "telegram", sourceContext: "group" })
    expect(e.content).toBe("body text")
  })

  it("leaves meta undefined when there is none, rather than an empty object", () => {
    store.addEntry({ id: "e3", date: "2026-09-04", agentId: "a", source: "cli", content: "x" })
    expect(store.listEntries()[0].meta).toBeUndefined()
  })

  it("keeps a non-JSON meta value as a string instead of dropping it", () => {
    store.addEntry({
      id: "e4", date: "2026-09-05", agentId: "a", source: "cli", content: "x",
      meta: { note: "plain text, not json" },
    })
    expect(store.listEntries()[0].meta?.note).toBe("plain text, not json")
  })
})
