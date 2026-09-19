import { describe, expect, it } from "vitest"
import { buildWikiContext } from "../src/agents/registry"

const store = (articles: Array<{ title: string; type?: string }>) => ({
  baseDir: "/tmp/wiki/agents/a/graph",
  listArticles: () => articles.map((a, i) => ({ meta: { title: a.title, type: a.type }, path: `p${i}.md` })),
}) as never

describe("buildWikiContext", () => {
  it("injects the catalog as content, not as an invitation to go and look", () => {
    const md = buildWikiContext(store([
      { title: "Alex Rivera", type: "person" },
      { title: "Widgets API", type: "project" },
    ]), "a")
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
    const md = buildWikiContext(store(many), "a", { maxArticles: 10 })
    // Seeing the first N names and assuming that is all of them is worse
    // than knowing the count and how to ask.
    expect(md).toContain("50 articles")
    expect(md).not.toContain("Person 7")
  })

  it("lists in full when the corpus fits", () => {
    const md = buildWikiContext(store([{ title: "Only One", type: "person" }]), "a", { maxArticles: 10 })
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
    const md = buildWikiContext(store([{ title: "Loose Note" }]), "a")
    expect(md).toContain("untyped")
    expect(md).toContain("Loose Note")
  })
})
