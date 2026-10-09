import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../../src/wiki/hub"
import type { WikiArticleMeta } from "../../src/wiki/types"
import { DEFAULT_ONTOLOGY } from "../../src/wiki/ontology/defaults"
import { buildGraph } from "../../src/wiki/ontology/graph"
import { panelData } from "../../src/wiki/ontology/lens"
import { overviewSection } from "../../src/wiki/ontology/view-entity"
import type { EnrichCall } from "../../src/wiki/enrich"
import {
  checkRules, loadRulesState, ruleSources, rulesContext, ruleWordsPattern, runRules, RULES_BY, RULES_TAG,
} from "../../src/wiki/rules"

function meta(title: string, extra: Partial<WikiArticleMeta> = {}): WikiArticleMeta {
  return { title, tags: [], owner: "agent-a", access: "shared", created: "2026-01-01", lastUpdated: "2026-01-02", sources: [], ...extra }
}

const RULE = {
  title: "Monthly payroll filing",
  action: "File the payroll declaration and pay the contributions.",
  bearer: ["Acme Works"],
  deadline: "by the 15th of the following month",
  amount: "",
  authority: "Social Fund",
  penalty: "1% of the amount per month late",
  basis: "Social Security Code",
  procedure: "",
  source: "e1",
}

describe("wiki rules run (#811)", () => {
  let dir: string
  let hub: WikiHub
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-"))
    hub = new WikiHub(dir, () => {})
    hub.getSharedStore().addEntry({ id: "e1", date: "2026-01-05", agentId: "agent-a", source: "chat", content: "Payroll declaration is due by the 15th; late payment costs 1% per month." })
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("notes/payroll.md", meta("Payroll notes", { sources: ["e1"] }), "Acme Works files the payroll declaration by the 15th. Late filing brings a penalty.", "agent-a")
    store.writeArticle("clients/acme.md", meta("Acme Works", { class: "organization" }), "Our company.", "agent-a")
    store.writeArticle("clients/fund.md", meta("Social Fund", { class: "organization" }), "The fund.", "agent-a")
    store.writeArticle("laws/code.md", meta("Social Security Code", { class: "legal_source" }), "The code.", "agent-a")
    store.writeArticle("notes/lunch.md", meta("Lunch"), "We had lunch.", "agent-a")
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const graph = () => buildGraph(hub.listAgents([]).flatMap(a => hub.getAgentWiki(a).listAllArticles().map(article => ({ agentId: a, article }))), DEFAULT_ONTOLOGY)
  const opts = { only: [], words: ruleWordsPattern(), max: 10, maxCostUsd: 1, dryRun: false, force: false, today: "2026-02-01" }
  const reply = (rules: unknown[]): EnrichCall => async () => ({ text: JSON.stringify({ rules }), costUsd: 0.1 })

  it("reads legal sources and pages that speak of deadlines, not other pages", () => {
    const titles = ruleSources(graph(), ruleWordsPattern()).map(e => e.title)
    expect(titles).toEqual(["Social Security Code", "Payroll notes"])
    expect(ruleWordsPattern().test("Date limite de la déclaration")).toBe(true)
    expect(ruleWordsPattern().test("refined sugar")).toBe(false)
  })

  it("drops rules without an action or a source it was shown", () => {
    const g = graph()
    const e = g.entities.get("payroll-notes")!
    const ctx = rulesContext(g, e, e.pages[0], ids => hub.getSharedStore().readEntries(ids))
    const r = checkRules({ rules: [RULE, { ...RULE, title: "No action", action: "" }, { ...RULE, title: "Made up", source: "e99" }, { ...RULE, title: "Acme Works" }] }, ctx, g)
    expect(r.rules.map(x => x.title)).toEqual(["Monthly payroll filing"])
    expect(r.dropped).toEqual(["No action: no action", "Made up: source not among those given", "Acme Works: a page of type organization already has this title"])
  })

  it("writes the rule page, its penalty and the bearer's link, then skips the unchanged source", async () => {
    const state = loadRulesState(dir)
    const run = await runRules(hub, graph(), reply([RULE]), { ...opts, only: ["Payroll notes"] }, state)
    expect(run.outcomes.map(o => o.status)).toEqual(["written"])
    const store = hub.getAgentWiki("agent-a")
    const page = store.readArticle("obligations/monthly-payroll-filing.md")!
    expect(page.meta.class).toBe("obligation")
    expect(page.meta.tags).toEqual([RULES_TAG])
    expect(page.meta.access).toBe("shared")
    expect(page.meta.sources).toEqual(["e1"])
    expect(overviewSection(page.content)).toContain("**Deadline:** by the 15th of the following month")
    expect(overviewSection(page.content)).toContain("**Last checked:** 2026-02-01")
    const facts = Object.fromEntries(page.meta.statements!.map(s => [s.property, s.value]))
    expect(facts).toMatchObject({ action: RULE.action, bearer: "Acme Works", due_rule: RULE.deadline, authority: "Social Fund", created_by: "Social Security Code" })
    expect(page.meta.statements!.every(s => s.by === RULES_BY && s.checked_at === "2026-02-01" && s.source === "e1")).toBe(true)

    const penalty = store.readArticle("penalties/monthly-payroll-filing-penalty.md")!
    expect(penalty.meta.statements!.find(s => s.property === "penalty_for")?.value).toBe(RULE.title)
    expect(store.readArticle("clients/acme.md")!.meta.statements).toEqual([expect.objectContaining({ property: "subject_to", value: RULE.title, by: RULES_BY })])

    // The rule shows on the company page and the penalty on the rule page.
    const g = graph()
    const lens = (type: string, panel: string) => DEFAULT_ONTOLOGY.types.find(t => t.id === type)!.lens!.find(p => p.panel === panel)!
    const items = (id: string, type: string, panel: string) => panelData(g, g.entities.get(id)!, lens(type, panel), { full: true, readEntries: () => [] }).items.map(i => i.label)
    expect(items("acme-works", "organization", "obligations")).toEqual([RULE.title])
    expect(items("monthly-payroll-filing", "obligation", "penalties")).toEqual(["Monthly payroll filing penalty"])

    const again = await runRules(hub, g, reply([RULE]), { ...opts, only: ["Payroll notes"] }, state)
    expect(again.outcomes.map(o => o.status)).toEqual(["unchanged"])
    expect(again.costUsd).toBe(0)
  })

  it("updates an existing rule page instead of adding a second one, and keeps others' facts", async () => {
    const store = hub.getAgentWiki("agent-a")
    const own = { property: "status", value: "active", by: "agent-a" }
    store.writeArticle("compliance/payroll.md", meta("Monthly payroll filing", { class: "obligation", statements: [own] }), "Agents wrote this.", "agent-a")
    await runRules(hub, graph(), reply([{ ...RULE, title: "monthly payroll filing" }]), { ...opts, only: ["Payroll notes"] }, loadRulesState(dir))
    expect(store.readArticle("obligations/monthly-payroll-filing.md")).toBeNull()
    const page = store.readArticle("compliance/payroll.md")!
    expect(page.meta.statements![0]).toEqual(own)
    expect(page.meta.statements!.some(s => s.property === "due_rule")).toBe(true)
    expect(page.content).toContain("Agents wrote this.")
  })

  it("never writes a private source into a page more agents can read", async () => {
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("notes/payroll.md", meta("Payroll notes", { access: "private", sources: ["e1"] }), "Acme Works: the deadline is the 15th.", "agent-a")
    store.writeArticle("clients/acme.md", meta("Acme Works", { class: "organization", sharedWith: ["agent-b"] }), "Our company.", "agent-a")
    const run = await runRules(hub, graph(), reply([RULE]), { ...opts, only: ["Payroll notes"] }, loadRulesState(dir))
    expect(store.readArticle("obligations/monthly-payroll-filing.md")!.meta.access).toBe("private")
    // The shared company page would show a private rule's title.
    expect(store.readArticle("clients/acme.md")!.meta.statements).toBeUndefined()
    expect(run.outcomes[0].dropped.some(d => d.includes("cannot read the rule"))).toBe(true)
  })

  it("writes nothing on a dry run", async () => {
    const run = await runRules(hub, graph(), reply([RULE]), { ...opts, dryRun: true }, { sources: {} })
    expect(run.outcomes.find(o => o.title === "Payroll notes")?.rules[0]).toMatchObject({ created: true, linked: ["Acme Works"], deadline: true, penalty: true })
    expect(hub.getAgentWiki("agent-a").readArticle("obligations/monthly-payroll-filing.md")).toBeNull()
    expect(hub.getAgentWiki("agent-a").readArticle("clients/acme.md")!.meta.statements).toBeUndefined()
  })

  it("stops at the spending cap", async () => {
    const run = await runRules(hub, graph(), reply([]), { ...opts, maxCostUsd: 0.1 }, { sources: {} })
    expect(run.outcomes.map(o => o.status)).toEqual(["no-rules"])
    expect(run.capped).toBe(true)
  })
})
