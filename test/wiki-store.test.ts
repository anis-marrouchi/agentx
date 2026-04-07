import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { WikiStore } from "../src/wiki/store"
import { mkdirSync, rmSync, existsSync } from "fs"
import { resolve } from "path"

const TEST_DIR = resolve(__dirname, "../.test-wiki")

describe("WikiStore", () => {
  let store: WikiStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new WikiStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe("entries", () => {
    it("adds and retrieves raw entries", () => {
      store.addEntry({
        id: "test-1",
        date: "2026-04-06",
        agentId: "atlas",
        source: "telegram",
        content: "Hello from Atlas",
      })

      const entries = store.listEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0].agentId).toBe("atlas")
      expect(entries[0].content).toBe("Hello from Atlas")
    })

    it("filters entries by agent", () => {
      store.addEntry({ id: "a1", date: "2026-04-06", agentId: "atlas", source: "telegram", content: "from atlas" })
      store.addEntry({ id: "n1", date: "2026-04-06", agentId: "nadia", source: "telegram", content: "from nadia" })

      const atlas = store.listEntries({ agentId: "atlas" })
      expect(atlas).toHaveLength(1)
      expect(atlas[0].agentId).toBe("atlas")
    })

    it("filters entries by date", () => {
      store.addEntry({ id: "e1", date: "2026-04-05", agentId: "a", source: "t", content: "old" })
      store.addEntry({ id: "e2", date: "2026-04-06", agentId: "a", source: "t", content: "new" })

      const recent = store.listEntries({ after: "2026-04-06" })
      expect(recent).toHaveLength(1)
      expect(recent[0].content).toBe("new")
    })
  })

  describe("articles", () => {
    it("writes and reads articles", () => {
      const meta = {
        title: "Test Article",
        type: "concept",
        owner: "atlas",
        access: "public" as const,
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: ["test-1"],
      }

      store.writeArticle("concepts/test.md", meta, "This is a test article.", "atlas")
      const article = store.readArticle("concepts/test.md")

      expect(article).not.toBeNull()
      expect(article!.meta.title).toBe("Test Article")
      expect(article!.content).toBe("This is a test article.")
    })

    it("enforces write permissions", () => {
      const meta = {
        title: "Private",
        type: "concept",
        owner: "atlas",
        access: "private" as const,
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }

      store.writeArticle("concepts/mine.md", meta, "secret", "atlas")
      const denied = store.writeArticle("concepts/mine.md", meta, "hacked", "nadia")
      expect(denied).toBe(false)
    })

    it("enforces read permissions", () => {
      const meta = {
        title: "Private",
        type: "concept",
        owner: "atlas",
        access: "private" as const,
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }

      store.writeArticle("concepts/secret.md", meta, "secret content", "atlas")

      expect(store.readArticleAs("concepts/secret.md", "atlas")).not.toBeNull()
      expect(store.readArticleAs("concepts/secret.md", "nadia")).toBeNull()
    })

    it("allows shared access", () => {
      const meta = {
        title: "Shared",
        type: "project",
        owner: "atlas",
        access: "shared" as const,
        sharedWith: ["nadia"],
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }

      store.writeArticle("projects/shared.md", meta, "shared content", "atlas")

      expect(store.readArticleAs("projects/shared.md", "atlas")).not.toBeNull()
      expect(store.readArticleAs("projects/shared.md", "nadia")).not.toBeNull()
      expect(store.readArticleAs("projects/shared.md", "devops")).toBeNull()
    })
  })

  describe("search", () => {
    it("finds articles by keyword", () => {
      store.writeArticle("concepts/deploy.md", {
        title: "Deployment Guide",
        type: "concept",
        owner: "atlas",
        access: "public",
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }, "How to deploy the MTGL application to staging.", "atlas")

      const results = store.search("deploy", "atlas")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].meta.title).toBe("Deployment Guide")
    })

    it("respects permissions in search", () => {
      store.writeArticle("concepts/secret.md", {
        title: "Secret Plan",
        type: "concept",
        owner: "atlas",
        access: "private",
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }, "Top secret deployment plan", "atlas")

      expect(store.search("secret", "atlas")).toHaveLength(1)
      expect(store.search("secret", "nadia")).toHaveLength(0)
    })
  })

  describe("index", () => {
    it("rebuilds index", () => {
      store.writeArticle("concepts/test.md", {
        title: "Test",
        type: "concept",
        owner: "atlas",
        access: "public",
        created: "2026-04-06",
        lastUpdated: "2026-04-06",
        related: [],
        sources: [],
      }, "content", "atlas")

      const index = store.rebuildIndex()
      expect(index.articles).toHaveLength(1)
      expect(index.articles[0].title).toBe("Test")
      expect(existsSync(resolve(TEST_DIR, "WIKI.md"))).toBe(true)
    })
  })

  describe("stats", () => {
    it("returns correct stats", () => {
      store.addEntry({ id: "e1", date: "2026-04-06", agentId: "atlas", source: "t", content: "x" })
      store.writeArticle("concepts/a.md", {
        title: "A", type: "concept", owner: "atlas", access: "public",
        created: "2026-04-06", lastUpdated: "2026-04-06", related: [], sources: [],
      }, "content", "atlas")

      const s = store.stats()
      expect(s.totalEntries).toBe(1)
      expect(s.totalArticles).toBe(1)
      expect(s.articlesByType.concept).toBe(1)
      expect(s.articlesByOwner.atlas).toBe(1)
    })
  })
})

describe("WikiStore - log", () => {
  let store: WikiStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new WikiStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("creates and appends to log.md", () => {
    store.appendLog("ingest", "test entry from atlas")
    store.appendLog("create", "New article: MTGL Deploy")

    const log = store.getLog()
    expect(log).toHaveLength(2)
    expect(log[0]).toContain("ingest")
    expect(log[1]).toContain("MTGL Deploy")
  })

  it("logs ingest operations automatically", () => {
    store.addEntry({ id: "e1", date: "2026-04-06", agentId: "atlas", source: "telegram", content: "test" })

    const log = store.getLog()
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]).toContain("ingest")
    expect(log[0]).toContain("atlas")
  })
})

describe("WikiStore - wikilinks and backlinks", () => {
  let store: WikiStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new WikiStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("extracts wikilinks", () => {
    const links = store.extractWikilinks("See [[MTGL Deploy]] and [[KSI Architecture]]")
    expect(links).toEqual(["MTGL Deploy", "KSI Architecture"])
  })

  it("builds backlinks index", () => {
    store.writeArticle("concepts/deploy.md", {
      title: "Deploy Guide", type: "concept", owner: "atlas", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: [],
    }, "How to deploy. See [[MTGL Project]].", "atlas")

    store.writeArticle("projects/mtgl.md", {
      title: "MTGL Project", type: "project", owner: "atlas", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: [],
    }, "The MTGL project.", "atlas")

    const backlinks = store.buildBacklinks()
    expect(backlinks["MTGL Project"]).toContain("concepts/deploy.md")
  })
})

describe("WikiStore - lint", () => {
  let store: WikiStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new WikiStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("detects broken wikilinks", () => {
    store.writeArticle("test.md", {
      title: "Test", type: "concept", owner: "a", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: [],
    }, "See [[Nonexistent Page]]", "a")

    const issues = store.lint()
    expect(issues.some(i => i.type === "broken-link")).toBe(true)
  })

  it("detects orphan articles", () => {
    store.writeArticle("orphan.md", {
      title: "Orphan", type: "concept", owner: "a", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: [],
    }, "No one links here", "a")

    const issues = store.lint()
    expect(issues.some(i => i.type === "orphan")).toBe(true)
  })

  it("detects unsourced articles", () => {
    store.writeArticle("unsourced.md", {
      title: "Unsourced", type: "concept", owner: "a", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: [],
    }, "Content without sources", "a")

    const issues = store.lint()
    expect(issues.some(i => i.type === "unsourced")).toBe(true)
  })
})

describe("WikiStore - absorb", () => {
  let store: WikiStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new WikiStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("finds unabsorbed entries", () => {
    store.addEntry({ id: "e1", date: "2026-04-06", agentId: "a", source: "t", content: "hello" })
    store.addEntry({ id: "e2", date: "2026-04-06", agentId: "a", source: "t", content: "world" })

    // e1 is referenced by an article, e2 is not
    store.writeArticle("test.md", {
      title: "Test", type: "concept", owner: "a", access: "public",
      created: "2026-04-06", lastUpdated: "2026-04-06",
      related: [], sources: ["e1"],
    }, "Content from e1", "a")

    const unabsorbed = store.getUnabsorbedEntries()
    expect(unabsorbed).toHaveLength(1)
    expect(unabsorbed[0].id).toBe("e2")
  })

  it("builds absorb prompt", () => {
    store.addEntry({ id: "e1", date: "2026-04-06", agentId: "atlas", source: "telegram", content: "Deploy went well" })

    const prompt = store.buildAbsorbPrompt()
    expect(prompt).not.toBeNull()
    expect(prompt).toContain("1 unprocessed entries")
    expect(prompt).toContain("Deploy went well")
  })

  it("returns null when no entries to absorb", () => {
    expect(store.buildAbsorbPrompt()).toBeNull()
  })
})

describe("WikiStore - schema", () => {
  it("creates _schema.md on init", () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    const store = new WikiStore(TEST_DIR)
    expect(existsSync(resolve(TEST_DIR, "_schema.md"))).toBe(true)
    rmSync(TEST_DIR, { recursive: true, force: true })
  })
})
