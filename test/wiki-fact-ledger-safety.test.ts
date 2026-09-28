import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { FactLedger } from "../src/wiki/facts/ledger"
import { LedgerCorruptError, withLock } from "../src/wiki/facts/ledger-file"
import { listFactProposals, proposeFacts, routeMemo } from "../src/wiki/facts/fact-proposals"
import { QuestionStore } from "../src/wiki/questions"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"
import { flagUnsourced } from "../src/agents/memory-migrate"

const MIN = 60_000
const NOW = Date.parse("2026-09-28T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let dir: string
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-ledger-safety-")); vi.stubEnv("AGENTX_AGENT_ID", "") })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("a corrupt ledger is never overwritten", () => {
  it("keeps both facts when a memo is routed onto a truncated file", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const ledger = new FactLedger(dir)
    ledger.write({ subject: "vendor account", attribute: "billing status", value: "active", source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: ago(MIN) }, { now: NOW })
    ledger.write({ subject: "site", attribute: "deploy path", value: "/var/www/x", source: "owner said", verifiedBy: "operator" }, { now: NOW })
    truncateSync(ledger.file, statSync(ledger.file).size - 5)
    const damaged = readFileSync(ledger.file, "utf-8")

    const r = routeMemo(dir, "- the vendor account is past due", { agentId: "sales-agent", origin: "rotation-memo:tier-2" })

    expect(r.error).toMatch(/unreadable/)
    expect(r.pinned).toContain("UNVERIFIED claim (not checked)")
    expect(readFileSync(ledger.file, "utf-8")).toBe(damaged)
    expect(damaged).toContain("vendor account")
    expect(damaged).toContain("/var/www/x")
  })

  it("refuses reads and writes with a clear error, logged once", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const ledger = new FactLedger(dir)
    writeFileSync(ledger.file, "{not json")
    expect(() => ledger.list()).toThrow(LedgerCorruptError)
    expect(() => ledger.list()).toThrow(/Nothing was written/)
    expect(() => ledger.write({ subject: "a b c", attribute: "x", value: "y", source: "s", verifiedBy: "v" })).toThrow(LedgerCorruptError)
    expect(() => proposeFacts(ledger, [{ claim: "api is down", agentId: "a", origin: "o" }])).toThrow(LedgerCorruptError)
    expect(readFileSync(ledger.file, "utf-8")).toBe("{not json")
    expect(err).toHaveBeenCalledTimes(1)
  })

  it("treats a file that is JSON but not a ledger as corrupt", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const ledger = new FactLedger(dir)
    writeFileSync(ledger.file, "[]")
    expect(() => ledger.list()).toThrow(/not a ledger/)
  })

  it("memory still renders without the ledger", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const root = resolve(dir, "node")
    const store = new MemoryStore(root)
    mkdirSync(resolve(root, ".agentx/wiki"), { recursive: true })
    writeFileSync(resolve(root, ".agentx/wiki/_facts.json"), "{bad")
    const f: MemoryFact = {
      id: "m1", agentId: "a", category: "fact", content: "Owner prefers short replies", keywords: [],
      source: { channel: "telegram", chatId: "1", sender: "owner", date: "2026-09-28" }, createdAt: new Date().toISOString(),
    }
    expect(store.buildContext([f])).toContain("Owner prefers short replies")
  })
})

describe("a person's confirmation outranks an agent", () => {
  it("an agent's undated set cannot replace an owner-confirmed value", () => {
    const ledger = new FactLedger(dir)
    ledger.write(
      { subject: "vendor account", attribute: "billing status", value: "active", source: "owner said", verifiedBy: "operator", verifiedAt: ago(MIN) },
      { confirmedBy: "operator", now: NOW },
    )
    const r = ledger.write(
      { subject: "vendor account", attribute: "billing status", value: "past due", source: "my memory", verifiedBy: "sales-agent" },
      { now: NOW },
    )
    expect(r.status).toBe("contradiction")
    expect(ledger.list()[0]).toMatchObject({ value: "active", confirmedBy: "operator" })
    const q = new QuestionStore(dir).list("open")
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ kind: "contradiction", id: r.questionId })
  })

  it("even a newer dated check needs a person to replace a confirmed value", () => {
    const ledger = new FactLedger(dir)
    ledger.write(
      { subject: "vendor account", attribute: "billing status", value: "active", source: "owner said", verifiedBy: "operator", verifiedAt: ago(10 * MIN) },
      { confirmedBy: "operator", now: NOW },
    )
    const r = ledger.write(
      { subject: "vendor account", attribute: "billing status", value: "past due", source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: "now" },
      { now: NOW },
    )
    expect(r.status).toBe("contradiction")
    // The same value, re-checked, refreshes the date and keeps the confirmation.
    const same = ledger.write(
      { subject: "vendor account", attribute: "billing status", value: "active", source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: "now" },
      { now: NOW },
    )
    expect(same.status).toBe("verified")
    expect(same.fact).toMatchObject({ confirmedBy: "operator", verifiedAt: new Date(NOW).toISOString() })
  })

  it("an undated write never counts as newer, but a dated one does", () => {
    const ledger = new FactLedger(dir)
    const base = { subject: "vendor account", attribute: "billing status", source: "GET /v1/user", verifiedBy: "ops-agent" }
    ledger.write({ ...base, value: "active", verifiedAt: ago(3 * 86_400_000) }, { now: NOW })
    expect(ledger.write({ ...base, value: "past due" }, { now: NOW }).status).toBe("contradiction")
    expect(ledger.write({ ...base, value: "active" }, { now: NOW }).status).toBe("unchanged")
    expect(ledger.write({ ...base, value: "past due", verifiedAt: "now" }, { now: NOW }).status).toBe("updated")
  })
})

describe("ledger writes are serialised", () => {
  it("waits for the lock, then sees the other writer's change", () => {
    const ledger = new FactLedger(dir)
    proposeFacts(ledger, [{ claim: "api is down", agentId: "a", origin: "o" }])
    // Another writer holds the lock and adds a proposal inside it.
    withLock(ledger.file, () => {
      const other = new FactLedger(dir)
      const data = other.load()
      data.proposals.push({ ...data.proposals[0], id: "fp-other", claim: "db is down" })
      writeFileSync(other.file, JSON.stringify(data))
    })
    proposeFacts(ledger, [{ claim: "queue is down", agentId: "a", origin: "o" }])
    expect(listFactProposals(ledger).map((p) => p.claim).sort()).toEqual(["api is down", "db is down", "queue is down"])
  })

  it("gives up with a clear error when the lock stays busy, and takes over a stale lock", () => {
    const ledger = new FactLedger(dir)
    writeFileSync(`${ledger.file}.lock`, "")
    expect(() => withLock(ledger.file, () => 1, { timeoutMs: 60 })).toThrow(/busy/)
    expect(withLock(ledger.file, () => 2, { staleMs: 0 })).toBe(2)
    expect(existsSync(`${ledger.file}.lock`)).toBe(false)
  })
})

describe("memory rewrite keeps lines it cannot read", () => {
  it("the migration keeps an unparsable line", () => {
    const store = new MemoryStore(dir)
    const f: MemoryFact = {
      id: "m1", agentId: "a", category: "fact", content: "The build server is down", keywords: [],
      source: { channel: "telegram", chatId: "1", sender: "owner", date: "2026-09-28" }, createdAt: new Date().toISOString(),
    }
    appendFileSync(store.fileFor("a"), JSON.stringify(f) + "\n{half a line\n")
    const r = flagUnsourced(store, "a", { apply: true })
    expect(r.flagged).toHaveLength(1)
    expect(readFileSync(store.fileFor("a"), "utf-8")).toContain("{half a line")
  })
})
