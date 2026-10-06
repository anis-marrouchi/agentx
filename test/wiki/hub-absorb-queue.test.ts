import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { ABSORB_REVIEWED_FILE, WikiHub } from "../../src/wiki/hub"

// #762: an entry absorb read but did not cite must leave the queue, or a
// backfill re-reads the same oldest entries on every run.
describe("WikiHub absorb queue", () => {
  let dir: string
  let hub: WikiHub
  const silent = () => {}

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "wiki-hub-queue-"))
    hub = new WikiHub(dir, silent, "graph")
    for (let i = 1; i <= 5; i++) {
      hub.getSharedStore().addEntry({
        id: `e${i}`, date: `2026-04-0${i}`, agentId: "a", source: "t", content: `entry ${i}`,
      })
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const queue = (h: WikiHub = hub) => h.getUnabsorbedEntries("a").map((e) => e.id)

  it("drops cited and passed-over entries, so the next batch moves on", () => {
    // First run reads e1..e3 and cites only e1.
    hub.getAgentWiki("a").writeArticle("concepts/one.md", {
      title: "One", tags: [], owner: "a", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06", sources: ["e1"],
    }, "From e1", "a")
    expect(queue()).toEqual(["e2", "e3", "e4", "e5"])

    hub.markEntriesReviewed("a", ["e1", "e2", "e3"])
    expect(queue()).toEqual(["e4", "e5"])
    expect(hub.summary().find((s) => s.agentId === "a")?.unabsorbed).toBe(2)
  })

  it("persists across hub instances and merges batches", () => {
    hub.markEntriesReviewed("a", ["e1"])
    hub.markEntriesReviewed("a", ["e2"])
    expect(queue(new WikiHub(dir, silent, "graph"))).toEqual(["e3", "e4", "e5"])
  })

  it("keeps the ledger per mode", () => {
    hub.markEntriesReviewed("a", ["e1", "e2"])
    expect(queue(new WikiHub(dir, silent, "flat"))).toEqual(["e1", "e2", "e3", "e4", "e5"])
  })

  it("treats a corrupt ledger as empty", () => {
    hub.markEntriesReviewed("a", ["e1"])
    writeFileSync(resolve(dir, "agents", "a", "graph", ABSORB_REVIEWED_FILE), "{not json")
    expect(queue()).toEqual(["e1", "e2", "e3", "e4", "e5"])
  })
})
