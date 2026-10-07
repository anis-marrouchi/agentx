import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { WikiStore } from "../../src/wiki/store"
import { catalogPool, retrieveArticles } from "../../src/wiki/query"
import { buildAbsorbPrompt } from "../../src/wiki/prompts"
import {
  absorbTargetPath,
  droppedFacts,
  extractFacts,
  findCoveringArticles,
  renderCoveringBlock,
} from "../../src/wiki/absorb-context"

// #801. In the 2026-10-07 A/B one model rewrote an event article it had
// never read and lost the commit, the test count and the review URL; the
// other filed a second article for the same event.

const reviewArticle = [
  "The review of the [[Voice App]] login fix landed in commit 1a01e02.",
  "",
  "- 48 tests pass, 2 skipped.",
  "- Review: https://code.example.test/reviews/311",
  "- Merged on 2026-10-06 by [[Jane Doe]].",
].join("\n")

describe("drop-guard", () => {
  it("extracts commits, links and numbers", () => {
    const facts = extractFacts(reviewArticle)
    expect(facts.commits).toEqual(["1a01e02"])
    expect(facts.urls).toEqual(["https://code.example.test/reviews/311"])
    expect(facts.wikilinks).toEqual(["Voice App", "Jane Doe"])
    expect(facts.numbers).toEqual(expect.arrayContaining(["48", "2", "2026-10-06"]))
    // The URL's 311 is part of the link, not a separate number.
    expect(facts.numbers).not.toContain("311")
  })

  it("refuses the A/B rewrite that lost the commit, test count and review URL", () => {
    const rewrite = [
      "The [[Voice App]] login fix was reviewed and merged on 2026-10-06 by [[Jane Doe]].",
      "Tests pass; 2 were skipped.",
    ].join("\n")
    expect(droppedFacts(reviewArticle, rewrite)).toEqual([
      "commit 1a01e02",
      "link https://code.example.test/reviews/311",
      "number 48",
    ])
  })

  it("accepts a restructured rewrite that keeps every fact", () => {
    const rewrite = [
      "## Identity",
      "Code review of the [[voice app]] login fix, merged 2026-10-06 by [[Jane Doe]].",
      "",
      "## Outcome",
      "Commit 1a01e02c9f (full hash). 48 tests passed and 2 were skipped.",
      "Review thread: https://code.example.test/reviews/311/.",
      "A follow-up added 5 more tests.",
    ].join("\n")
    expect(droppedFacts(reviewArticle, rewrite)).toEqual([])
  })

  it("does not find a number inside a longer one", () => {
    expect(droppedFacts("Ran 12 checks.", "Ran checks in 2012.")).toEqual(["number 12"])
  })

  it("ignores list numbering and thousands separators", () => {
    const before = "1. Imported 1,234 rows\n2. Done"
    const after = "- Imported 1234 rows\n- Done"
    expect(droppedFacts(before, after)).toEqual([])
  })

  it("does not take words or plain numbers for commit hashes", () => {
    const facts = extractFacts("The page was defaced, ticket 1234567 reopened.")
    expect(facts.commits).toEqual([])
    expect(facts.numbers).toContain("1234567")
  })

  it("passes a first write: nothing to drop", () => {
    expect(droppedFacts("", reviewArticle)).toEqual([])
  })
})

describe("absorbTargetPath", () => {
  const catalog = [{ path: "events/2026-10-06-voice-app-login-review.md", title: "Voice App Login Review" }]

  it("redirects a new path whose title an article already has", () => {
    expect(absorbTargetPath({ path: "events/2026-10-07-voice-app-login-review.md", title: "voice app — login review" }, catalog))
      .toBe("events/2026-10-06-voice-app-login-review.md")
  })

  it("keeps an existing path and a genuinely new article", () => {
    expect(absorbTargetPath({ path: catalog[0].path, title: "Renamed" }, catalog)).toBe(catalog[0].path)
    expect(absorbTargetPath({ path: "people/jane-doe.md", title: "Jane Doe" }, catalog)).toBe("people/jane-doe.md")
  })
})

describe("finding the covering articles", () => {
  let dir: string
  let store: WikiStore
  const seatEnv = "AGENTX_DECISION_SEAT_WIKI_RERANK"
  const prevSeat = process.env[seatEnv]

  const write = (path: string, title: string, content: string, related: string[] = []) =>
    store.writeArticle(path, {
      title, type: path.startsWith("people/") ? "person" : "event", related, tags: [],
      owner: "ops", access: "public", created: "2026-10-06", lastUpdated: "2026-10-06", sources: [],
    }, content, "ops")

  beforeEach(() => {
    // BM25 alone: no rerank backend in tests.
    process.env[seatEnv] = "off"
    dir = mkdtempSync(resolve(tmpdir(), "absorb-context-"))
    store = new WikiStore(dir, () => {})
    write("events/2026-10-06-voice-app-login-review.md", "Voice App Login Review", reviewArticle, ["Jane Doe"])
    write("people/jane-doe.md", "Jane Doe", "Jane Doe maintains the [[Voice App]].")
    write("events/2026-09-01-office-move.md", "Office Move", "The team moved floors.")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevSeat === undefined) delete process.env[seatEnv]
    else process.env[seatEnv] = prevSeat
  })

  it("retrieves the article an entry is about and walks its links", async () => {
    const hits = await retrieveArticles("follow-up on the voice app login review", store, "ops", { pool: catalogPool(store) })
    expect(hits[0].path).toBe("events/2026-10-06-voice-app-login-review.md")
    expect(hits[0].hop).toBe(0)
    expect(hits.map((h) => h.path)).toContain("people/jane-doe.md")
    expect(hits.map((h) => h.path)).not.toContain("events/2026-09-01-office-move.md")
  })

  it("picks nothing for an entry the catalog does not match", async () => {
    expect(await retrieveArticles("zebra quantum", store, "ops")).toEqual([])
  })

  it("merges per-entry hits and puts the full article in the prompt", async () => {
    const entries = [
      { id: "e1", content: "Voice app login review: a reviewer asked for one more test." },
      { id: "e2", content: "The login review for the voice app is closed." },
    ]
    const covering = await findCoveringArticles(entries, store, "ops", catalogPool(store))
    expect(covering[0].path).toBe("events/2026-10-06-voice-app-login-review.md")
    expect(covering[0].entries).toEqual(["e1", "e2"])

    const block = renderCoveringBlock(covering)
    const prompt = buildAbsorbPrompt("graph", "ops", "", [], "ENTRY", 2, "", block)
    expect(prompt).toContain("## Articles already covering these entries")
    expect(prompt).toContain("commit 1a01e02")
    expect(prompt).toContain("https://code.example.test/reviews/311")
    expect(prompt).toContain("SAME path")
  })

  // In the #801 A/B the review article stayed titled "NOT READY" after the
  // entries said it became READY: the prompt told the model to keep the title.
  it("lets an update retitle an article whose status changed", () => {
    const block = renderCoveringBlock([{
      path: "events/pr-198.md", entries: ["e1"], hop: 0, content: "body",
      meta: { title: "AgentX PR #197 Reviewed: NOT READY" } as never,
    }])
    expect(block).not.toContain("SAME title")
    expect(block).toContain("Keep its title unless the entries make it wrong")
  })

  it("an absorb without retrieval is the old absorb", async () => {
    const failing = async () => { throw new Error("index unreadable") }
    expect(await findCoveringArticles([{ id: "e1", content: "x" }], store, "ops", [], { retrieve: failing })).toEqual([])
    expect(renderCoveringBlock([])).toBe("")
  })
})
