import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { WikiStore } from "../src/wiki/store"

// The catalog injected on every fresh session parsed the frontmatter of
// every article the agent can see, ten thousand files on a mature wiki.
// The walk stays (names, mtimes, sizes); the parse only repeats after a
// change.

let tmp: string
let store: WikiStore
const meta = (title: string) => ({
  title, tags: ["concept"], owner: "atlas", access: "public" as const,
  created: "2026-04-06", lastUpdated: "2026-04-06", sources: [],
})

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-wiki-cat-"))
  store = new WikiStore(tmp)
  store.writeArticle("concepts/a.md", meta("A"), "alpha", "atlas")
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe("WikiStore.listArticles cache", () => {
  it("does not re-read unchanged articles", () => {
    expect(store.listArticles("atlas").map((a) => a.meta.title)).toEqual(["A"])
    const read = vi.spyOn(store, "readArticle")
    for (let i = 0; i < 3; i++) expect(store.listArticles("atlas")).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
  })

  it("re-reads after an article is written, edited externally or removed", () => {
    store.listArticles("atlas")
    store.writeArticle("concepts/b.md", meta("B"), "beta", "atlas")
    expect(store.listArticles("atlas").map((a) => a.meta.title).sort()).toEqual(["A", "B"])
    const file = path.join(tmp, "concepts/a.md")
    writeFileSync(file, "---\ntitle: A2\ntags: [concept]\nowner: atlas\naccess: public\ncreated: 2026-04-06\nlastUpdated: 2026-04-06\nsources: []\n---\nalpha two\n")
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    expect(store.listArticles("atlas").map((a) => a.meta.title).sort()).toEqual(["A2", "B"])
    rmSync(path.join(tmp, "concepts/b.md"))
    expect(store.listArticles("atlas").map((a) => a.meta.title)).toEqual(["A2"])
  })

  it("keeps per-agent visibility separate", () => {
    store.writeArticle("concepts/p.md", { ...meta("P"), access: "private" as const }, "mine", "atlas")
    expect(store.listArticles("atlas").length).toBeGreaterThan(store.listArticles("marketing").length)
  })
})
