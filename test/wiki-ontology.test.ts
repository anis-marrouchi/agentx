import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../src/wiki/hub"
import type { WikiArticleMeta } from "../src/wiki/types"
import { DEFAULT_ONTOLOGY } from "../src/wiki/ontology/defaults"
import { checkOntology, loadOntology, mergeOntology } from "../src/wiki/ontology/load"
import { classifyPage } from "../src/wiki/ontology/classify"
import { buildGraph, type GraphPage } from "../src/wiki/ontology/graph"
import { lensFor, panelData } from "../src/wiki/ontology/lens"
import { needsAttention } from "../src/wiki/ontology/view-browse"
import { OntologyRoutes } from "../src/wiki/ontology/routes"

const quiet = () => {}

function meta(title: string, extra: Partial<WikiArticleMeta> = {}): WikiArticleMeta {
  return {
    title, tags: [], owner: "agent-a", access: "public", created: "2026-01-01",
    lastUpdated: "2026-01-02", sources: [], ...extra,
  }
}

function page(agentId: string, path: string, m: WikiArticleMeta, content = "Body."): GraphPage {
  return { agentId, article: { meta: m, content, path } }
}

describe("ontology loading", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "onto-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("uses the defaults when there is no ontology.yaml", () => {
    const { ontology, errors, file } = loadOntology(dir)
    expect(file).toBeNull()
    expect(errors).toEqual([])
    expect(ontology.pillars.filter(p => p.sidebar !== false)).toHaveLength(9)
    expect(checkOntology(DEFAULT_ONTOLOGY)).toEqual([])
  })

  it("merges types by id and keeps the rest of the defaults", () => {
    writeFileSync(join(dir, "ontology.yaml"), [
      "sidebar: {pins: [Sample Owner]}",
      "types:",
      "  - id: person",
      "    lens: [{panel: notes, source: notes}]",
      "  - id: vehicle",
      "    label: Vehicle",
      "    pillar: assets",
    ].join("\n"))
    const { ontology, errors } = loadOntology(dir)
    expect(errors).toEqual([])
    expect(ontology.sidebar.pins).toEqual(["Sample Owner"])
    expect(ontology.sidebar.pins_max).toBe(5)
    expect(ontology.types.find(t => t.id === "person")?.lens).toHaveLength(1)
    expect(ontology.types.find(t => t.id === "person")?.label).toBe("Person")
    expect(ontology.types.find(t => t.id === "vehicle")?.pillar).toBe("assets")
  })

  it("reports problems instead of throwing", () => {
    writeFileSync(join(dir, "ontology.yaml"), "types:\n  - id: thing\n    label: Thing\n    pillar: nowhere\n    lens: [{panel: x, from: no_such_prop}]\n")
    const { errors } = loadOntology(dir)
    expect(errors).toContain('type thing: unknown pillar "nowhere"')
    expect(errors).toContain('type thing, panel x: unknown property "no_such_prop"')

    writeFileSync(join(dir, "ontology.yaml"), "types: [unclosed\n")
    expect(loadOntology(dir).errors[0]).toMatch(/not valid YAML/)
  })

  it("replaces classify as a whole list", () => {
    const o = mergeOntology(DEFAULT_ONTOLOGY, { classify: [{ type: "device", tags: ["gadget"] }] })
    expect(o.classify).toHaveLength(1)
  })
})

describe("classifyPage", () => {
  const o = DEFAULT_ONTOLOGY
  it("prefers the page's own class", () => {
    expect(classifyPage(meta("X", { type: "concept", class: "obligation" }), "concepts/x.md", o)).toBe("obligation")
  })
  it("maps legacy types and refines by folder, tag and title", () => {
    expect(classifyPage(meta("A", { type: "pattern" }), "patterns/a.md", o)).toBe("procedure")
    expect(classifyPage(meta("Example Co", { type: "concept" }), "clients/example-co.md", o)).toBe("organization")
    expect(classifyPage(meta("Build host", { type: "concept", tags: ["vps"] }), "concepts/b.md", o)).toBe("server")
    expect(classifyPage(meta("Support Agent", { type: "person" }), "people/s.md", o)).toBe("agent")
    expect(classifyPage(meta("Staging server", { type: "place" }), "places/s.md", o)).toBe("server")
  })
  it("falls back to topic", () => {
    expect(classifyPage(meta("Idea", { type: "concept" }), "concepts/idea.md", o)).toBe("topic")
  })
})

describe("buildGraph", () => {
  const o = DEFAULT_ONTOLOGY
  const pages = [
    page("agent-a", "people/sample-owner.md", meta("Sample Owner", {
      type: "person",
      statements: [
        { property: "role_at", value: "Example Co", role: "founder", since: "2019-04" },
        { property: "owns", value: "Office Laptop" },
        { property: "identifier", value: "ID-123", access: "private" },
      ],
    }), "Founder of [[Example Co]]."),
    page("agent-b", "people/owner.md", meta("Owner", { type: "person", aliases: ["Sample Owner"] }), "Same person, another agent."),
    page("agent-a", "clients/example-co.md", meta("Example Co", { type: "concept" })),
    page("agent-a", "devices/office-laptop.md", meta("Office Laptop", {
      class: "device",
      statements: [
        { property: "reading", metric: "disk_used", value: "80%", at: "2026-09-01" },
        { property: "reading", metric: "disk_used", value: "91%", at: "2026-10-01" },
      ],
    })),
    ...Array.from({ length: 6 }, (_, i) => page("agent-a", `events/2026-10-0${i + 1}-disk-warning.md`,
      meta(`Disk warning ${i + 1}`, { type: "event", importance: "minor", related: ["Office Laptop"] }))),
    page("agent-a", "events/2026-10-07-laptop-replaced.md", meta("Laptop replaced", { type: "event", importance: "major", related: ["Office Laptop"] })),
  ]
  const g = buildGraph(pages, o)

  it("merges pages that share a name or alias into one entity", () => {
    const owner = g.entities.get("sample-owner")!
    expect(owner.pages.map(p => p.agentId)).toEqual(["agent-a", "agent-b"])
    expect(owner.type).toBe("person")
  })

  it("types entities and dates events from the path", () => {
    expect(g.entities.get("example-co")!.type).toBe("organization")
    expect(g.entities.get("office-laptop")!.type).toBe("device")
    expect(g.entities.get("disk-warning-1")!.date).toBe("2026-10-01")
  })

  it("shows typed relations on both ends, with role and dates", () => {
    const owner = g.entities.get("sample-owner")!
    const roles = panelData(g, owner, lensFor(g, "person")[0], { full: false, readEntries: () => [] })
    expect(roles.items[0]).toMatchObject({ label: "Example Co", chips: ["founder", "role at"], since: "2019-04" })

    const org = g.entities.get("example-co")!
    const people = panelData(g, org, lensFor(g, "organization")[0], { full: false, readEntries: () => [] })
    expect(people.items[0]).toMatchObject({ label: "Sample Owner", chips: ["founder", "people"] })
  })

  it("keeps a typed edge and drops the plain link to the same page", () => {
    const out = g.outgoing.get("sample-owner")!
    expect(out.filter(e => e.to === "example-co").map(e => e.property)).toEqual(["role_at"])
  })

  it("folds minor events and rolls repeated ones up", () => {
    const laptop = g.entities.get("office-laptop")!
    const history = lensFor(g, "device").find(p => p.panel === "history")!
    const z2 = panelData(g, laptop, history, { full: false, readEntries: () => [] })
    expect(z2.items.map(i => i.label)).toEqual(["Laptop replaced"])
    expect(z2.folded).toHaveLength(6)
    expect(z2.rollups[0]).toMatch(/^6 minor events in 30 days/)
    const z3 = panelData(g, laptop, history, { full: true, readEntries: () => [] })
    expect(z3.items).toHaveLength(7)
  })

  it("shows only the latest reading per metric at Z2", () => {
    const laptop = g.entities.get("office-laptop")!
    const state = panelData(g, laptop, lensFor(g, "device")[0], { full: false, readEntries: () => [] })
    expect(state.items.map(i => i.label)).toEqual(["disk used: 91%"])
  })

  it("lists unconfirmed and late items as needing attention", () => {
    const g2 = buildGraph([
      page("a", "o/x.md", meta("Monthly return", { class: "obligation", statements: [{ property: "action", value: "declare", status: "proposed" }] })),
      page("a", "d/y.md", meta("Return 2026-09", { class: "due_date", statements: [{ property: "due", value: "2026-10-01" }] })),
    ], o)
    const list = needsAttention(g2, [...g2.entities.values()], Date.parse("2026-10-08"))
    expect(list.map(a => [a.e.title, a.chip])).toEqual([["Return 2026-09", "late"], ["Monthly return", "proposed"]])
  })
})

describe("knowledge-graph routes", () => {
  let dir: string
  let routes: OntologyRoutes
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onto-routes-"))
    const hub = new WikiHub(dir, quiet)
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("people/sample-owner.md", meta("Sample Owner", {
      type: "person",
      statements: [{ property: "identifier", value: "SECRET-1", access: "private", source: "registry extract" }],
    }), "Runs [[Example Co]].", "agent-a")
    store.writeArticle("clients/example-co.md", meta("Example Co", { type: "concept" }), "A sample company.", "agent-a")
    routes = new OntologyRoutes(hub, dir)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("round-trips the ontology fields through the article file", () => {
    const hub = new WikiHub(dir, quiet)
    const a = hub.getAgentWiki("agent-a").readArticle("people/sample-owner.md")!
    expect(a.meta.statements).toEqual([{ property: "identifier", value: "SECRET-1", access: "private", source: "registry extract" }])
  })

  it("renders every zoom level", () => {
    const home = routes.handle("/", new URLSearchParams())!
    expect(home).toContain("Law &amp; Obligations")
    expect(routes.handle("/p/parties", new URLSearchParams())).toContain("Sample Owner")
    const z2 = routes.handle("/e/sample-owner", new URLSearchParams())!
    expect(z2).toContain("Roles over time")
    expect(routes.handle("/e/sample-owner/relations", new URLSearchParams())).toContain("Relations")
    const z4 = routes.handle("/e/sample-owner/s/0", new URLSearchParams())!
    expect(z4).toContain("SECRET-1")
    expect(z4).toContain("registry extract")
  })

  it("masks private statements above Z4", () => {
    writeFileSync(join(dir, "ontology.yaml"), "types:\n  - id: person\n    lens: [{panel: facts, from: [identifier]}]\n")
    const z2 = routes.handle("/e/sample-owner", new URLSearchParams())!
    expect(z2).not.toContain("SECRET-1")
  })

  it("keeps the sidebar to home, pins and pillars", () => {
    writeFileSync(join(dir, "ontology.yaml"), "sidebar: {pins: [Example Co]}\n")
    const html = routes.handle("/", new URLSearchParams())!
    const side = html.slice(html.indexOf('<nav class="ox-side"'), html.indexOf("</nav>", html.indexOf('<nav class="ox-side"')))
    expect(side).toContain("Example Co")
    expect(side).not.toContain("Topics")
    expect((side.match(/class="ox-nav/g) ?? []).length).toBe(1 + 1 + 9)
  })

  it("ignores an unknown importance level on the event list", () => {
    const html = routes.handle("/p/events/event", new URLSearchParams("importance=%22%3E%3Cx"))!
    expect(html).not.toContain('"><x')
    expect(html).not.toContain("only</p>")
    expect(html).toContain('class="on" href="/p/events/event">all')
  })

  it("returns null for unknown pages and other routes", () => {
    expect(routes.handle("/e/nobody", new URLSearchParams())).toBeNull()
    expect(routes.handle("/agent/agent-a", new URLSearchParams())).toBeNull()
  })
})
