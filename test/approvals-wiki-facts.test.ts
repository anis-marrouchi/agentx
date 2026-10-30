import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { decide, listInbox } from "../src/approvals/inbox"
import { readOwnerList } from "../src/desk/owner-list"
import { FactLedger } from "../src/wiki/facts/ledger"
import { listFactProposals, proposeFacts } from "../src/wiki/facts/fact-proposals"
import { QuestionStore } from "../src/wiki/questions"

// Fact proposals and open wiki questions in the Approvals inbox (#603).
// The audit found claims and questions waiting where nobody looked. A busy
// wiki holds thousands of each, so they must not flood the owner's list:
// pending claims are one backlog line outside the count, and only fact
// disagreements (the questions a yes can settle) are listed. Each is
// answered through its source's own path, and only by a person.

const NOW = Date.parse("2026-10-04T08:00:00.000Z")

let root: string
let wikiDir: string

function ctx() {
  return { root, configPath: join(root, "agentx.json"), reload: false, now: NOW }
}

/** A fact checked on the vendor dashboard, then an older report that disagrees. */
function seedContradiction(): string {
  const ledger = new FactLedger(wikiDir)
  ledger.write({ subject: "vendor account", attribute: "billing status", value: "active", source: "vendor dashboard", verifiedBy: "alpha", verifiedAt: "2026-10-02T08:00:00.000Z" })
  const r = ledger.write({ subject: "vendor account", attribute: "billing status", value: "past due", source: "an email", verifiedBy: "beta", verifiedAt: "2026-10-01T08:00:00.000Z" })
  if (r.status !== "contradiction" || !r.questionId) throw new Error(`expected a contradiction, got ${r.status}`)
  return r.questionId
}

beforeEach(() => {
  vi.stubEnv("AGENTX_AGENT_ID", "")
  root = mkdtempSync(join(tmpdir(), "approvals-wiki-"))
  wikiDir = join(root, ".agentx", "wiki")
  writeFileSync(join(root, "agentx.json"), JSON.stringify({ agents: {} }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("fact proposals in the inbox", () => {
  function seed() {
    return proposeFacts(new FactLedger(wikiDir), [
      { claim: "The vendor account is past due", agentId: "beta", origin: "continuity-memo", at: "2026-10-01T08:00:00.000Z" },
      { claim: "Remember the thing from Tuesday", agentId: "alpha", origin: "rotation-memo:tier-2", at: "2026-10-03T12:00:00.000Z" },
    ])
  }

  it("rolls pending claims up into one backlog line, outside the items and the count", () => {
    seed()
    const { items, errors, backlog } = listInbox(ctx(), { kinds: ["fact"] })
    expect(errors).toEqual([])
    expect(items).toEqual([])
    expect(backlog).toEqual([{
      kind: "fact", count: 2, new_today: 1, newest: "2026-10-03T12:00:00.000Z",
      title: "2 wiki claims wait for a check (1 new today)", more: "agentx wiki facts proposals list",
    }])
    expect(readOwnerList(ctx(), { url: "", name: "here" }).count).toBe(0)
  })

  it("thousands of claims stay one line", () => {
    proposeFacts(new FactLedger(wikiDir), Array.from({ length: 2500 }, (_, i) => (
      { claim: `Example Co office ${i} is open`, agentId: "alpha", origin: "continuity-memo", at: "2026-09-01T08:00:00.000Z" })))
    const { items, backlog } = listInbox(ctx())
    expect(items).toEqual([])
    expect(backlog).toHaveLength(1)
    expect(backlog[0].title).toBe("2,500 wiki claims wait for a check")
  })

  it("yes records the fact as the owner's confirmation; no drops the claim", async () => {
    const [p, q] = seed()
    expect(await decide(ctx(), `fact:${p.id}`, "yes", { by: "owner" })).toMatchObject({ ok: true })
    const fact = new FactLedger(wikiDir).list()[0]
    expect(fact).toMatchObject({ value: "past due", confirmedBy: "owner" })

    expect(await decide(ctx(), `fact:${q.id}`, "no", { by: "owner", note: "not a fact" })).toMatchObject({ ok: true })
    expect(listFactProposals(new FactLedger(wikiDir)).find((x) => x.id === q.id)).toMatchObject({ status: "rejected", reason: "not a fact" })
    expect(listInbox(ctx(), { kinds: ["fact"] }).backlog).toEqual([])
    expect(await decide(ctx(), `fact:${p.id}`, "yes")).toMatchObject({ ok: false })
  })

  it("an unsplit claim is refused with the terminal route, and stays pending", async () => {
    const [, q] = seed()
    const r = await decide(ctx(), `fact:${q.id}`, "yes")
    expect(r).toMatchObject({ ok: false })
    expect(listFactProposals(new FactLedger(wikiDir), "pending").map((x) => x.id)).toContain(q.id)
  })

  it("an agent cannot decide one", async () => {
    const [p] = seed()
    vi.stubEnv("AGENTX_AGENT_ID", "beta")
    const r = await decide(ctx(), `fact:${p.id}`, "yes")
    expect(r).toMatchObject({ ok: false })
    expect(r.ok ? "" : r.error).toMatch(/only a person/)
    expect(listFactProposals(new FactLedger(wikiDir), "pending")).toHaveLength(2)
  })

  it("a damaged ledger is reported, not shown as nothing waiting", () => {
    seed()
    writeFileSync(join(wikiDir, "_facts.json"), "{ not json")
    const { backlog, errors } = listInbox(ctx(), { kinds: ["fact"] })
    expect(backlog).toEqual([])
    expect(errors.map((e) => e.kind)).toEqual(["fact"])
  })
})

describe("open wiki questions in the inbox", () => {
  it("lists only disagreements: missing fields and articles stay with `wiki questions`", () => {
    const store = new QuestionStore(wikiDir)
    store.add([
      { kind: "field", agentId: "alpha", path: "people/sam.md", subject: "Sam", field: "role", question: "What is Sam's role?" },
      { kind: "article", agentId: "alpha", path: "", subject: "Example Co", question: "Is Example Co a client or a vendor?" },
    ])
    expect(listInbox(ctx(), { kinds: ["question"] }).items).toEqual([])
    const id = seedContradiction()
    const { items, backlog } = listInbox(ctx(), { kinds: ["question"] })
    expect(items.map((i) => i.key)).toEqual([`question:${id}`])
    expect(items[0]).toMatchObject({ kind: "question", raised_by: "beta" })
    expect(Date.parse(items[0].created_at)).not.toBeNaN()
    expect(backlog).toEqual([])
  })

  it("an answered disagreement leaves the list", async () => {
    const id = seedContradiction()
    expect(await decide(ctx(), `question:${id}`, "no", { by: "owner" })).toMatchObject({ ok: true })
    expect(listInbox(ctx(), { kinds: ["question"] }).items).toEqual([])
  })

  it("a field question is answered in the terminal; no dismisses it", async () => {
    const store = new QuestionStore(wikiDir)
    store.add([{ kind: "field", agentId: "alpha", path: "people/sam.md", subject: "Sam", field: "role", question: "What is Sam's role?" }])
    const id = store.list()[0].id
    const yes = await decide(ctx(), `question:${id}`, "yes")
    expect(yes).toMatchObject({ ok: false })
    expect(yes.ok ? "" : yes.error).toContain(`agentx wiki answer ${id}`)
    expect(await decide(ctx(), `question:${id}`, "no")).toMatchObject({ ok: true })
    expect(new QuestionStore(wikiDir).list()[0].status).toBe("dismissed")
  })

  it("a disagreement offers both values; the pick is written as the owner's confirmation", async () => {
    const id = seedContradiction()
    const [item] = listInbox(ctx(), { kinds: ["question"] }).items
    expect(item).toMatchObject({ key: `question:${id}`, choices: ["active", "past due"], title: "vendor account: two values disagree" })

    expect(await decide(ctx(), item.key, "yes")).toMatchObject({ ok: false })
    expect(await decide(ctx(), item.key, "yes", { choice: 2, by: "owner" })).toMatchObject({ ok: true })
    const fact = new FactLedger(wikiDir).list()[0]
    expect(fact).toMatchObject({ value: "past due", confirmedBy: "owner", source: "owner said" })
    expect(new QuestionStore(wikiDir).list()[0]).toMatchObject({ status: "answered", answer: "past due" })
    expect(listInbox(ctx(), { kinds: ["question"] }).items).toEqual([])
  })

  it("an agent cannot settle a disagreement or dismiss a question", async () => {
    const id = seedContradiction()
    vi.stubEnv("AGENTX_AGENT_ID", "beta")
    expect(await decide(ctx(), `question:${id}`, "yes", { choice: "past due" })).toMatchObject({ ok: false })
    expect(await decide(ctx(), `question:${id}`, "no")).toMatchObject({ ok: false })
    expect(new FactLedger(wikiDir).list()[0].value).toBe("active")
    expect(new QuestionStore(wikiDir).list()[0].status).toBe("open")
  })
})
