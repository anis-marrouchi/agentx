import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../../src/wiki/hub"
import type { WikiArticleMeta } from "../../src/wiki/types"
import { DEFAULT_ONTOLOGY } from "../../src/wiki/ontology/defaults"
import { buildGraph } from "../../src/wiki/ontology/graph"
import { checkOntology, mergeOntology } from "../../src/wiki/ontology/load"
import { panelData } from "../../src/wiki/ontology/lens"
import {
  checkEventsReply, EVENTS_BY, pickEvents, ruleLevel, runEvents, setEventLevel, summariseAbout,
  type EventsCall, type EventsOptions,
} from "../../src/wiki/event-levels"

// #811: every event gets an importance level and the page it is about.

function meta(title: string, extra: Partial<WikiArticleMeta> = {}): WikiArticleMeta {
  return { title, tags: [], owner: "agent-a", access: "public", created: "2026-01-01", lastUpdated: "2026-01-02", sources: [], ...extra }
}

const opts: EventsOptions = { about: [], max: 50, batch: 20, maxCostUsd: 1, dryRun: false, force: false, rulesOnly: false, today: "2026-03-01" }

describe("importance rules", () => {
  const rules = DEFAULT_ONTOLOGY.importance.rules

  it("marks routine upkeep as minor and leaves the rest to the model", () => {
    expect(ruleLevel(rules, "Office Laptop disk full", [])).toBe("minor")
    expect(ruleLevel(rules, "Build cache cleared on Build Server", [])).toBe("minor")
    expect(ruleLevel(rules, "Example Company signed the renewal", [])).toBeUndefined()
  })

  it("leaves upkeep titles that also report damage to the model", () => {
    expect(ruleLevel(rules, "Build Server restarted", [])).toBe("minor")
    expect(ruleLevel(rules, "Production down after reboot", [])).toBeUndefined()
    expect(ruleLevel(rules, "Health check failed on Build Server", [])).toBeUndefined()
    expect(ruleLevel(rules, "Disk full, data lost", [])).toBeUndefined()
    expect(ruleLevel([{ level: "minor", title: "restart", unless: "(" }], "restart", [])).toBeUndefined()
  })

  it("matches on tags, and needs every condition of a rule", () => {
    const own = [{ level: "normal" as const, title: "invoice", tags: ["billing"] }, { level: "minor" as const, tags: ["noise"] }]
    expect(ruleLevel(own, "Invoice sent", ["Billing"])).toBe("normal")
    expect(ruleLevel(own, "Invoice sent", [])).toBeUndefined()
    expect(ruleLevel(own, "Anything", ["noise"])).toBe("minor")
  })

  it("reports a bad rule in ontology.yaml", () => {
    const o = mergeOntology(DEFAULT_ONTOLOGY, { importance: { rules: [{ level: "huge", title: "x" }, { level: "minor" }, { level: "minor", title: "(" }] } })
    const errors = checkOntology(o).join("\n")
    expect(errors).toMatch(/unknown level "huge"/)
    expect(errors).toMatch(/needs a title or tags/)
    expect(errors).toMatch(/bad title pattern/)
    expect(checkOntology(mergeOntology(DEFAULT_ONTOLOGY, { importance: { rules: [{ level: "minor", title: "x", unless: "(" }] } })).join()).toMatch(/bad unless pattern/)
  })
})

describe("wiki events run", () => {
  let dir: string
  let hub: WikiHub

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "events-"))
    hub = new WikiHub(dir, () => {})
    const store = hub.getAgentWiki("agent-a")
    store.writeArticle("places/office-laptop.md", meta("Office Laptop", { class: "device" }), "The laptop on the front desk.", "agent-a")
    store.writeArticle("people/example-company.md", meta("Example Company", { class: "organization" }), "A client.", "agent-a")
    store.writeArticle("events/2026-02-01-office-laptop-disk-full.md", meta("Office Laptop disk full", { type: "event" }), "The disk filled up and was cleaned.", "agent-a")
    store.writeArticle("events/2026-02-10-renewal-signed.md", meta("Renewal signed", { type: "event", related: ["Example Company"] }), "[[Example Company]] signed for another year.", "agent-a")
    store.writeArticle("events/2026-02-12-weekly-call.md", meta("Weekly call", { type: "event", related: ["Example Company"] }), "A call with [[Example Company]].", "agent-a")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const graph = () => buildGraph(hub.listAgents([]).flatMap(a => hub.getAgentWiki(a).listAllArticles().map(article => ({ agentId: a, article }))), DEFAULT_ONTOLOGY)
  const event = (title: string) => hub.getAgentWiki("agent-a").listAllArticles().find(a => a.meta.title === title)!
  /** Answers by event title, so the order in the prompt does not matter. */
  const reply = (answers: Record<string, { importance: string; about?: string[] }>): EventsCall => async (prompt) => {
    const titles = [...prompt.matchAll(/^### (\d+)\. (.+) \(/gm)].map(m => ({ n: Number(m[1]), title: m[2] }))
    return { text: JSON.stringify({ events: titles.filter(t => answers[t.title]).map(t => ({ n: t.n, ...answers[t.title], why: "test" })) }), costUsd: 0.01 }
  }

  it("uses a rule for free, asks the model for the rest, and writes level and subject", async () => {
    const prompts: string[] = []
    const call: EventsCall = async (p) => {
      prompts.push(p)
      return reply({ "Renewal signed": { importance: "normal", about: ["Example Company"] }, "Weekly call": { importance: "minor", about: ["Example Company", "Someone Else"] } })(p)
    }
    const run = await runEvents(hub, graph(), call, opts)
    expect(run.calls).toBe(1)
    expect(prompts[0]).not.toContain("Office Laptop disk full")

    const disk = event("Office Laptop disk full")
    expect(disk.meta.importance).toBe("minor")
    expect(disk.meta.statements?.find(s => s.property === "involves")).toMatchObject({ value: "Office Laptop", by: EVENTS_BY })
    expect(event("Renewal signed").meta.importance).toBe("normal")
    const call2 = run.outcomes.find(o => o.title === "Weekly call")!
    expect(call2.about).toEqual(["Example Company"])
    expect(call2.dropped.join()).toMatch(/Someone Else: not in the list shown/)

    // The laptop's History now folds its minor event.
    const g = graph()
    const def = DEFAULT_ONTOLOGY.types.find(t => t.id === "device")!.lens!.find(p => p.panel === "history")!
    const h = panelData(g, g.entities.get("office-laptop")!, def, { full: false, readEntries: () => [] })
    expect(h.items).toHaveLength(0)
    expect(h.folded.map(i => i.label)).toEqual(["Office Laptop disk full"])
  })

  it("keeps major as a proposal where only the owner sets it, until the owner decides", async () => {
    await runEvents(hub, graph(), reply({ "Renewal signed": { importance: "major", about: ["Example Company"] }, "Weekly call": { importance: "minor" } }), opts)
    expect(event("Renewal signed").meta).toMatchObject({ importance: "normal", importanceProposed: "major" })
    expect(graph().entities.get("renewal-signed")?.importanceProposed).toBe("major")

    expect(setEventLevel(hub, graph(), "Renewal signed", "major").ok).toBe(true)
    expect(event("Renewal signed").meta.importance).toBe("major")
    expect(event("Renewal signed").meta.importanceProposed).toBeUndefined()

    // The owner's level survives --force; this job's own levels are redone.
    const redo = await runEvents(hub, graph(), reply({ "Weekly call": { importance: "normal" } }), { ...opts, force: true, rulesOnly: false })
    expect(redo.outcomes.map(o => o.title)).not.toContain("Renewal signed")
    expect(event("Weekly call").meta.importance).toBe("normal")
    expect(event("Renewal signed").meta.importance).toBe("major")
  })

  it("writes major directly when the ontology lets anyone set it", () => {
    const o = mergeOntology(DEFAULT_ONTOLOGY, { importance: { major_set_by: "anyone" } })
    const g = buildGraph(hub.listAgents([]).flatMap(a => hub.getAgentWiki(a).listAllArticles().map(article => ({ agentId: a, article }))), o)
    const { items } = pickEvents(hub, g, { about: [], force: false })
    const v = checkEventsReply(JSON.stringify({ events: [{ n: 1, importance: "major" }, { n: 2, importance: "nonsense" }, { n: 99, importance: "minor" }] }), items, o)
    expect(v.get(0)?.verdict.importance).toBe("major")
    expect(v.get(0)?.verdict.proposed).toBeUndefined()
    expect(v.size).toBe(1)
  })

  it("does a pilot on the named pages only, and a dry run writes nothing", async () => {
    const g = graph()
    const run = await runEvents(hub, g, reply({ "Renewal signed": { importance: "normal", about: ["Example Company"] }, "Weekly call": { importance: "minor", about: ["Example Company"] } }), { ...opts, about: ["Example Company"], dryRun: true })
    expect(run.outcomes.map(o => o.title).sort()).toEqual(["Renewal signed", "Weekly call"])
    expect(run.outcomes.every(o => o.status === "dry-run")).toBe(true)
    expect(event("Renewal signed").meta.importance).toBeUndefined()
    expect(summariseAbout(g, run, ["Example Company"])).toEqual([{ title: "Example Company", type: "organization", before: 2, after: { minor: 1, normal: 1, major: 0 } }])
  })

  it("does nothing on a second run, and stops at the spending cap", async () => {
    const capped = await runEvents(hub, graph(), reply({ "Renewal signed": { importance: "normal" }, "Weekly call": { importance: "normal" } }), { ...opts, batch: 1, maxCostUsd: 0.01 })
    expect(capped.calls).toBe(1)
    expect(capped.capped).toBe(true)
    expect(capped.left).toBe(1)

    await runEvents(hub, graph(), reply({ "Renewal signed": { importance: "normal" }, "Weekly call": { importance: "normal" } }), opts)
    let asked = 0
    const again = await runEvents(hub, graph(), async () => { asked++; return { text: "{}", costUsd: 0 } }, opts)
    expect(asked).toBe(0)
    expect(again.outcomes).toHaveLength(0)
  })

  it("with rules only, leaves the other events for a later run", async () => {
    const run = await runEvents(hub, graph(), async () => { throw new Error("no model call expected") }, { ...opts, rulesOnly: true })
    expect(run.outcomes.map(o => o.title)).toEqual(["Office Laptop disk full"])
    expect(run.left).toBe(2)
  })

  it("keeps the page's date and writes onto the text on disk, not the copy read at the start", async () => {
    const store = hub.getAgentWiki("agent-a")
    const path = "events/2026-02-12-weekly-call.md"
    const call: EventsCall = async (p) => {
      // Absorb edits the page while the run waits for the model.
      store.writeArticle(path, { ...store.readArticle(path)!.meta, lastUpdated: "2026-02-20" }, "A call with [[Example Company]]. Next one in March.", "agent-a")
      return reply({ "Renewal signed": { importance: "normal" }, "Weekly call": { importance: "minor", about: ["Example Company"] } })(p)
    }
    await runEvents(hub, graph(), call, opts)
    const page = event("Weekly call")
    expect(page.meta.importance).toBe("minor")
    expect(page.meta.lastUpdated).toBe("2026-02-20")
    expect(page.content).toContain("Next one in March.")
    expect(event("Renewal signed").meta.lastUpdated).toBe("2026-01-02")

    expect(setEventLevel(hub, graph(), "Weekly call", "normal").ok).toBe(true)
    expect(event("Weekly call").meta.lastUpdated).toBe("2026-02-20")
  })

  it("leaves a level a person set while the run waited", async () => {
    const store = hub.getAgentWiki("agent-a")
    const path = "events/2026-02-10-renewal-signed.md"
    const call: EventsCall = async (p) => {
      store.writeArticle(path, { ...store.readArticle(path)!.meta, importance: "major" }, store.readArticle(path)!.content, "agent-a")
      return reply({ "Renewal signed": { importance: "minor" }, "Weekly call": { importance: "minor" } })(p)
    }
    const run = await runEvents(hub, graph(), call, opts)
    expect(event("Renewal signed").meta.importance).toBe("major")
    expect(run.outcomes.find(o => o.title === "Renewal signed")?.dropped.join()).toMatch(/level was set on the page during the run/)
  })

  it("holds the page's lock from the read to the write", async () => {
    const store = hub.getAgentWiki("agent-a")
    const path = "events/2026-02-10-renewal-signed.md"
    const lock = join(store.baseDir, "_locks", `${path}.lock`)
    // Another process holds the page while this run would write it.
    const call: EventsCall = async (p) => {
      mkdirSync(join(store.baseDir, "_locks", "events"), { recursive: true })
      writeFileSync(lock, "")
      return reply({ "Renewal signed": { importance: "normal" }, "Weekly call": { importance: "minor" } })(p)
    }
    store.lockWaitMs = 100
    const run = await runEvents(hub, graph(), call, opts)
    expect(event("Renewal signed").meta.importance).toBeUndefined()
    expect(run.outcomes.find(o => o.title === "Renewal signed")).toMatchObject({ status: "failed" })
    expect(run.outcomes.find(o => o.title === "Renewal signed")?.dropped.join()).toMatch(/page was busy/)
    expect(event("Weekly call").meta.importance).toBe("minor")
    expect(setEventLevel(hub, graph(), "Renewal signed", "major")).toMatchObject({ ok: false, reason: expect.stringMatching(/busy/) })

    // A lock left by a crashed process is taken over.
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(setEventLevel(hub, graph(), "Renewal signed", "major").ok).toBe(true)
    expect(event("Renewal signed").meta.importance).toBe("major")
  })

  it("refuses to set a level on a page that is not an event", () => {
    const r = setEventLevel(hub, graph(), "Office Laptop", "major")
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not an event/)
  })
})
