import { describe, expect, it } from "vitest"
import { buildWikiContext } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

const store = (articles: Array<{ title: string; type?: string }>) => ({
  baseDir: "/tmp/wiki/agents/a/graph",
  listArticles: () => articles.map((a, i) => ({ meta: { title: a.title, type: a.type }, path: `p${i}.md` })),
}) as never

describe("buildWikiContext", () => {
  it("injects the catalog as content, not as an invitation to go and look", () => {
    const md = buildWikiContext(store([
      { title: "Alex Rivera", type: "person" },
      { title: "Widgets API", type: "project" },
    ]), "a", { catalog: "titles" })
    // The titles themselves must be present — that is the whole change.
    expect(md).toContain("Alex Rivera")
    expect(md).toContain("Widgets API")
    expect(md).toContain("**person**")
    expect(md).toContain("**project**")
  })

  it("claims precedence over the other four knowledge layers", () => {
    const md = buildWikiContext(store([{ title: "X", type: "concept" }]), "a")
    expect(md).toMatch(/single source of truth/i)
    for (const other of ["memory", "skills", "procedures", "patterns"]) {
      expect(md.toLowerCase(), other).toContain(other)
    }
  })

  it("keeps the query command for article bodies", () => {
    const md = buildWikiContext(store([{ title: "X", type: "concept" }]), "a")
    expect(md).toContain("wiki query")
    expect(md).toContain("--agent a")
  })

  it("degrades to counts rather than a truncated list when the corpus is large", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `Person ${i}`, type: "person" }))
    const md = buildWikiContext(store(many), "a", { maxArticles: 10, catalog: "titles" })
    // Seeing the first N names and assuming that is all of them is worse
    // than knowing the count and how to ask.
    expect(md).toContain("50 articles")
    expect(md).not.toContain("Person 7")
  })

  it("lists in full when the corpus fits", () => {
    const md = buildWikiContext(store([{ title: "Only One", type: "person" }]), "a", { maxArticles: 10, catalog: "titles" })
    expect(md).toContain("Only One")
  })

  it("is empty for an agent with no wiki, so no dead section is rendered", () => {
    expect(buildWikiContext(store([]), "a")).toBe("")
  })

  it("survives a store that throws rather than failing the turn", () => {
    const broken = { baseDir: "/tmp/w", listArticles: () => { throw new Error("no wiki") } } as never
    expect(buildWikiContext(broken, "a")).toBe("")
  })

  it("groups untyped articles rather than dropping them", () => {
    const md = buildWikiContext(store([{ title: "Loose Note" }]), "a", { catalog: "titles" })
    expect(md).toContain("untyped")
    expect(md).toContain("Loose Note")
  })
})

describe("buildWikiContext counts (#2002)", () => {
  const corpus = store([
    { title: "Alex Rivera", type: "person" },
    { title: "Sam Lee", type: "person" },
    { title: "Widgets API", type: "project" },
  ])

  it("lists counts per type and no titles by default", () => {
    const md = buildWikiContext(corpus, "a")
    expect(md).toContain("**person** — 2 articles")
    expect(md).toContain("**project** — 1 article")
    expect(md).not.toContain("Alex Rivera")
    expect(md).not.toContain("Widgets API")
  })

  it("keeps the header, the query command, the facts rule, and adds the search command", () => {
    const md = buildWikiContext(corpus, "a")
    expect(md).toMatch(/single source of truth/i)
    expect(md).toContain("wiki query")
    expect(md).toContain("--agent a")
    expect(md).toContain("wiki facts list")
    expect(md).toContain("wiki search")
  })

  it("is shorter than the title list for a corpus the size of the fleet's", () => {
    const big = store(Array.from({ length: 65 }, (_, i) => ({ title: `Hasanah Webapp Page Number ${i}`, type: i % 2 ? "event" : "project" })))
    expect(buildWikiContext(big, "a").length).toBeLessThan(buildWikiContext(big, "a", { catalog: "titles" }).length / 2)
  })

  it("the title list has no search line, since every title is there", () => {
    expect(buildWikiContext(corpus, "a", { catalog: "titles" })).not.toContain("wiki search")
  })

  it("the setting defaults to counts and takes titles", () => {
    const base = { node: { id: "t", name: "t" } }
    expect(daemonConfigSchema.parse(base).wiki.startCatalog).toBe("counts")
    expect(daemonConfigSchema.parse({ ...base, wiki: { startCatalog: "titles" } }).wiki.startCatalog).toBe("titles")
    expect(() => daemonConfigSchema.parse({ ...base, wiki: { startCatalog: "all" } })).toThrow()
  })
})
