import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../src/wiki/hub"
import type { WikiArticleMeta } from "../src/wiki/types"
import {
  EnrichState, ENRICH_LIMITS, ShrinkError, assertNoShrink, graphOf, keptText, mergeHistory, parseEnrichReply, pickCandidates, replaceSection, runEnrichment, wholeSentences,
  type EnrichSettings, type ReplyContext,
} from "../src/wiki/enrich"
import { patchEnrichCron, patchWikiEnrich, wikiEnrichSettings } from "../src/wiki/enrich-settings"
import { lensFor, panelData } from "../src/wiki/ontology/lens"
import { clip, entityPage, summaryOf } from "../src/wiki/ontology/view-entity"

const quiet = () => {}

function meta(title: string, extra: Partial<WikiArticleMeta> = {}): WikiArticleMeta {
  return { title, tags: [], owner: "writer", access: "public", created: "2026-01-01", lastUpdated: "2026-01-02", sources: [], ...extra }
}

const settings = (extra: Partial<EnrichSettings> = {}): EnrichSettings => ({
  enabled: true, agent: "curator", types: ["person", "organization", "project", "place"], sources: ["entries"],
  maxPages: 10, maxSpendUsd: 0, maxEntriesPerPage: 40, maxNewEvents: 5, ...extra,
})

describe("wiki enrichment", () => {
  let dir: string
  let hub: WikiHub

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "enrich-"))
    hub = new WikiHub(dir, quiet, "graph")
    const w = hub.getAgentWiki("writer")
    w.writeArticle("people/sample-person.md", meta("Sample Person", { type: "person" }), "Sample Person works with us on the website.\n\n## History\n- 2026-02-10 kickoff", "writer")
    w.writeArticle("clients/example-org.md", meta("Example Org", { tags: ["client"] }), "A client.", "writer")
    w.writeArticle("projects/website-rebuild.md", meta("Website Rebuild", { type: "project" }), "The new website for [[Example Org]].", "writer")
    w.writeArticle("places/sample-city.md", meta("Sample City", { type: "place" }), "Where the office is.", "writer")
    w.writeArticle("events/2026-02-10-kickoff.md", meta("Website kickoff", { type: "event", date: "2026-02-10" }), "Kickoff with [[Sample Person]].", "writer")
    w.writeArticle("agents/helper-agent.md", meta("Helper Agent", { class: "agent" }), "An agent.", "writer")
    hub.getSharedStore().addEntry({ id: "e1", date: "2026-02-10", agentId: "writer", source: "whatsapp", sourceContext: "Sample Person", content: "Kickoff call about the website for Example Org." })
    hub.getSharedStore().addEntry({ id: "e2", date: "2026-09-30", agentId: "writer", source: "email", content: "Sample Person, finance lead at Example Org, approved the invoice." })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function personReply(): string {
    return "Here you go:\n```json\n" + JSON.stringify({
      overview: "Sample Person is our main contact at Example Org. It started with a kickoff call in February 2026. Since then they took over finance. They approved the last invoice in September and the work goes on. And then they",
      basis: "based on 2 messages from 2026-02-10 to 2026-09-30",
      statements: [
        { property: "role_at", value: "Example Org", role: "Finance lead", since: "2026-09", source: "entry:e2" },
        { property: "contact_for", value: "Website Rebuild", source: "entry:e1" },
        { property: "works_with", value: "Helper Agent", source: "entry:e1" },
        { property: "client_of", value: "Example Org", source: "entry:nope" },
        { property: "legal_form", value: "SARL", source: "entry:e1" },
        { property: "works_with", value: "Another Person" },
        { property: "reports_to", value: "Nobody We Know", source: "entry:e1" },
        { property: "contact", value: "email: person@example.com", source: "entry:e2" },
      ],
      history: [
        { date: "2026-02-10", title: "Kickoff", event: "Website kickoff" },
        { date: "2026-09-30", title: "The last invoice was approved" },
      ],
      newEvents: [{ title: "Invoice approved", date: "2026-09-30", summary: "Sample Person approved the invoice.", source: "entry:e2", importance: "major" }],
    }) + "\n```"
  }

  it("refreshes people, organisations, projects and places, never agents or events", async () => {
    const asked: string[] = []
    const run = await runEnrichment({
      hub, settings: settings(), agentIds: ["curator"], today: "2026-10-08",
      ask: async (_p, e) => { asked.push(e.title); return { text: e.title === "Sample Person" ? personReply() : "{}", costUsd: 0.1 } },
    })
    expect(asked.sort()).toEqual(["Example Org", "Sample City", "Sample Person", "Website Rebuild"])
    expect(run.refreshed).toBe(1)
    expect(run.items.filter(i => i.outcome === "nothing-new")).toHaveLength(3)
    expect(run.spentUsd).toBeCloseTo(0.4)

    const g = graphOf(hub)
    const person = g.entities.get(g.names.get("sample person")!)!
    // The curator wrote its own page; the graph merges it into the entity.
    expect(person.pages.map(p => p.agentId).sort()).toEqual(["curator", "writer"])
    const own = person.pages.find(p => p.agentId === "curator")!
    expect(own.article.meta.access).toBe("public")
    const story = "Sample Person is our main contact at Example Org. It started with a kickoff call in February 2026. Since then they took over finance. They approved the last invoice in September and the work goes on."
    expect(own.article.content.startsWith(`## Overview\n\n${story}\n\n_Based on 2 messages`)).toBe(true)
    expect(summaryOf(person, 1600)).toBe(story)

    // Only sourced, allowed, non-agent statements that link to real pages
    // survive, as proposed.
    const st = own.article.meta.statements!
    expect(st.map(s => `${s.property}:${s.value}`)).toEqual(["role_at:Example Org", "contact_for:Website Rebuild", "contact:email: person@example.com"])
    expect(st.every(s => s.status === "proposed" && s.source?.startsWith("entry:"))).toBe(true)

    // Roles and relations panels now show typed items with a source.
    const roles = panelData(g, person, lensFor(g, "person").find(p => p.panel === "roles")!, { full: false, readEntries: () => [] })
    expect(roles.items[0]).toMatchObject({ label: "Example Org", chips: ["Finance lead", "role at"] })
    const projects = panelData(g, person, lensFor(g, "person").find(p => p.panel === "projects")!, { full: false, readEntries: () => [] })
    expect(projects.items.map(i => i.label)).toEqual(["Website Rebuild"])
    const org = g.entities.get(g.names.get("example org")!)!
    const people = panelData(g, org, lensFor(g, "organization").find(p => p.panel === "people")!, { full: false, readEntries: () => [] })
    expect(people.items[0]).toMatchObject({ label: "Sample Person", chips: ["Finance lead", "people"] })

    // History links down to event pages, including the one it created.
    expect(own.article.content).toContain("- 2026-09-30 — [[Invoice approved|The last invoice was approved]]")
    expect(own.article.content.split("## History")[1].match(/2026-09-30/g)).toHaveLength(1)
    expect(own.article.content).toContain("- 2026-02-10 — [[Website kickoff|Kickoff]]")
    const history = panelData(g, person, lensFor(g, "person").find(p => p.panel === "history")!, { full: true, readEntries: () => [] })
    expect(history.items.map(i => i.label).sort()).toEqual(["Invoice approved", "Website kickoff"])
    expect(history.items.every(i => i.entityId)).toBe(true)
    const made = g.entities.get(g.names.get("invoice approved")!)!
    expect(made.type).toBe("event")
    expect(made.importance).toBe("normal") // agents may not set major
    expect(made.statements[0]).toMatchObject({ property: "involves", value: "Sample Person", source: "entry:e2" })

    expect(run.items.find(i => i.title === "Sample Person")!.dropped).toBe(5)

    // The overview card shows the whole overview with its basis.
    const html = entityPage({ g, readEntries: () => [], versions: () => [] }, person)
    expect(html).toContain("the work goes on.</p>")
    expect(html).not.toContain(">Overview</h2>") // not repeated in the notes
    expect(html).toContain("Based on 2 messages from 2026-02-10 to 2026-09-30. Refreshed 2026-10-08.")
  })

  it("skips pages whose sources did not change, and comes back when they do", async () => {
    const ask = async (_p: string, e: { title: string }) => ({ text: e.title === "Sample Person" ? personReply() : "{}", costUsd: 0 })
    await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask })
    const second = await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask })
    expect(second.due).toBe(0)
    expect(second.unchanged).toBe(4)

    hub.getSharedStore().addEntry({ id: "e3", date: "2026-10-01", agentId: "writer", source: "email", content: "A note from Sample Person about the next phase." })
    const third = await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask })
    expect(third.items.map(i => i.title)).toEqual(["Sample Person"])

    // A second refresh updates the same page; the old text is versioned.
    const store = hub.getAgentWiki("curator")
    expect(store.getVersions("entities/sample-person.md").length).toBeGreaterThan(0)
    expect(new EnrichState(dir).load().runs).toHaveLength(3)
  })

  it("stops at the spending cap and the page cap, and retries failures", async () => {
    let n = 0
    const capped = await runEnrichment({
      hub, settings: settings({ maxSpendUsd: 0.25 }), today: "2026-10-08",
      ask: async () => { n++; return { text: "{}", costUsd: 0.1 } },
    })
    expect(n).toBe(2) // a third page would likely pass 0.25
    expect(capped.stoppedBy).toBe("spend cap")

    const pages = await runEnrichment({ hub, settings: settings({ maxPages: 1 }), today: "2026-10-08", ask: async () => ({ text: "", error: "agent busy" }) })
    expect(pages.failed).toBe(1)
    expect(pages.stoppedBy).toBe("max pages")
    const failed = Object.values(new EnrichState(dir).load().pages).find(p => p.outcome === "failed")!
    expect(failed.signature).toBe("")
  })

  it("keeps a long hand-written History, Overview and notes the model never saw", async () => {
    const handHistory = Array.from({ length: 120 }, (_x, i) => `- 2025-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")} — hand note ${i} about the account and what was agreed on that call`)
    const handOverview = "Sample Person has been our contact since 2024. ".repeat(12).trim()
    const content = [
      "## Overview", "", handOverview, "",
      "## Roles and relations", "", "- Met at a trade fair in 2024.", "",
      "## History", "", "- 2026-02-10 kickoff call notes", ...handHistory,
    ].join("\n")
    expect(content.length).toBeGreaterThan(ENRICH_LIMITS.pageChars)
    hub.getAgentWiki("curator").writeArticle("people/sample-person.md", meta("Sample Person", { type: "person", owner: "curator" }), content, "curator")
    const prompts: string[] = []
    const run = await runEnrichment({
      hub, settings: settings(), only: "Sample Person", force: true, today: "2026-10-08",
      ask: async (p) => { prompts.push(p); return { text: personReply() } },
    })
    expect(run.items[0].outcome).toBe("refreshed")
    expect(prompts[0]).not.toContain("hand note 119") // cut at pageChars
    const page = hub.getAgentWiki("curator").readArticle("people/sample-person.md")!
    for (const line of handHistory) expect(page.content).toContain(line)
    // The unlinked line of the same day gains the event link and keeps its words.
    expect(page.content).toContain("- 2026-02-10 — [[Website kickoff|kickoff call notes]]")
    expect(page.content).not.toContain("[[Website kickoff|Kickoff]]")
    expect(page.content).toContain("- 2026-09-30 — [[Invoice approved|The last invoice was approved]]")
    // The longer hand-written Overview and the hand-written relation stay.
    expect(page.content).toContain(handOverview)
    expect(page.content).toContain("- Met at a trade fair in 2024.")
    expect(page.content).toContain("- Role at [[Example Org]] (Finance lead, 2026-09 to now). Source: entry:e2.")
    expect(keptText(page.content).lines).toBeGreaterThan(keptText(content).lines)
  })

  it("leaves a page alone after repeated failures, and lists failed pages last", async () => {
    const asked: string[] = []
    const failing = async (_p: string, e: { title: string }) => { asked.push(e.title); return e.title === "Sample Person" ? { text: "", error: "agent busy" } : { text: "{}" } }
    await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask: failing })
    hub.getAgentWiki("writer").writeArticle("people/other-person.md", meta("Other Person", { type: "person" }), "Another contact.", "writer")
    asked.length = 0
    await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask: failing })
    expect(asked).toEqual(["Other Person", "Sample Person"]) // new first, the retry last
    asked.length = 0
    const third = await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask: failing })
    expect(third.items.map(i => i.title)).toEqual(["Sample Person"])
    expect(new EnrichState(dir).load().pages["sample person"]).toMatchObject({ outcome: "failed", failures: 3 })

    asked.length = 0
    const fourth = await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask: failing })
    expect(asked).toEqual([])
    expect(fourth.givenUp).toBe(1)

    // New inputs give it another chance.
    hub.getSharedStore().addEntry({ id: "e9", date: "2026-10-05", agentId: "writer", source: "email", content: "Sample Person sent the signed contract." })
    const fifth = await runEnrichment({ hub, settings: settings(), today: "2026-10-08", ask: async () => ({ text: personReply() }) })
    expect(fifth.items.map(i => i.title)).toContain("Sample Person")
    expect(new EnrichState(dir).load().pages["sample person"]).toMatchObject({ outcome: "refreshed" })
    expect(new EnrichState(dir).load().pages["sample person"].failures).toBeUndefined()
  })

  it("refuses a page limit that is not a whole number", async () => {
    await expect(runEnrichment({ hub, settings: settings(), limit: Number("abc"), today: "2026-10-08", ask: async () => ({ text: "{}" }) })).rejects.toThrow(/whole number/)
  })

  it("drops History items with no source or event page, and quotes from new titles", async () => {
    const reply = JSON.stringify({
      history: [{ date: "2026-03-01", title: "Something we heard" }, { date: "2026-04-01", title: "Signed the order", source: "entry:e2" }],
      newEvents: [{ title: 'The "big" launch', date: "2026-05-01", summary: "It launched.", source: "entry:e1" }],
    })
    const run = await runEnrichment({ hub, settings: settings(), dryRun: true, only: "Sample Person", force: true, today: "2026-10-08", ask: async () => ({ text: reply }) })
    const plan = run.items[0].plan!
    expect(plan.dropped).toContain("history Something we heard: no event page and no source the run can check")
    expect(plan.history).toEqual(["2026-05-01 The big launch → The big launch", "2026-04-01 Signed the order"])
    expect(plan.newEvents[0]).toBe("2026-05-01 The big launch (normal) · entry:e1")
  })

  it("writes nothing on a dry run", async () => {
    const run = await runEnrichment({ hub, settings: settings(), dryRun: true, only: "Sample Person", force: true, today: "2026-10-08", ask: async () => ({ text: personReply() }) })
    expect(run.items).toHaveLength(1)
    expect(run.items[0].statements).toBe(3)
    expect(run.items[0].plan!.statements[0]).toBe("role_at: Example Org (Finance lead) [2026-09 → now] · entry:e2")
    expect(run.items[0].plan!.dropped.some(d => d.includes("no page with that title"))).toBe(true)
    expect(hub.getAgentWiki("curator").listAllArticles()).toHaveLength(0)
    expect(new EnrichState(dir).load().runs).toHaveLength(0)
  })

  it("never writes a private page's text onto a shared page", async () => {
    hub.getAgentWiki("writer").writeArticle("people/secret.md", meta("Secret Person", { type: "person", access: "private" }), "Private detail.", "writer")
    const prompts: string[] = []
    await runEnrichment({ hub, settings: settings(), only: "Secret Person", today: "2026-10-08", ask: async (p) => { prompts.push(p); return { text: JSON.stringify({ overview: "A person we know." }) } } })
    const page = hub.getAgentWiki("curator").readArticle("entities/secret-person.md")!
    expect(page.meta.access).toBe("private")
    expect(prompts[0]).toContain("Private detail.")
  })

  it("types a page named after an agent as an agent, unless a person shares the first name", () => {
    const w = hub.getAgentWiki("writer")
    w.writeArticle("people/robo.md", meta("Robo", { type: "person" }), "Our assistant.", "writer")
    w.writeArticle("people/sam.md", meta("Sam", { type: "person" }), "Sam.", "writer")
    w.writeArticle("people/sam-example.md", meta("Sam Example", { type: "person" }), "A person.", "writer")
    const g = graphOf(hub, ["robo", "Sam"])
    expect(g.entities.get(g.names.get("robo")!)!.type).toBe("agent")
    const sam = g.entities.get(g.names.get("sam")!)!
    expect(sam.type).toBe("person")
    expect(sam.review).toMatch(/agent's name and the first name of Sam Example/)
  })

  it("does not retype an organisation that shares an agent's name", () => {
    hub.getAgentWiki("writer").writeArticle("clients/robo.md", meta("Robo", { class: "organization" }), "A client.", "writer")
    const g = graphOf(hub, ["robo"])
    const robo = g.entities.get(g.names.get("robo")!)!
    expect(robo.type).toBe("organization")
    expect(robo.review).toMatch(/typed organization/)
  })

  it("picks never-enriched pages first, and leaves out agent pages", () => {
    const g = graphOf(hub)
    const { due } = pickCandidates(g, hub.getSharedStore().listEntries(), { version: 1, pages: {}, runs: [] }, { types: ["person", "agent", "organization"], maxEntriesPerPage: 10 })
    expect(due.map(d => d.entity.title)).toEqual(["Sample Person", "Example Org"])
    expect(due[0].entries.map(e => e.id)).toEqual(["e2", "e1"])
  })
})

describe("enrichment reply checks", () => {
  it("keeps whole sentences only", () => {
    expect(wholeSentences("One. Two is cut", 500)).toBe("One.")
    expect(wholeSentences("No full stop at all", 500)).toBe("")
    expect(wholeSentences("Ends well.", 500)).toBe("Ends well.")
    expect(wholeSentences("Trailing dots...", 500)).toBe("")
  })

  it("refuses a reply without JSON", () => {
    const ctx = { g: { names: new Map(), entities: new Map(), ontology: { properties: [], types: [], importance: { major_set_by: "owner" } } } } as unknown as ReplyContext
    expect(parseEnrichReply("I could not find anything.", ctx)).toEqual({ error: "the reply held no JSON object" })
  })

  it("merges History without losing a line", () => {
    const old = "Written by hand.\n\n- 2026-01-05 — [[Planning day]]: long notes kept\n- 2026-02-10 kickoff\n- undated memory"
    const merged = mergeHistory(old, [
      { date: "2026-01-05", text: "Planning", event: "Planning day" },
      { date: "2026-02-10", text: "Kickoff", event: "Website kickoff" },
      { date: "2026-03-01", text: "Signed", source: "entry:e1" },
    ])
    expect(merged).toBe("Written by hand.\n\n- 2026-03-01 — Signed _(entry:e1)_\n- 2026-02-10 — [[Website kickoff|kickoff]]\n- 2026-01-05 — [[Planning day]]: long notes kept\n- undated memory")
  })

  it("refuses a write that shortens the page outside the Overview", () => {
    const before = "## Overview\n\nOld story.\n\n## History\n\n- 2026-01-01 — one\n- 2026-01-02 — two"
    expect(() => assertNoShrink(before, "## Overview\n\nA new, much longer story.\n\n## History\n\n- 2026-01-01 — one\n- 2026-01-02 — two", "p.md")).not.toThrow()
    expect(() => assertNoShrink(before, "## Overview\n\nNew.\n\n## History\n\n- 2026-01-02 — two", "p.md")).toThrow(ShrinkError)
    // Statement lines are rebuilt from the statements and do not count.
    expect(keptText("## Roles and relations\n\n- Role at [[X]]. Source: entry:1.\n- Met at a fair.")).toEqual({ lines: 2, chars: "##Rolesandrelations-Metatafair.".length })
  })

  it("replaces a section in place or adds it", () => {
    expect(replaceSection("Intro.\n\n## History\n- old\n\n## Notes\nkeep", "History", "- new", "end")).toBe("Intro.\n\n## History\n\n- new\n\n## Notes\nkeep")
    expect(replaceSection("Body.", "Overview", "Story.", "top")).toBe("## Overview\n\nStory.\n\nBody.")
  })

  it("clips a fallback summary at a sentence, never mid-word", () => {
    expect(clip("First sentence here. Second sentence goes on and on.", 30)).toBe("First sentence here.")
    expect(clip("one two three four five six", 12)).toBe("one two…")
  })
})

describe("enrichment settings", () => {
  it("fills defaults and checks a patch", () => {
    expect(wikiEnrichSettings(undefined)).toMatchObject({ enabled: false, sources: ["entries", "contacts"], maxPages: 10, maxSpendUsd: 2 })
    const cfg: any = { agents: { curator: {} }, crons: {} }
    expect(() => patchWikiEnrich(cfg, { enabled: true })).toThrow(/set the agent first/)
    expect(() => patchWikiEnrich(cfg, { agent: "ghost" })).toThrow(/no agent "ghost"/)
    expect(() => patchWikiEnrich(cfg, { types: ["person", "agent"] })).toThrow(/agents are not enriched/)
    expect(() => patchWikiEnrich(cfg, { sources: ["entries", "fax"] })).toThrow(/unknown source fax/)
    expect(() => patchWikiEnrich(cfg, { maxSpendUsd: -1 })).toThrow(/spending cap/)
    patchWikiEnrich(cfg, { agent: "curator", enabled: true, sources: ["entries", "web"], maxSpendUsd: 1.5 })
    expect(cfg.wikiEnrich).toEqual({ agent: "curator", enabled: true, sources: ["entries", "web"], maxSpendUsd: 1.5 })
    patchEnrichCron(cfg, "0 3 * * *", "/opt/agentx/dist/cli.js", "Europe/Paris")
    expect(cfg.crons["wiki-enrich"]).toMatchObject({ schedule: "0 3 * * *", timezone: "Europe/Paris", agent: "curator", command: "node /opt/agentx/dist/cli.js wiki enrich run" })
    expect(() => patchEnrichCron(cfg, "daily", "x")).toThrow(/five-field/)
    patchEnrichCron(cfg, "", "x")
    expect(cfg.crons["wiki-enrich"]).toBeUndefined()
  })
})

describe("agent names", () => {
  it("reads ids, names and the persona name from IDENTITY.md", async () => {
    const { agentNamesOf, identityName } = await import("../src/wiki/ontology/agent-names")
    expect(identityName("# Identity\n- **Name:** Robo Helper\n- Role: assistant")).toBe("Robo Helper")
    const dir = mkdtempSync(join(tmpdir(), "names-"))
    try {
      const { mkdirSync, writeFileSync } = await import("fs")
      mkdirSync(join(dir, "ws"))
      writeFileSync(join(dir, "ws", "IDENTITY.md"), "Name: Persona Bot\n")
      expect(agentNamesOf({ helper: { name: "Helper", workspace: "ws" }, cx: { name: "cx" } }, dir)).toEqual(["Helper", "Persona Bot", "cx", "helper"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
