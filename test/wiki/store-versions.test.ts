import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { WikiHub } from "../../src/wiki/hub"
import { LockBusyError } from "../../src/wiki/facts/ledger-file"
import type { WikiArticleMeta } from "../../src/wiki/types"

// Two writes of one page inside the same millisecond must keep two
// versions (#873).

let dir: string
let hub: WikiHub

const PATH = "people/sam-rivera.md"

function meta(): WikiArticleMeta {
  return {
    title: "Sam Rivera", type: "person", tags: ["venue"], owner: "ops", access: "private",
    created: "2026-10-01", lastUpdated: "2026-10-01", sources: ["e1"],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-versions-"))
  hub = new WikiHub(dir, () => {}, "graph")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-09T08:00:00.123Z"))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe("WikiStore versions", () => {
  it("keeps one version per write when writes share a millisecond", () => {
    const store = hub.getAgentWiki("ops")
    for (let i = 0; i <= 12; i++) store.writeArticle(PATH, meta(), `body ${i}`, "ops")

    const versions = store.getVersions(PATH)
    expect(versions).toHaveLength(12)
    expect(new Set(versions.map(v => v.timestamp)).size).toBe(12)
    // Newest first, counter order past 9 included.
    expect(versions.map(v => readFileSync(v.path, "utf-8")).map(c => c.trim().split("\n").pop()))
      .toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(i => `body ${i}`))
  })

  it("restores the exact version named, not a suffixed one that shares its prefix", () => {
    const store = hub.getAgentWiki("ops")
    store.writeArticle(PATH, meta(), "first", "ops")
    store.writeArticle(PATH, meta(), "second", "ops")
    store.writeArticle(PATH, meta(), "third", "ops")

    const oldest = store.getVersions(PATH).at(-1)!.timestamp
    expect(store.restoreVersion(PATH, oldest)).toBe(true)
    expect(store.readArticle(PATH)?.content.trim()).toBe("first")
  })

  it("restores under the page's lock and refuses while another process holds it", () => {
    const store = hub.getAgentWiki("ops")
    store.writeArticle(PATH, meta(), "first", "ops")
    store.writeArticle(PATH, meta(), "second", "ops")
    const oldest = store.getVersions(PATH).at(-1)!.timestamp
    // The lock's wait runs on the real clock.
    vi.useRealTimers()

    mkdirSync(join(store.baseDir, "_locks", "people"), { recursive: true })
    writeFileSync(join(store.baseDir, "_locks", `${PATH}.lock`), "")
    store.lockWaitMs = 100
    expect(() => store.restoreVersion(PATH, oldest)).toThrow(LockBusyError)
    expect(store.readArticle(PATH)?.content.trim()).toBe("second")
  })
})
