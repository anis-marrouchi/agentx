import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../../src/wiki/hub"
import type { WikiArticleMeta } from "../../src/wiki/types"
import { DEFAULT_ONTOLOGY } from "../../src/wiki/ontology/defaults"
import { buildGraph, type GraphPage } from "../../src/wiki/ontology/graph"
import { panelData } from "../../src/wiki/ontology/lens"
import { buildRoster, configuredAgents, personaName } from "../../src/wiki/ontology/roster"
import { cutAtSentence, entityPage, overviewSection } from "../../src/wiki/ontology/view-entity"
import {
  checkEnrichment, createEntityPage, enrichContext, ENRICH_BY, loadEnrichState, mergedMeta, runEnrich, withOverview,
  type EnrichCall,
} from "../../src/wiki/enrich"

function meta(title: string, extra: Partial<WikiArticleMeta> = {}): WikiArticleMeta {
  return { title, tags: [], owner: "agent-a", access: "public", created: "2026-01-01", lastUpdated: "2026-01-02", sources: [], ...extra }
}
function page(agentId: string, path: string, m: WikiArticleMeta, content = "Body."): GraphPage {
  return { agentId, article: { meta: { ...m, owner: agentId }, content, path } }
}

describe("agents are not people (#819)", () => {
  const roster = buildRoster([{ id: "helper-agent", name: "Helper", persona: "Nova" }, { id: "sam", name: "Sam Agent" }])

  it("puts a registered agent's page under Agents even without 'agent' in the title", () => {
    const g = buildGraph([
      page("agent-a", "people/nova.md", meta("Nova", { type: "person" })),
      page("agent-a", "people/helper.md", meta("Helper", { type: "person" })),
    ], DEFAULT_ONTOLOGY, roster)
    expect(g.entities.get("nova")?.type).toBe("agent")
    expect(g.entities.get("helper")?.type).toBe("agent")
  })

  it("keeps a real person who shares the agent's name, and flags the bare name", () => {
    const g = buildGraph([
      page("agent-a", "people/nova.md", meta("Nova", { type: "person" })),
      page("agent-a", "people/nova-reyes.md", meta("Nova Reyes", { type: "person" })),
      // Named after a person: the bare id is that person's name.
      page("agent-a", "people/sam.md", meta("Sam", { type: "person" })),
    ], DEFAULT_ONTOLOGY, roster)
    expect(g.entities.get("nova-reyes")?.type).toBe("person")
    expect(g.entities.get("nova")?.type).toBe("person")
    expect(g.entities.get("nova")?.review).toMatch(/helper-agent/)
    expect(g.entities.get("sam")?.type).toBe("person")
  })

  it("leaves a project that shares an agent's name alone", () => {
    const g = buildGraph([page("agent-a", "projects/nova.md", meta("Nova", { type: "project" }))], DEFAULT_ONTOLOGY, roster)
    expect(g.entities.get("nova")?.type).toBe("project")
  })

  it("never lists an agent among a person's relations", () => {
    const g = buildGraph([
      page("agent-a", "people/client.md", meta("Client Person", { type: "person", related: ["Nova", "Other Person"] })),
      page("agent-a", "people/nova.md", meta("Nova", { type: "person" })),
      page("agent-a", "people/other.md", meta("Other Person", { type: "person" })),
    ], DEFAULT_ONTOLOGY, roster)
    const e = g.entities.get("client-person")!
    const def = DEFAULT_ONTOLOGY.types.find(t => t.id === "person")!.lens!.find(p => p.panel === "relations")!
    const labels = panelData(g, e, def, { full: true, readEntries: () => [] }).items.map(i => i.label)
    expect(labels).toEqual(["Other Person"])
  })

  it("flags a person whose alias is an agent's name, without retyping it", () => {
    const g = buildGraph([page("agent-a", "people/pat.md", meta("Pat Doe", { type: "person", aliases: ["Nova"] }))], DEFAULT_ONTOLOGY, roster)
    expect(g.entities.get("pat-doe")?.type).toBe("person")
    expect(g.entities.get("pat-doe")?.review).toMatch(/alias matches agent helper-agent/)
  })

  it("reads a persona name and the configured agents next to the wiki", () => {
    expect(personaName("# X\n\n**Name:** Nova (نوفا). A star.")).toBe("Nova")
    const root = mkdtempSync(join(tmpdir(), "roster-"))
    try {
      mkdirSync(join(root, "ws"))
      writeFileSync(join(root, "ws", "persona.md"), "**Name:** Nova\n")
      writeFileSync(join(root, "agentx.json"), JSON.stringify({ agents: { "helper-agent": { name: "Helper", workspace: join(root, "ws") } } }))
      expect(configuredAgents(join(root, ".agentx", "wiki"))).toEqual([{ id: "helper-agent", name: "Helper", persona: "Nova" }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("overview", () => {
  it("cuts a summary at a sentence end, not mid-word", () => {
    expect(cutAtSentence("First sentence here. Second one is much longer than the limit allows.", 40)).toBe("First sentence here.")
  })

  it("shows the whole Overview section on the entity page", () => {
    const long = "Story sentence. ".repeat(40).trim()
    const g = buildGraph([page("agent-a", "people/p.md", meta("Pat Doe", { type: "person" }), withOverview("Old notes.", long))], DEFAULT_ONTOLOGY)
    const html = entityPage({ g, readEntries: () => [], versions: () => [] }, g.entities.get("pat-doe")!)
    expect(html).toContain(long)
    expect(html).toContain("Old notes.")
    expect(html).not.toContain("/overview")
  })

  it("replaces its own overview and keeps text it cannot bound", () => {
    const once = withOverview("Notes stay.", "First.")
    expect(overviewSection(once)).toBe("First.")
    const twice = withOverview(once, "Second.")
    expect(overviewSection(twice)).toBe("Second.")
    expect(twice).not.toContain("First.")
    expect(twice).toContain("Notes stay.")
    // Someone else's Overview with nothing after it to mark its end.
    const kept = withOverview("## Overview\n\nHand-written.\n\nMore text.", "New.")
    expect(overviewSection(kept)).toBe("New.")
    expect(kept).toContain("Hand-written.")
    expect(kept).toContain("More text.")
    // A hand-written Overview ended by a heading, longer than the call reads.
    const long = `## Overview\n\n${"Hand-written story. ".repeat(250)}\n\n## Notes\n\nKept.`
    const kept2 = withOverview(long, "New.")
    expect(overviewSection(kept2)).toBe("New.")
    expect(kept2).toContain("Hand-written story.")
    expect(kept2).toContain("Kept.")
    // Short enough to have been read in full: replaced.
    expect(withOverview("## Overview\n\nShort old.\n\n## Notes\n\nKept.", "New.")).not.toContain("Short old.")
  })
})

describe("checking a reply", () => {
  const g = buildGraph([
    page("agent-a", "people/pat.md", meta("Pat Doe", { type: "person", related: ["Acme Works", "Nova", "Launch Day"], sources: ["e1"] })),
    page("agent-a", "clients/acme.md", meta("Acme Works")),
    page("agent-a", "people/nova.md", meta("Nova", { type: "person" })),
    page("agent-a", "projects/site.md", meta("Site Build", { type: "project" })),
    page("agent-a", "events/2026-01-05-launch.md", meta("Launch Day", { type: "event" })),
  ], DEFAULT_ONTOLOGY, buildRoster([{ id: "nova-agent", name: "Nova" }]))
  const ctx = enrichContext(g, g.entities.get("pat-doe")!, () => [{ id: "e1", date: "2026-01-04", agentId: "agent-a", source: "chat", content: "Pat joined Acme." }])

  it("keeps sourced facts on allowed properties and drops the rest", () => {
    const r = checkEnrichment({
      overview: "Pat works at Acme Works. It started in January",
      statements: [
        { property: "role_at", value: "Acme Works", role: "buyer", since: "2026-01", source: "entry e1" },
        { property: "role_at", value: "Acme Works", source: "a hunch" },
        { property: "registrar", value: "Laptop", source: "e1" },
        { property: "works_with", value: "Nova", source: "e1" },
        { property: "works_on", value: "Acme Works", source: "e1" },
        { property: "reports_to", value: "unknown", source: "e1" },
      ],
      history: ["2026-01-05 · Launch Day", "Made Up Event"],
    }, ctx, g)
    expect(r.overview).toBe("Pat works at Acme Works.")
    expect(r.statements).toEqual([{ property: "role_at", value: "Acme Works", role: "buyer", since: "2026-01", source: "entry e1" }])
    expect(r.links).toEqual(["Launch Day"])
    expect(r.dropped.join("\n")).toMatch(/agent is not a person's relation/)
    expect(r.dropped.join("\n")).toMatch(/expected project/)
  })

  it("does not offer an organisation the person-side role properties", () => {
    const org = enrichContext(g, g.entities.get("acme-works")!, () => [])
    expect(org.properties.has("role_at")).toBe(false)
    expect(org.properties.has("located_in")).toBe(true)
  })

  it("replaces this job's earlier facts and keeps everyone else's", () => {
    const m = mergedMeta(meta("Pat Doe", {
      statements: [{ property: "role_at", value: "Old Co", by: ENRICH_BY }, { property: "owns", value: "Van" }],
      related: ["Acme Works"],
    }), { overview: "", statements: [{ property: "role_at", value: "Acme Works", source: "e1" }], links: ["Launch Day"], dropped: [] }, "2026-02-01")
    expect(m.statements?.map(s => s.value)).toEqual(["Van", "Acme Works"])
    expect(m.statements?.[1]).toMatchObject({ by: ENRICH_BY, checked_at: "2026-02-01" })
    expect(m.related).toEqual(["Acme Works", "Launch Day"])
  })

  it("keeps a hand-written fact it also found, so a later run cannot drop it", () => {
    const own = { property: "role_at", value: "Acme Works", role: "buyer", status: "confirmed" as const, confirmed_by: "pat", note: "met in March", since: "2025-03-01" }
    const found = { overview: "", statements: [{ property: "role_at", value: "acme works", source: "e1" }], links: [], dropped: [] }
    const m = mergedMeta(meta("Pat Doe", { statements: [own] }), found, "2026-02-01")
    expect(m.statements).toEqual([own])
    const later = mergedMeta(m, { ...found, statements: [] }, "2026-03-01")
    expect(later.statements).toEqual([own])
  })
})

describe("wiki enrich run", () => {
  let dir: string
  let hub: WikiHub
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "enrich-"))
    hub = new WikiHub(dir, () => {})
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("people/pat.md", meta("Pat Doe", { type: "person", owner: "agent-a", sources: ["e1"] }), "Pat is a buyer.", "agent-a")
    store.writeArticle("people/kim.md", meta("Kim Roe", { type: "person", owner: "agent-a" }), "Kim mentions [[Acme Works]].", "agent-a")
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const graph = () => buildGraph(hub.listAgents([]).flatMap(a => hub.getAgentWiki(a).listAllArticles().map(article => ({ agentId: a, article }))), DEFAULT_ONTOLOGY)
  const opts = { types: ["person", "organization"], only: [], max: 10, maxCostUsd: 1, dryRun: false, force: false, today: "2026-02-01" }
  const reply = (overview: string): EnrichCall => async () => ({ text: JSON.stringify({ overview, statements: [] }), costUsd: 0.3 })

  it("writes the overview, keeps the old version, and skips unchanged entities next time", async () => {
    const state = loadEnrichState(dir)
    const run = await runEnrich(hub, graph(), reply("Pat buys from us."), { ...opts, only: ["Pat Doe"] }, state)
    expect(run.outcomes.map(o => o.status)).toEqual(["written"])
    const store = hub.getAgentWiki("agent-a")
    expect(overviewSection(store.readArticle("people/pat.md")!.content)).toBe("Pat buys from us.")
    expect(store.getVersions("people/pat.md").length).toBe(1)
    const again = await runEnrich(hub, graph(), reply("Changed."), { ...opts, only: ["Pat Doe"] }, state)
    expect(again.outcomes.map(o => o.status)).toEqual(["unchanged"])
  })

  it("writes onto the text on disk, not the copy read before the model call", async () => {
    const store = hub.getAgentWiki("agent-a")
    const call: EnrichCall = async (p) => {
      // Absorb edits the page while the run waits for the model.
      store.writeArticle("people/pat.md", store.readArticle("people/pat.md")!.meta, "Pat is a buyer. Pat moved to the north office.", "agent-a")
      return reply("Pat buys from us.")(p)
    }
    await runEnrich(hub, graph(), call, { ...opts, only: ["Pat Doe"] }, { entities: {} })
    const content = store.readArticle("people/pat.md")!.content
    expect(content).toContain("Pat moved to the north office.")
    expect(overviewSection(content)).toBe("Pat buys from us.")
  })

  it("stops before the next call once the cap is spent, and a dry run writes nothing", async () => {
    const run = await runEnrich(hub, graph(), reply("Story."), { ...opts, maxCostUsd: 0.2, dryRun: true }, { entities: {} })
    expect(run.outcomes).toHaveLength(1)
    expect(run.capped).toBe(true)
    expect(run.outcomes[0].status).toBe("dry-run")
    expect(hub.getAgentWiki("agent-a").getVersions("people/pat.md")).toHaveLength(0)
  })

  it("never reads a page narrower than the one it writes to", async () => {
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("people/pat.md", meta("Pat Doe", { type: "person", owner: "agent-a", sources: ["e1", "e2"] }), "Pat is a buyer.", "agent-a")
    store.writeArticle("people/pat-private.md", meta("Pat Doe", { type: "person", owner: "agent-a", access: "private", sources: ["e9"] }), "Pat's secret salary.", "agent-a")
    store.writeArticle("notes/private-note.md", meta("Private Note", { owner: "agent-a", access: "private" }), "Pat Doe told me a secret.", "agent-a")
    store.writeArticle("notes/public-note.md", meta("Public Note", { owner: "agent-a" }), "Pat Doe came to the launch.", "agent-a")
    const g = graph()
    const e = g.entities.get("pat-doe")!
    const prompts: string[] = []
    const run = await runEnrich(hub, g, async (p) => { prompts.push(p); return { text: JSON.stringify({ overview: "Pat buys from us." }), costUsd: 0.1 } }, { ...opts, only: ["Pat Doe"] }, { entities: {} })
    expect(run.outcomes[0]).toMatchObject({ status: "written", page: "agent-a/people/pat.md" })
    expect(prompts[0]).toContain("Pat is a buyer.")
    expect(prompts[0]).toContain("Pat Doe came to the launch.")
    expect(prompts[0]).not.toContain("secret")
    // Writing to the private page, everything readable may be used.
    const priv = e.pages.find(p => p.article.path === "people/pat-private.md")!
    const ctx = enrichContext(g, e, () => [], priv)
    expect(ctx.pages.map(p => p.article.path).sort()).toEqual(["people/pat-private.md", "people/pat.md"])
    expect(ctx.sources.sort()).toEqual(["e1", "e2", "e9"])
    expect(ctx.mentions.map(m => m.page.article.meta.title).sort()).toEqual(["Private Note", "Public Note"])
  })

  it("saves state after each paid call, so a killed run does not pay again", async () => {
    const saved: string[][] = []
    let calls = 0
    const call: EnrichCall = async () => {
      calls++
      if (calls === 2) throw new Error("killed")
      return { text: JSON.stringify({ overview: "Story." }), costUsd: 0.1 }
    }
    const state = loadEnrichState(dir)
    await runEnrich(hub, graph(), call, { ...opts, save: s => saved.push(Object.keys(s.entities)) }, state)
    expect(saved.length).toBe(2)
    expect(saved[0]).toHaveLength(1)
    // The failed entity goes last next time, and the written one is skipped.
    const order: string[] = []
    const next = await runEnrich(hub, graph(), async (p) => { order.push(p.match(/Subject: "([^"]+)"/)![1]); return { text: "no json", costUsd: 0.1 } }, opts, state)
    expect(order).toHaveLength(1)
    expect(next.outcomes.map(o => o.status)).toEqual(["no-reply"])
    // A paid reply with nothing usable is remembered as well.
    const third = await runEnrich(hub, graph(), call, opts, state)
    expect(third.outcomes).toEqual([])
  })

  it("creates a typed page for a thing other pages only name", async () => {
    expect(createEntityPage(hub, "Acme Works", "organization", "agent-a", "2026-02-01")).toBe("organizations/acme-works.md")
    expect(createEntityPage(hub, "Acme Works", "organization", "agent-a", "2026-02-01")).toBeNull()
    const g = graph()
    const e = g.entities.get("acme-works")!
    expect(e.type).toBe("organization")
    expect(enrichContext(g, e, () => []).mentions.map(m => m.page.article.meta.title)).toEqual(["Kim Roe"])
  })

  it("writes a title with quotes or line breaks that reads back the same", () => {
    const path = createEntityPage(hub, 'The "Blue"\nVan', "organization", "agent-a", "2026-02-01")!
    const page = hub.getAgentWiki("agent-a").readArticle(path, "agent-a")!
    expect(page.meta).toMatchObject({ title: 'The "Blue" Van', owner: "agent-a", class: "organization" })
  })
})
