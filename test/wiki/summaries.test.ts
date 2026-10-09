import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { WikiStore } from "../../src/wiki/store"
import {
  SUMMARY_MAX_WORDS,
  clipSummary,
  freshSummaries,
  loadSummaries,
  parseSummaryReply,
  summarizeStore,
} from "../../src/wiki/summaries"

// Page summaries (#855): one line per page in _summaries.json, written by
// a model in batches, kept with a hash of the page so only new and changed
// pages are summarised again. The pages themselves are never touched.

describe("page summaries", () => {
  let dir: string
  let store: WikiStore
  const write = (path: string, title: string, content: string) =>
    store.writeArticle(path, {
      title, type: "project", related: [], tags: [], owner: "ops", access: "public",
      created: "2026-10-01", lastUpdated: "2026-10-01", sources: [],
    }, content, "ops")

  // A model stub that summarises each page as "about <title>".
  let calls: string[]
  const run = async (prompt: string) => {
    calls.push(prompt)
    const ids = [...prompt.matchAll(/^### (p\d+): (.+?)(?: \[\w+\])?$/gm)]
    return JSON.stringify(Object.fromEntries(ids.map((m) => [m[1], `about ${m[2]}`])))
  }

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "wiki-summaries-"))
    store = new WikiStore(dir, () => {})
    calls = []
    write("projects/billing.md", "Billing Service", "Handles invoices. Tracked in example/billing#12.")
    write("projects/voice.md", "Voice App", "The phone app.")
    write("projects/site.md", "Website", "The public site.")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("summarises every page in batches and leaves the pages untouched", async () => {
    const before = readFileSync(resolve(dir, "projects/billing.md"), "utf-8")
    const r = await summarizeStore(store, { run, batchSize: 2 })
    expect(r).toMatchObject({ pages: 3, stale: 3, written: 3, failed: 0, batches: 2 })
    expect(calls).toHaveLength(2)
    expect(loadSummaries(store).pages["projects/voice.md"].summary).toBe("about Voice App")
    expect(readFileSync(resolve(dir, "projects/billing.md"), "utf-8")).toBe(before)
  })

  it("skips unchanged pages and summarises a changed one again", async () => {
    await summarizeStore(store, { run })
    calls = []
    const again = await summarizeStore(store, { run })
    expect(again.stale).toBe(0)
    expect(calls).toHaveLength(0)

    write("projects/voice.md", "Voice App", "The phone app, now with offline mode.")
    const articles = store.listAllArticles().filter((a) => !a.path.includes("/_versions/"))
    expect(freshSummaries(articles, loadSummaries(store)).has("projects/voice.md")).toBe(false)
    const changed = await summarizeStore(store, { run })
    expect(changed).toMatchObject({ stale: 1, written: 1 })
    expect(calls[0]).toContain("offline mode")
  })

  it("drops the line of a deleted page", async () => {
    await summarizeStore(store, { run })
    rmSync(resolve(dir, "projects/site.md"))
    const r = await summarizeStore(store, { run })
    expect(r.removed).toBe(1)
    expect(loadSummaries(store).pages["projects/site.md"]).toBeUndefined()
  })

  it("resumes: a run cut short by --limit leaves the rest for the next run", async () => {
    const first = await summarizeStore(store, { run, limit: 1 })
    expect(first.written).toBe(1)
    const second = await summarizeStore(store, { run })
    expect(second).toMatchObject({ stale: 2, written: 2 })
  })

  it("a failed batch writes nothing and counts its pages as failed", async () => {
    const r = await summarizeStore(store, { run: async () => { throw new Error("down") }, batchSize: 10 })
    expect(r).toMatchObject({ written: 0, failed: 3 })
    expect(Object.keys(loadSummaries(store).pages)).toHaveLength(0)
  })

  it("a dry run calls no model", async () => {
    const r = await summarizeStore(store, { run, dryRun: true })
    expect(r.stale).toBe(3)
    expect(calls).toHaveLength(0)
  })
})

describe("reading the summary reply", () => {
  it("keeps known page ids and clips long lines", () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")
    const out = parseSummaryReply(`Here: {"p1": "Billing service", "p2": "${long}", "p9": "unknown", "p3": 4}`, 3)
    expect(out.get(0)).toBe("Billing service")
    expect(out.get(1)!.split(" ")).toHaveLength(SUMMARY_MAX_WORDS)
    expect(out.has(2)).toBe(false)
    expect(out.size).toBe(2)
  })

  it("returns nothing for a reply that is not JSON", () => {
    expect(parseSummaryReply("no", 2).size).toBe(0)
  })

  it("clipSummary folds whitespace", () => {
    expect(clipSummary("  a\n b  ")).toBe("a b")
  })
})
