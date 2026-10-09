import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execSync: mocks.execSync }))

import { WikiHub } from "../../src/wiki/hub"
import { FactLedger, factId } from "../../src/wiki/facts/ledger"
import {
  applyFactLines, approveHeld, listHeld, listPendingBatches, mergeContributions,
  parseContributionPatches, rejectHeld, runContribution, type ContributionCall,
} from "../../src/wiki/contributions"
import { lostStructuredFacts, patchProblems } from "../../src/wiki/fact-guard"
import { agenticQuery } from "../../src/wiki/query"
import { buildReport, compareReports, matchFacts, parseQuestionSet } from "../../src/wiki/score"
import { daemonConfigSchema, withContributionJobs } from "../../src/daemon/config"
import { wiki } from "../../src/commands/wiki"
import type { WikiArticleMeta } from "../../src/wiki/types"

const NOW = Date.parse("2026-10-08T21:00:00Z")
let dir: string
let hub: WikiHub

function page(agent: string, path: string, title: string, body: string, extra: Partial<WikiArticleMeta> = {}): void {
  hub.getAgentWiki(agent).writeArticle(path, {
    title, tags: [], owner: agent, access: "public", created: "2026-09-01", lastUpdated: "2026-09-01", sources: [], ...extra,
  }, body, agent)
}

function read(agent: string, path: string) {
  return hub.getAgentWiki(agent).readArticle(path)!
}

function chat(agent: string, id: string, date: string, content: string): void {
  hub.getSharedStore().addEntry({ id, date, agentId: agent, source: "telegram", content })
}

/** A model that answers every call with `patches`, at `cost` dollars. */
function model(patches: unknown[], cost = 0.01): ContributionCall & { prompts: string[]; budgets: number[] } {
  const prompts: string[] = []
  const budgets: number[] = []
  const fn = (async (prompt: string, budget: number) => {
    prompts.push(prompt)
    budgets.push(budget)
    return { text: JSON.stringify(patches), costUsd: cost }
  }) as ContributionCall & { prompts: string[]; budgets: number[] }
  fn.prompts = prompts
  fn.budgets = budgets
  return fn
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-contrib-"))
  hub = new WikiHub(dir, () => {})
  mocks.execSync.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("parseContributionPatches", () => {
  it("drops a patch without a source or a check date", () => {
    const out = parseContributionPatches(JSON.stringify([
      { kind: "add", page: "Vendor", attribute: "phone", value: "+1 555 0100", source: "contacts app", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "add", page: "Vendor", attribute: "email", value: "a@example.com", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "add", page: "Vendor", attribute: "email", value: "a@example.com", source: "mail" },
      { kind: "rewrite", page: "Vendor", body: "everything", source: "x", checkedAt: "2026-10-08T09:00:00Z" },
    ]), "agent-a", { now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "add", attribute: "phone", agentId: "agent-a" })
    expect(out[0]).not.toHaveProperty("body")
  })

  it("does not date a check after the run", () => {
    const [p] = parseContributionPatches(JSON.stringify([
      { kind: "add", page: "Vendor", attribute: "phone", value: "1", source: "s", checkedAt: "2099-01-01T00:00:00Z" },
    ]), "a", { now: NOW })
    expect(p.checkedAt).toBe(new Date(NOW).toISOString())
  })
})

describe("runContribution", () => {
  it("queues sourced patches from the agent's work and never re-reads it", async () => {
    page("agent-a", "orgs/vendor.md", "Vendor Co", "Vendor Co supplies parts.")
    chat("agent-a", "e1", "2026-10-08", "Checked the billing app: Vendor Co invoice 2041 is paid.")
    chat("agent-b", "e2", "2026-10-08", "Unrelated work of another agent.")
    const call = model([{ kind: "add", page: "Vendor Co", attribute: "invoice 2041", value: "paid", source: "billing app", checkedAt: "2026-10-08T10:00:00Z" }])

    const batch = await runContribution(hub, dir, "agent-a", { model: "m", call, now: NOW })

    expect(batch.patches).toHaveLength(1)
    expect(batch.workIds).toEqual(["e1"])
    expect(call.prompts[0]).toContain("invoice 2041 is paid")
    expect(call.prompts[0]).toContain("### Vendor Co")
    expect(call.prompts[0]).not.toContain("another agent")
    expect(listPendingBatches(dir)).toHaveLength(1)

    const again = await runContribution(hub, dir, "agent-a", { model: "m", call, now: NOW + 60_000 })
    expect(again.workIds).toEqual([])
    expect(call.prompts).toHaveLength(1)
  })

  it("stops at the patch cap and at the cost cap, and caps each call at what is left", async () => {
    for (let i = 0; i < 40; i++) chat("agent-a", `e${String(i).padStart(2, "0")}`, "2026-10-08", `work ${i}`)
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "add", page: `P${i}`, attribute: "a", value: String(i), source: "s", checkedAt: "2026-10-08T10:00:00Z" }))

    const capped = await runContribution(hub, dir, "agent-a", { model: "m", call: model(many), maxPatches: 5, now: NOW, dryRun: true })
    expect(capped.patches).toHaveLength(5)
    expect(capped.stoppedBy).toBe("max-patches")

    const call = model([], 0.3)
    const spent = await runContribution(hub, dir, "agent-a", { model: "m", call, maxCostUsd: 0.5, now: NOW, dryRun: true })
    expect(spent.calls).toBe(2)
    expect(spent.stoppedBy).toBe("max-cost")
    expect(call.budgets[0]).toBe(0.5)
    expect(call.budgets[1]).toBeCloseTo(0.2)
  })

  it("leaves the cursor on the first unread item when a cap cuts the run short", async () => {
    for (let i = 0; i < 30; i++) chat("agent-a", `e${String(i).padStart(2, "0")}`, "2026-10-08", `work ${i}`)
    const first = await runContribution(hub, dir, "agent-a", { model: "m", call: model([]), maxItems: 12, now: NOW })
    expect(first.stoppedBy).toBe("max-items")
    const second = await runContribution(hub, dir, "agent-a", { model: "m", call: model([]), maxItems: 100, now: NOW + 1000 })
    expect(second.workIds).toHaveLength(18)
    expect(second.workIds).not.toContain(first.workIds[0])
  })
})

describe("mergeContributions", () => {
  const queue = async (agent: string, patches: unknown[]) => {
    chat(agent, `w-${agent}-${Math.random().toString(36).slice(2, 8)}`, "2026-10-08", "work")
    await runContribution(hub, dir, agent, { model: "m", call: model(patches), now: NOW })
  }

  it("keeps the newest checked fact and the older one in history", async () => {
    page("agent-a", "orgs/vendor.md", "Vendor Co", "Vendor Co supplies parts.")
    await queue("agent-a", [{ kind: "add", page: "Vendor Co", attribute: "billing status", value: "paid", source: "billing app", checkedAt: "2026-10-08T12:00:00Z" }])
    await queue("agent-b", [{ kind: "add", page: "Vendor Co", attribute: "billing status", value: "overdue", source: "old export", checkedAt: "2026-10-01T12:00:00Z" }])

    const report = mergeContributions(hub, dir, { now: NOW })

    const fact = new FactLedger(dir).get(factId("Vendor Co", "billing status"))!
    expect(fact.value).toBe("paid")
    expect(fact.history?.map((h) => h.value)).toEqual(["overdue"])
    const body = read("agent-a", "orgs/vendor.md").content
    expect(body).toContain("Vendor Co supplies parts.")
    expect(body).toMatch(/\*\*billing status:\*\* paid — billing app; checked 2026-10-08 by agent-a \(previously: overdue, checked 2026-10-01\)/)
    expect(hub.getAgentWiki("agent-a").getVersions("orgs/vendor.md").length).toBeGreaterThan(0)
    expect(report.pagesUpdated).toEqual(["agent-a/orgs/vendor.md"])
    expect(listPendingBatches(dir)).toHaveLength(0)
    expect(readdirSync(resolve(dir, "_contributions", "merged"))).toHaveLength(2)
  })

  it("raises a question instead of applying a check older than the wiki's", async () => {
    page("agent-a", "orgs/vendor.md", "Vendor Co", "Vendor Co supplies parts.")
    new FactLedger(dir).write({ subject: "Vendor Co", attribute: "billing status", value: "paid", source: "billing app", verifiedBy: "agent-a", verifiedAt: "2026-10-08T12:00:00Z" }, { now: NOW })
    await queue("agent-b", [{ kind: "add", page: "Vendor Co", attribute: "billing status", value: "overdue", source: "old export", checkedAt: "2026-10-01T12:00:00Z" }])

    const report = mergeContributions(hub, dir, { now: NOW })

    expect(report.contradictions).toHaveLength(1)
    expect(read("agent-a", "orgs/vendor.md").content).not.toContain("overdue")
  })

  it("corrects the exact wrong text in place and keeps the old value on the fact line", async () => {
    page("agent-a", "hosts/prod.md", "Prod Host", "The production host runs release 0.117.0 in region east.")
    await queue("agent-a", [{ kind: "correct", page: "Prod Host", attribute: "release", previous: "0.117.0", value: "0.126.2", source: "/health", checkedAt: "2026-10-08T09:00:00Z" }])

    const report = mergeContributions(hub, dir, { now: NOW })

    const body = read("agent-a", "hosts/prod.md").content
    expect(body).toContain("runs release 0.126.2 in region east")
    expect(body).toContain("previously: 0.117.0")
    expect(report.held).toHaveLength(0)
  })

  it("holds a patch that removes a fact; a person approves or rejects it", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "Sam is the main contact. Phone +1 555 0100.")
    await queue("agent-b", [
      { kind: "remove", page: "Sam Doe", previous: "Phone +1 555 0100.", source: "chat", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "remove", page: "Sam Doe", previous: "Sam is the main contact.", source: "chat", checkedAt: "2026-10-08T09:01:00Z" },
    ])

    const report = mergeContributions(hub, dir, { now: NOW })

    expect(report.held.map((h) => h.reason)).toEqual(["removes a fact", "removes a fact"])
    expect(read("agent-a", "people/sam.md").content).toContain("+1 555 0100")
    const [phone, marker] = listHeld(dir)

    const ok = approveHeld(hub, dir, phone.id, { by: "operator", now: NOW })
    expect(ok.ok).toBe(true)
    expect(read("agent-a", "people/sam.md").content).not.toContain("555 0100")
    expect(rejectHeld(dir, marker.id).ok).toBe(true)
    expect(read("agent-a", "people/sam.md").content).toContain("main contact")
    expect(listHeld(dir)).toHaveLength(0)
    expect(listHeld(dir, { all: true }).map((h) => h.status)).toEqual(["approved", "rejected"])
  })

  it("makes one page from several agents' creates, and adds to a page that exists", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "Sam works on the portal.", { aliases: ["Sam D."] })
    await queue("agent-a", [
      { kind: "create", page: "Acme Ltd", pageType: "project", summary: "A client.", source: "chat", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "create", page: "Sam D.", pageType: "person", summary: "A developer.", source: "chat", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "add", page: "Sam D.", attribute: "role", value: "developer", source: "chat", checkedAt: "2026-10-08T09:00:00Z" },
    ])
    await queue("agent-b", [
      { kind: "create", page: "ACME Ltd.", summary: "Client of the agency.", source: "mail", checkedAt: "2026-10-08T10:00:00Z" },
      { kind: "add", page: "Acme Ltd", attribute: "phone", value: "+1 555 0199", source: "mail", checkedAt: "2026-10-08T10:00:00Z" },
    ])

    const report = mergeContributions(hub, dir, { now: NOW })

    expect(report.pagesCreated).toEqual(["agent-a/projects/acme-ltd.md"])
    const acme = read("agent-a", "projects/acme-ltd.md")
    expect(acme.content).toContain("A client. Client of the agency.")
    expect(acme.content).toContain("**phone:** +1 555 0199")
    expect(read("agent-a", "people/sam.md").content).toContain("**role:** developer")
  })

  it("lists subjects with more than one page", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "One.")
    page("agent-b", "people/sam-doe.md", "Sam Doe", "Two.")
    await queue("agent-a", [{ kind: "add", page: "Sam Doe", attribute: "x", value: "1", source: "s", checkedAt: "2026-10-08T09:00:00Z" }])
    const report = mergeContributions(hub, dir, { now: NOW, dryRun: true })
    expect(report.duplicates).toEqual([{ title: "Sam Doe", pages: ["agent-a/people/sam.md", "agent-b/people/sam-doe.md"] }])
    expect(listPendingBatches(dir)).toHaveLength(1)
  })
})

describe("applyFactLines", () => {
  it("only touches the Checked facts section", () => {
    const body = "Intro.\n\n## History\n\nSomething happened."
    const { body: out } = applyFactLines(body, [{ attribute: "phone", value: "1", source: "s", checkedAt: "2026-10-08", by: "a" }])
    expect(out.startsWith("Intro.\n\n## History\n\nSomething happened.\n\n## Checked facts")).toBe(true)
    const { body: again } = applyFactLines(out, [{ attribute: "Phone", value: "2", source: "s", checkedAt: "2026-10-09", by: "b" }])
    expect(again.match(/\*\*/g)).toHaveLength(2)
    expect(again).toContain("**phone:** 2 — s; checked 2026-10-09 by b (previously: 1, checked 2026-10-08)")
    expect(again).not.toContain("**Phone:**")
  })
})

describe("fact-loss guard", () => {
  it("finds a lost phone, email, role and contact marker", () => {
    const before = "Sam is the main contact.\nRole: billing lead\nPhone: +1 555 0100\nMail: sam@example.com"
    const lost = lostStructuredFacts(before, "Sam works here.")
    expect(lost.join(" | ")).toMatch(/555/)
    expect(lost).toContain("email sam@example.com")
    expect(lost).toContain('marker "main contact"')
    expect(lost).toContain('role "billing lead"')
    expect(lostStructuredFacts(before, "Sam works here.", [before])).toEqual([])
  })

  it("flags a patch that shrinks the page, adds commentary or repeats a heading", () => {
    const before = ["# Title", "one", "two", "three", "four", "five", "six", "seven"].join("\n")
    expect(patchProblems(before, "# Title\n## New\nonly this")[0]).toMatch(/shrinks from 8 to 3 lines/)
    expect(patchProblems(before, `${before}\nWait — I must output the full article body`).join()).toMatch(/commentary/)
    expect(patchProblems(before, `${before}\n# Title`).join()).toMatch(/appears 2 times/)
    expect(patchProblems(before, `${before}\n- added line`)).toEqual([])
  })
})

describe("wiki patch", () => {
  it("refuses a patch that drops facts, and keeps the page as it was", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "Sam is the main contact.\nPhone +1 555 0100.\nWorks on [[Portal]].\nLine four.\nLine five.", { related: ["Portal"] })
    mocks.execSync.mockReturnValue(JSON.stringify({ result: "## New\nSam likes tea." }))
    vi.spyOn(console, "log").mockImplementation(() => {})

    await wiki.parseAsync(["patch", "agent-a", "Sam Doe", "add that Sam likes tea", "--dir", dir, "--yes"], { from: "user" })

    expect(process.exitCode).toBe(1)
    expect(read("agent-a", "people/sam.md").content).toContain("+1 555 0100")
  })

  it("keeps the related links it had", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "Sam works on [[Portal]].", { related: ["Portal", "Legal Identity"] })
    mocks.execSync.mockReturnValue(JSON.stringify({ result: "Sam works on [[Portal]] and [[Billing]]." }))
    vi.spyOn(console, "log").mockImplementation(() => {})

    await wiki.parseAsync(["patch", "agent-a", "Sam Doe", "add billing", "--dir", dir, "--yes"], { from: "user" })

    expect(read("agent-a", "people/sam.md").meta.related).toEqual(["Portal", "Legal Identity", "Billing"])
  })
})

describe("shared search", () => {
  it("finds an answer that is only in another agent's readable pages", async () => {
    page("agent-a", "notes/own.md", "Own Note", "Nothing relevant.")
    page("agent-b", "rules/doing.md", "One Issue In Doing", "Each person keeps one issue in Doing.")
    page("agent-b", "secret.md", "Private Plan", "Hidden.", { access: "private" })
    hub.getAgentWiki("agent-a").rebuildIndex()
    const prompts: string[] = []
    mocks.execSync.mockImplementation((cmd: string) => {
      const file = cmd.match(/cat '([^']+)'/)![1]
      const prompt = readFileSync(file, "utf-8")
      prompts.push(prompt)
      if (prompt.includes("You are picking candidate articles")) {
        return JSON.stringify({ result: JSON.stringify([{ title: "One Issue In Doing", path: "@agent-b/rules/doing.md" }]) })
      }
      return JSON.stringify({ result: "One issue in Doing per person [One Issue In Doing]." })
    })

    const r = await agenticQuery("how many issues in doing per person?", hub.getAgentWiki("agent-a"), "agent-a", { shared: hub.sharedScope("agent-a") })

    expect(r.status).toBe("ok")
    expect(r.citations.map((c) => c.path)).toEqual(["@agent-b/rules/doing.md"])
    expect(prompts[0]).toContain("@agent-b/rules/doing.md")
    expect(prompts[0]).not.toContain("Private Plan")
    expect(prompts[1]).toContain("owner: agent-b, updated: 2026-09-01")
  })
})

describe("wiki score", () => {
  it("scores answers by the facts they contain and compares two runs", () => {
    const qs = parseQuestionSet('{"question": "phone?", "expect": ["+1 555 0100"]}\n{"id": "b", "question": "status?", "expect": ["paid", "2041"]}')
    expect(matchFacts("Call 1-555-0100.", ["+1 555 0100"]).found).toHaveLength(1)
    const before = buildReport({ questions: "q", agent: "a", shared: false }, [
      { q: qs[0], answer: "unknown", status: "ok", citations: [] },
      { q: qs[1], answer: "Invoice 2041 is overdue", status: "ok", citations: [] },
    ])
    const after = buildReport({ questions: "q", agent: "a", shared: true }, [
      { q: qs[0], answer: "+1 555 0100", status: "ok", citations: [] },
      { q: qs[1], answer: "Invoice 2041 is paid", status: "ok", citations: [] },
    ])
    expect(before.score).toBe(0.25)
    expect(after.score).toBe(1)
    const diff = compareReports(before, after)
    expect(diff.deltas.find((d) => d.id === "b")?.gained).toEqual(["paid"])
  })

  it("records settings, time and cost per question, and names what changed between two runs", () => {
    const qs = parseQuestionSet('{"id": "a", "question": "phone?", "expect": ["+1 555 0100"]}\n{"id": "b", "question": "status?", "expect": ["paid"]}')
    const settings = { method: "summaries", linkedPages: 0, linkedChars: 6000, live: true, notes: true, navigatorModel: "haiku", answerModel: "sonnet", catalogSelectorModel: "haiku", catalogSynthModel: "sonnet" }
    const before = buildReport({ questions: "q", agent: "x", shared: true, settings }, [
      { q: qs[0], answer: "unknown", status: "ok", citations: [], method: "summaries", ms: 4000, costUsd: 0.02 },
      { q: qs[1], answer: "paid", status: "ok", citations: [], method: "summaries", ms: 6000, costUsd: 0.04 },
    ])
    const after = buildReport({ questions: "q", agent: "x", shared: true, settings: { ...settings, linkedPages: 2 } }, [
      { q: qs[0], answer: "+1 555 0100", status: "ok", citations: [], method: "summaries", ms: 5000, costUsd: 0.03 },
      { q: qs[1], answer: "paid", status: "ok", citations: [], method: "catalog", ms: 7000 },
    ])
    expect(before.settings).toEqual(settings)
    expect(after.results[1]).not.toHaveProperty("costUsd")

    const diff = compareReports(before, after)
    expect(diff.changed).toEqual(["linkedPages: 0 → 2"])
    expect(diff.onlyBefore).toEqual([])
    expect(diff.cost.before).toEqual({ meanMs: 5000, meanCostUsd: expect.closeTo(0.03), unpriced: 0 })
    expect(diff.cost.after).toEqual({ meanMs: 6000, meanCostUsd: 0.03, unpriced: 1 })
    expect(diff.deltas[0]).toMatchObject({ id: "a", before: 0, after: 1, ms: { before: 4000, after: 5000 }, costUsd: { before: 0.02, after: 0.03 } })

    // Three settings at once, a different question set, a report with no settings.
    const mixed = buildReport({ questions: "q", agent: "x", shared: true, settings: { ...settings, linkedPages: 2, live: false, notes: false } }, [
      { q: { id: "c", question: "new?", expect: ["x"] }, answer: "x", status: "ok", citations: [] },
    ])
    const many = compareReports(before, mixed)
    expect(many.changed).toHaveLength(3)
    expect(many).toMatchObject({ onlyBefore: ["a", "b"], onlyAfter: ["c"] })
    const { settings: _, ...old } = before
    expect(compareReports(old, after).changed).toBe("unknown")
  })

  it("accepts any one spelling of a fact written as a|b", () => {
    const { found, missing } = matchFacts("Due 31/03/2027, total 24 148,725 DT.", ["2027-03-31|31/03/2027", "24148.725|24 148,725", "paid|settled"])
    expect(found).toEqual(["2027-03-31|31/03/2027", "24148.725|24 148,725"])
    expect(missing).toEqual(["paid|settled"])
  })
})

describe("scheduled jobs", () => {
  const node = { id: "node-1", name: "Node" }
  const base = { node, agents: { "agent-a": { name: "A", workspace: "/w" } } }

  it("adds no job until an agent opts in", () => {
    const config = withContributionJobs(daemonConfigSchema.parse(base), "agentx")
    expect(config.crons["wiki-contribute"]).toBeUndefined()
  })

  it("adds the contribute and merge jobs, and an operator's job of the same id wins", () => {
    const on = { node, agents: { "agent-a": { name: "A", workspace: "/w", wiki: { contribute: { enabled: true } } } } }
    const config = withContributionJobs(daemonConfigSchema.parse(on), "agentx")
    expect(config.crons["wiki-contribute"]).toMatchObject({ schedule: "40 22 * * *", command: "agentx wiki contribute --all" })
    expect(config.crons["wiki-contribute-merge"]).toMatchObject({ command: "agentx wiki contributions merge" })

    const own = daemonConfigSchema.parse({ ...on, crons: { "wiki-contribute": { schedule: "0 5 * * *", agent: "agent-a", command: "true" } } })
    expect(withContributionJobs(own, "agentx").crons["wiki-contribute"].schedule).toBe("0 5 * * *")
  })
})

it("keeps the held file off the article index", async () => {
  page("agent-a", "people/sam.md", "Sam Doe", "Phone +1 555 0100.")
  chat("agent-b", "w1", "2026-10-08", "work")
  await runContribution(hub, dir, "agent-b", { model: "m", call: model([{ kind: "remove", page: "Sam Doe", previous: "Phone +1 555 0100.", source: "s", checkedAt: "2026-10-08T09:00:00Z" }]), now: NOW })
  mergeContributions(hub, dir, { now: NOW })
  expect(existsSync(resolve(dir, "_contributions", "held.json"))).toBe(true)
  expect(hub.getSharedStore().rebuildIndex().articles.map((a) => a.path).filter((p) => p.includes("_contributions"))).toEqual([])
})

describe("wiki contribute enable", () => {
  it("writes the switch and the limits given on the command line", async () => {
    const { writeFileSync } = await import("fs")
    const file = resolve(dir, "agentx.json")
    writeFileSync(file, JSON.stringify({ node: { id: "n", name: "N" }, agents: { "agent-a": { name: "A", workspace: "/w" } } }))
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))

    await wiki.parseAsync(["contribute", "enable", "agent-a", "--max-cost", "0.3", "--max-patches", "20", "-c", file], { from: "user" })

    const saved = JSON.parse(readFileSync(file, "utf-8"))
    expect(saved.agents["agent-a"].wiki.contribute).toEqual({ enabled: true, maxCostUsd: 0.3, maxPatches: 20 })
  })
})

describe("#824 review fixes", () => {
  const queue = async (agent: string, patches: unknown[]) => {
    chat(agent, `w-${agent}-${Math.random().toString(36).slice(2, 8)}`, "2026-10-08", "work")
    await runContribution(hub, dir, agent, { model: "m", call: model(patches), now: NOW })
  }

  it("treats a longer title for an existing page as a possible duplicate, not a new subject", async () => {
    const { possibleDuplicate } = await import("../../src/wiki/contributions")
    const pages = [
      { title: "Tax Payment Plan", type: "concept" as const, ref: "a/concepts/plan.md" },
      { title: "Invoice 2041 Example Ltd", type: "event" as const, ref: "a/events/2041.md" },
      { title: "Sam Doe", type: "person" as const, ref: "a/people/sam.md" },
    ]
    expect(possibleDuplicate("Tax Payment Plan (Échéancier) Engagement 4471", "project", pages)).toContain("Tax Payment Plan")
    expect(possibleDuplicate("Invoice 2042 Example Ltd", "event", pages)).toBeUndefined()
    expect(possibleDuplicate("Sam Doe Consulting", "project", pages)).toBeUndefined()
    expect(possibleDuplicate("Payroll Calendar", "concept", pages)).toBeUndefined()
  })

  it("holds a create that looks like an existing page, with its facts; approving creates it", async () => {
    page("agent-a", "concepts/plan.md", "Tax Payment Plan", "The plan amount is unknown.", { type: "concept" })
    await queue("agent-a", [
      { kind: "create", page: "Tax Payment Plan Engagement 4471", pageType: "project", summary: "A payment plan.", source: "tax portal", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "add", page: "Tax Payment Plan Engagement 4471", attribute: "amount", value: "1200", source: "tax portal", checkedAt: "2026-10-08T09:00:00Z" },
    ])

    const report = mergeContributions(hub, dir, { now: NOW })

    expect(report.pagesCreated).toEqual([])
    expect(report.held.map((h) => h.reason)).toEqual([
      'possible duplicate of "Tax Payment Plan" (agent-a/concepts/plan.md)',
      'possible duplicate of "Tax Payment Plan" (agent-a/concepts/plan.md)',
    ])
    const create = listHeld(dir).find((h) => h.patch.kind === "create")!
    const r = approveHeld(hub, dir, create.id, { now: NOW })
    expect(r.ok && r.page).toBe("agent-a/projects/tax-payment-plan-engagement-4471.md")
  })

  it("does not repeat who checked a fact on its line", () => {
    const [p] = parseContributionPatches(JSON.stringify([
      { kind: "add", page: "Vendor", attribute: "phone", value: "1", source: "contacts thread, checked by agent-a", checkedAt: "2026-10-05T09:00:00Z" },
    ]), "agent-a", { now: NOW })
    expect(p.source).toBe("contacts thread")
    const [q] = parseContributionPatches(JSON.stringify([
      { kind: "add", page: "Vendor", attribute: "phone", value: "1", source: "checked the contacts app", checkedAt: "2026-10-05T09:00:00Z" },
    ]), "agent-a", { now: NOW })
    expect(q.source).toBe("checked the contacts app")
  })

  it("shows the model a page whose body, not title, matches the work", async () => {
    page("agent-a", "concepts/plan.md", "Instalment Schedule", "Engagement 4471 with the tax office; amount unknown.")
    for (let i = 0; i < 10; i++) page("agent-a", `misc/p${i}.md`, `Tax note ${i}`, "Unrelated.")
    chat("agent-a", "e1", "2026-10-08", "Tax portal: engagement 4471 amount is 1200.")
    const call = model([])
    await runContribution(hub, dir, "agent-a", { model: "m", call, now: NOW, dryRun: true })
    expect(call.prompts[0]).toContain("### Instalment Schedule")
    expect(call.prompts[0]).toContain("Do not record facts about the wiki, AgentX")
  })

  function selectorReturns(paths: Array<{ title: string; path: string }>): void {
    mocks.execSync.mockImplementation((cmd: string) => {
      const prompt = readFileSync(cmd.match(/cat '([^']+)'/)![1], "utf-8")
      if (prompt.includes("You are picking candidate articles")) return JSON.stringify({ result: JSON.stringify(paths) })
      return JSON.stringify({ result: "answer" })
    })
  }

  it("keeps at least half the walk for the agent's own pages", async () => {
    page("agent-a", "own/one.md", "Own One", "Mine.", { related: ["Own Two", "Own Three"] })
    page("agent-a", "own/two.md", "Own Two", "Mine.")
    page("agent-a", "own/three.md", "Own Three", "Mine.")
    for (let i = 0; i < 6; i++) page("agent-b", `s/${i}.md`, `Shared ${i}`, "Theirs.")
    hub.getAgentWiki("agent-a").rebuildIndex()
    selectorReturns([
      ...Array.from({ length: 6 }, (_, i) => ({ title: `Shared ${i}`, path: `@agent-b/s/${i}.md` })),
      { title: "Own One", path: "own/one.md" },
    ])
    const r = await agenticQuery("q", hub.getAgentWiki("agent-a"), "agent-a", { shared: hub.sharedScope("agent-a"), maxCandidates: 7, maxArticles: 4 })
    expect(r.walked[0].path).toBe("own/one.md")
    expect(r.walked.filter((w) => w.path.startsWith("@")).length).toBe(2)
    expect(r.walked).toHaveLength(4)
  })

  it("gives the slots own pages leave empty back to shared ones", async () => {
    page("agent-a", "own/one.md", "Own One", "Mine.")
    for (let i = 0; i < 6; i++) page("agent-b", `s/${i}.md`, `Shared ${i}`, "Theirs.")
    hub.getAgentWiki("agent-a").rebuildIndex()
    selectorReturns([
      ...Array.from({ length: 6 }, (_, i) => ({ title: `Shared ${i}`, path: `@agent-b/s/${i}.md` })),
      { title: "Own One", path: "own/one.md" },
    ])
    const r = await agenticQuery("q", hub.getAgentWiki("agent-a"), "agent-a", { shared: hub.sharedScope("agent-a"), maxCandidates: 7, maxArticles: 4 })
    expect(r.walked.map((w) => w.path)).toEqual(["own/one.md", "@agent-b/s/0.md", "@agent-b/s/1.md", "@agent-b/s/2.md"])
  })

  it("finds pages that link to a picked page by one of its aliases", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "A person.", { aliases: ["Sam D."] })
    page("agent-b", "decisions/write.md", "Write to Sam by email", "Decided: email only.", { related: ["Sam D."] })
    hub.getAgentWiki("agent-a").rebuildIndex()
    selectorReturns([{ title: "Sam Doe", path: "people/sam.md" }])
    const r = await agenticQuery("how to write to Sam?", hub.getAgentWiki("agent-a"), "agent-a", { shared: hub.sharedScope("agent-a") })
    expect(r.walked.map((w) => w.path)).toEqual(["people/sam.md", "@agent-b/decisions/write.md"])
  })

  it("opens the pages that link to a picked page", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "A person.")
    page("agent-b", "decisions/write.md", "Write to Sam by email", "Decided: email only.", { related: ["Sam Doe"], lastUpdated: "2026-10-01" })
    hub.getAgentWiki("agent-a").rebuildIndex()
    selectorReturns([{ title: "Sam Doe", path: "people/sam.md" }])
    const r = await agenticQuery("how to write to Sam?", hub.getAgentWiki("agent-a"), "agent-a", { shared: hub.sharedScope("agent-a") })
    expect(r.walked.map((w) => w.path)).toEqual(["people/sam.md", "@agent-b/decisions/write.md"])

    const own = await agenticQuery("how to write to Sam?", hub.getAgentWiki("agent-a"), "agent-a")
    expect(own.walked.map((w) => w.path)).toEqual(["people/sam.md"])
  })
})

describe("devops review of 800f0ee", () => {
  const queue = async (agent: string, patches: unknown[]) => {
    chat(agent, `w-${agent}-${Math.random().toString(36).slice(2, 8)}`, "2026-10-08", "work")
    await runContribution(hub, dir, agent, { model: "m", call: model(patches), now: NOW })
  }

  it("keeps both facts when one patch names a page by title and another by alias", async () => {
    page("agent-a", "people/sam.md", "Sam Doe", "Sam works on the portal.", { aliases: ["Sam D."] })
    await queue("agent-a", [
      { kind: "add", page: "Sam Doe", attribute: "phone", value: "+1 555 0100", source: "contacts app", checkedAt: "2026-10-08T09:00:00Z" },
      { kind: "add", page: "Sam D.", attribute: "role", value: "developer", source: "chat", checkedAt: "2026-10-08T09:05:00Z" },
    ])

    const report = mergeContributions(hub, dir, { now: NOW })

    const body = read("agent-a", "people/sam.md").content
    expect(body).toContain("**phone:** +1 555 0100")
    expect(body).toContain("**role:** developer")
    expect(report.pagesUpdated).toEqual(["agent-a/people/sam.md"])
  })

  it("corrects whole words only", async () => {
    const { replaceOnce } = await import("../../src/wiki/contributions")
    expect(replaceOnce("Invoice 7 is unpaid.", "paid", "overdue")).toBe("Invoice 7 is unpaid.")
    expect(replaceOnce("Invoice 7 is paid, invoice 8 is unpaid.", "paid", "overdue")).toBe("Invoice 7 is overdue, invoice 8 is unpaid.")
    expect(replaceOnce("Paid (in full) and paid (in full).", "paid (in full)", "x")).toBe("Paid (in full) and x.")
  })

  it("reads wiki.query.shared for the CLI and the agentx_wiki_query tool alike", async () => {
    const { writeFileSync } = await import("fs")
    const { sharedQueryEnabled } = await import("../../src/wiki/query")
    const file = resolve(dir, "agentx.json")
    writeFileSync(file, JSON.stringify({ node: { id: "n", name: "N" }, wiki: { query: { shared: false } } }))
    expect(await sharedQueryEnabled(file)).toBe(false)
    writeFileSync(file, JSON.stringify({ node: { id: "n", name: "N" } }))
    expect(await sharedQueryEnabled(file)).toBe(true)
    expect(await sharedQueryEnabled(resolve(dir, "missing.json"))).toBe(true)

    const mcp = readFileSync(resolve(__dirname, "../../src/mcp/index.ts"), "utf-8")
    expect(mcp).toMatch(/shared: \(await sharedQueryEnabled\(\)\) \? hub\.sharedScope\(agentId\) : undefined/)
  })
})
