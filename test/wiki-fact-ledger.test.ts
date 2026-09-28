import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { FactLedger, factContradictions, factId, isStaleFact, matchFact } from "../src/wiki/facts/ledger"
import { QuestionStore } from "../src/wiki/questions"

const DAY = 86_400_000
const NOW = Date.parse("2026-09-28T12:00:00Z")
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()

// Confirming and answering are a person's acts; run as one even when an agent runs the suite.
beforeEach(() => { vi.stubEnv("AGENTX_AGENT_ID", "") })
afterEach(() => { vi.unstubAllEnvs() })

const base = {
  subject: "vendor account", attribute: "billing status",
  source: "GET /v1/user", verifiedBy: "ops-agent",
}

describe("fact ledger provenance", () => {
  let dir: string
  let ledger: FactLedger
  beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-ledger-")); ledger = new FactLedger(dir) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("records source, check date, checker and class on every fact", () => {
    const r = ledger.write({ ...base, value: "active", verifiedAt: at(1) }, { now: NOW })
    expect(r.status).toBe("created")
    expect(r.fact).toMatchObject({
      id: factId("vendor account", "billing status"),
      source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: at(1), volatility: "billing",
    })
    expect(new FactLedger(dir).get(r.fact.id)?.value).toBe("active")
  })

  it("refuses a fact with no source", () => {
    expect(() => ledger.write({ ...base, source: " ", value: "active" })).toThrow(/source/)
  })

  it("classes stable facts as never expiring and volatile ones by TTL", () => {
    const path = ledger.write({ subject: "site", attribute: "deploy path", value: "/var/www/x", source: "owner said", verifiedBy: "o", verifiedAt: at(300) }, { now: NOW })
    expect(path.fact.volatility).toBe("stable")
    expect(isStaleFact(path.fact, NOW)).toBe(false)
    const bill = ledger.write({ ...base, value: "active", verifiedAt: at(3) }, { now: NOW })
    expect(isStaleFact(bill.fact, NOW)).toBe(true)
  })

  it("does not date a check in the future", () => {
    const r = ledger.write({ ...base, value: "active", verifiedAt: "2099-01-01T00:00:00Z" }, { now: NOW })
    expect(r.fact.verifiedAt).toBe(new Date(NOW).toISOString())
  })

  it("refreshes the check date when the same value is re-checked", () => {
    ledger.write({ ...base, value: "active", verifiedAt: at(5) }, { now: NOW })
    const r = ledger.write({ ...base, value: "Active", verifiedAt: at(0) }, { now: NOW })
    expect(r.status).toBe("verified")
    expect(r.fact.verifiedAt).toBe(at(0))
  })
})

describe("overwrite safety", () => {
  let dir: string
  let ledger: FactLedger
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "agentx-ledger-"))
    ledger = new FactLedger(dir)
    ledger.write({ ...base, value: "active", verifiedAt: at(1) }, { now: NOW })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps the old value and raises a contradiction when the new check is older", () => {
    const r = ledger.write({ ...base, value: "past due", source: "rotation memo", verifiedBy: "sales-agent", verifiedAt: at(17) }, { now: NOW })
    expect(r.status).toBe("contradiction")
    expect(ledger.get(r.fact.id)?.value).toBe("active")

    const open = new QuestionStore(dir).list("open")
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: "contradiction", factId: r.fact.id, id: r.questionId })
    expect(open[0].proposed?.value).toBe("past due")

    const issues = factContradictions(dir)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ type: "contradiction", articles: [`_facts.json#${r.fact.id}`] })
  })

  it("does not ask the same contradiction twice", () => {
    const stale = { ...base, value: "past due", verifiedAt: at(17) }
    ledger.write(stale, { now: NOW })
    ledger.write(stale, { now: NOW })
    expect(new QuestionStore(dir).list("open")).toHaveLength(1)
  })

  it("an equally old check is not newer", () => {
    const r = ledger.write({ ...base, value: "past due", verifiedAt: at(1) }, { now: NOW })
    expect(r.status).toBe("contradiction")
  })

  it("replaces the value with a newer check and keeps the old one in history", () => {
    const r = ledger.write({ ...base, value: "past due", verifiedAt: at(0) }, { now: NOW })
    expect(r.status).toBe("updated")
    expect(r.fact.value).toBe("past due")
    expect(r.fact.history?.[0]).toMatchObject({ value: "active", verifiedAt: at(1) })
    expect(new QuestionStore(dir).list("open")).toHaveLength(0)
  })

  it("a person's confirmation replaces the value even with an older date", () => {
    const r = ledger.write({ ...base, value: "past due", source: "owner said", verifiedBy: "operator", verifiedAt: at(10) }, { now: NOW, confirmedBy: "operator" })
    expect(r.status).toBe("updated")
    expect(r.fact).toMatchObject({ value: "past due", confirmedBy: "operator" })
  })
})

describe("matchFact", () => {
  const ledgerFacts = () => {
    const dir = mkdtempSync(resolve(tmpdir(), "agentx-ledger-"))
    const l = new FactLedger(dir)
    l.write({ ...base, value: "active", verifiedAt: at(1) }, { now: NOW })
    l.write({ subject: "site", attribute: "deploy path", value: "/var/www/x", source: "owner said", verifiedBy: "o" }, { now: NOW })
    const facts = l.list()
    rmSync(dir, { recursive: true, force: true })
    return facts
  }

  it("matches a memory line that restates a fact about the same subject", () => {
    const facts = ledgerFacts()
    expect(matchFact("Vendor account is past due since 09-11", facts)?.subject).toBe("vendor account")
    expect(matchFact("vendor account billing status: active", facts)?.subject).toBe("vendor account")
    expect(matchFact("site deploy path is /var/www/y", facts)?.attribute).toBe("deploy path")
  })

  it("ignores lines about something else", () => {
    const facts = ledgerFacts()
    expect(matchFact("Owner prefers short replies", facts)).toBeNull()
    expect(matchFact("vendor account manager is on leave", facts)).toBeNull()
  })
})
