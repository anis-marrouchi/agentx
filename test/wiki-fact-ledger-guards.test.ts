import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { FactLedger, isStaleFact } from "../src/wiki/facts/ledger"
import { LedgerCorruptError, takeOver, withLock } from "../src/wiki/facts/ledger-file"
import { approveFactProposal, listFactProposals, proposeFacts, rejectFactProposal } from "../src/wiki/facts/fact-proposals"
import { QuestionStore } from "../src/wiki/questions"
import { wikiRefLine } from "../src/agents/memory-context"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"

const NOW = Date.parse("2026-09-28T12:00:00Z")
const base = { subject: "vendor account", attribute: "billing status", source: "GET /v1/user", verifiedBy: "ops-agent" }

let dir: string
// Tests that need an agent stub it; the rest run as a person even when an agent runs the suite.
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-ledger-guards-")); vi.stubEnv("AGENTX_AGENT_ID", "") })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const confirm = (l: FactLedger) =>
  l.write({ ...base, value: "active", source: "owner said", verifiedBy: "operator", verifiedAt: new Date(NOW - 60_000).toISOString() }, { confirmedBy: "operator", now: NOW })

describe("only a person confirms", () => {
  it("refuses a confirmation, an approval and a rejection from inside an agent", () => {
    const l = new FactLedger(dir)
    confirm(l)
    const [p] = proposeFacts(l, [{ claim: "Vendor account is past due", agentId: "sales-agent", origin: "rotation-memo:x" }])
    vi.stubEnv("AGENTX_AGENT_ID", "sales-agent")
    expect(() => l.write({ ...base, value: "past due", verifiedAt: "now" }, { confirmedBy: "sales-agent", now: NOW })).toThrow(/only a person/)
    expect(() => approveFactProposal(l, p.id, "operator")).toThrow(/only a person/)
    expect(() => rejectFactProposal(l, p.id, "operator")).toThrow(/only a person/)
    expect(l.list()[0]).toMatchObject({ value: "active", confirmedBy: "operator" })
    expect(listFactProposals(l, "pending")).toHaveLength(1)
    // An agent can still record what it checked; it just can't win.
    expect(l.write({ ...base, value: "past due", verifiedAt: "now" }, { now: NOW }).status).toBe("contradiction")
  })
})

describe("only a person closes a contradiction", () => {
  it("refuses a dismissal and an answer from inside an agent, and the question stays open", () => {
    const l = new FactLedger(dir)
    confirm(l)
    const r = l.write({ ...base, value: "past due", verifiedAt: "now" }, { now: NOW })
    expect(r.status).toBe("contradiction")
    const store = new QuestionStore(dir)
    vi.stubEnv("AGENTX_AGENT_ID", "ops-agent")
    expect(() => store.resolve(r.questionId!, "dismissed")).toThrow(/only a person can dismiss/)
    expect(() => store.resolve(r.questionId!, "answered", "past due")).toThrow(/only a person can answer/)
    expect(store.list("open").map((q) => q.id)).toEqual([r.questionId])

    vi.stubEnv("AGENTX_AGENT_ID", "")
    expect(store.resolve(r.questionId!, "dismissed")?.status).toBe("dismissed")
  })

  it("still lets an agent close its own non-contradiction question", () => {
    const store = new QuestionStore(dir)
    store.add([{ kind: "article", agentId: "ops-agent", path: "", subject: "Vendor", question: "No article for Vendor" }])
    vi.stubEnv("AGENTX_AGENT_ID", "ops-agent")
    const [q] = store.list("open")
    expect(store.resolve(q.id, "dismissed")?.status).toBe("dismissed")
  })
})

describe("undated facts", () => {
  it("are created marked undated, always unverified, until a dated check", () => {
    const l = new FactLedger(dir)
    const r = l.write({ subject: "site", attribute: "deploy path", value: "/var/www/x", source: "my memory", verifiedBy: "a" }, { now: NOW })
    expect(r.fact.undated).toBe(true)
    expect(isStaleFact(r.fact, NOW)).toBe(true)
    expect(wikiRefLine(r.fact, NOW).line).toContain("UNVERIFIED (never checked)")

    const checked = l.write({ subject: "site", attribute: "deploy path", value: "/var/www/x", source: "ls /var/www", verifiedBy: "a", verifiedAt: "now" }, { now: NOW })
    expect(checked.status).toBe("verified")
    expect(checked.fact.undated).toBeUndefined()
    expect(isStaleFact(checked.fact, NOW)).toBe(false)
  })

  it("lose to any dated check, even one dated before they were written", () => {
    const l = new FactLedger(dir)
    l.write({ ...base, value: "past due", source: "my memory" }, { now: NOW })
    const r = l.write({ ...base, value: "active", verifiedAt: new Date(NOW - 3_600_000).toISOString() }, { now: NOW })
    expect(r.status).toBe("updated")
    expect(r.fact).toMatchObject({ value: "active" })
    expect(r.fact.undated).toBeUndefined()
  })
})

describe("the lock", () => {
  it("errors instead of spinning when a lock can't be removed", () => {
    const l = new FactLedger(dir)
    mkdirSync(`${l.file}.lock`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${l.file}.lock`, old, old)
    const t = Date.now()
    expect(() => withLock(l.file, () => 1, { timeoutMs: 100, staleMs: 1000 })).toThrow(/busy.*delete that lock/)
    expect(Date.now() - t).toBeLessThan(2000)
  })

  it("a second waiter can't delete a lock another waiter just took over", () => {
    const lock = resolve(dir, "x.lock")
    writeFileSync(lock, "")
    // The waiter saw a stale lock earlier; by the time it takes over, the
    // lock is a fresh one another waiter created. It must stay.
    takeOver(lock, 1000)
    expect(existsSync(lock)).toBe(true)
    // While another waiter holds the takeover guard, nobody else deletes.
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    writeFileSync(`${lock}.takeover`, "")
    takeOver(lock, 1000)
    expect(existsSync(lock)).toBe(true)
    rmSync(`${lock}.takeover`)
    takeOver(lock, 1000)
    expect(existsSync(lock)).toBe(false)
  })

  it("approval writes the fact and the decision under one lock", () => {
    const l = new FactLedger(dir)
    const [p] = proposeFacts(l, [{ claim: "Vendor account is past due", agentId: "a", origin: "o" }])
    // Re-entrant: approving while this process holds the lock doesn't deadlock.
    const r = withLock(l.file, () => approveFactProposal(l, p.id, "operator"))
    expect(r.write.status).toBe("created")
    expect(listFactProposals(l)[0].status).toBe("approved")
    expect(existsSync(`${l.file}.lock`)).toBe(false)
  })
})

describe("malformed ledgers", () => {
  const cases = ['{"facts":[null,1,"x"]}', '{"facts":[{"id":"f-1"}]}', '{"facts":[],"proposals":[null]}', "[]", "null", "{}"]
  for (const body of cases) {
    it(`treats ${body} as corrupt and keeps memory working`, () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const root = resolve(dir, "n")
      mkdirSync(resolve(root, ".agentx/wiki"), { recursive: true })
      const file = resolve(root, ".agentx/wiki/_facts.json")
      writeFileSync(file, body)
      expect(() => new FactLedger(resolve(root, ".agentx/wiki")).list()).toThrow(LedgerCorruptError)
      const m: MemoryFact = {
        id: "m", agentId: "a", category: "fact", content: "vendor account is past due", keywords: [],
        source: { channel: "cli", chatId: "1", sender: "o", date: "2026-09-28" }, createdAt: new Date().toISOString(),
      }
      expect(new MemoryStore(root).buildContext([m])).toContain("vendor account is past due")
      expect(readFileSync(file, "utf-8")).toBe(body)
    })
  }
})

describe("an unreadable question queue", () => {
  it("is not overwritten by a contradiction, and the old value stands", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const l = new FactLedger(dir)
    confirm(l)
    const q = resolve(dir, "_questions.json")
    writeFileSync(q, '{"questions":[{"id":"q1"')
    const r = l.write({ ...base, value: "past due", verifiedAt: "now" }, { now: NOW })
    expect(r).toMatchObject({ status: "contradiction", questionId: undefined })
    expect(readFileSync(q, "utf-8")).toBe('{"questions":[{"id":"q1"')
    expect(l.list()[0].value).toBe("active")
  })
})
