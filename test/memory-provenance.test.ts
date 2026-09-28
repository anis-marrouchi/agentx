import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"
import { flagUnsourced } from "../src/agents/memory-migrate"
import { storeRotationMemo } from "../src/agents/rotation-memo-store"
import { FactLedger } from "../src/wiki/facts/ledger"
import {
  approveFactProposal, listFactProposals, parseClaim, rejectFactProposal, routeMemo,
} from "../src/wiki/facts/fact-proposals"

const DAY = 86_400_000
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

let root: string
let wikiDir: string
beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), "agentx-prov-")); wikiDir = resolve(root, ".agentx/wiki") })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function memory(store: MemoryStore, id: string, content: string, daysAgo: number, extra: Partial<MemoryFact> = {}): MemoryFact {
  store.getAll("a") // ensures the dir exists via constructor
  const f: MemoryFact = {
    id, agentId: "a", category: "fact", content, keywords: [],
    source: { channel: "telegram", chatId: "123", sender: "owner", date: at(daysAgo).slice(0, 10) },
    createdAt: at(daysAgo), ...extra,
  }
  appendFileSync(resolve(root, ".agentx/memory/a.jsonl"), JSON.stringify(f) + "\n")
  return f
}

describe("memos do not create unsourced facts", () => {
  const memo = [
    "- Reviewing PR #12 for the importer",
    "- Vendor account is past due since 09-11",
    "- Staging API active per GET /health, 2026-09-27",
  ].join("\n")

  it("sends claims to wiki proposals with provenance and keeps only work state", () => {
    const r = routeMemo(wikiDir, memo, { agentId: "sales-agent", origin: "rotation-memo:tier-2", chat: "telegram:1" })
    expect(r.workState).toBe("- Reviewing PR #12 for the importer")
    expect(r.proposals).toHaveLength(2)
    expect(r.proposals[0]).toMatchObject({
      status: "pending", claim: "Vendor account is past due since 09-11", volatility: "billing",
      source: "rotation-memo:tier-2 (unchecked summary)", verifiedBy: "sales-agent", origin: "rotation-memo:tier-2",
      subject: "Vendor account", attribute: "billing status", value: "past due since 09-11",
    })
    expect(r.proposals[1]).toMatchObject({ source: "GET /health", verifiedAt: "2026-09-27T00:00:00.000Z" })
    // The pinned copy for the next session marks each claim.
    expect(r.pinned).toMatch(/UNVERIFIED claim \(wiki proposal fp-[0-9a-f]+\): Vendor account is past due/)
    // Nothing reached the ledger as a fact.
    expect(new FactLedger(wikiDir).list()).toHaveLength(0)
  })

  it("queues a repeated claim once", () => {
    routeMemo(wikiDir, memo, { agentId: "a", origin: "continuity-memo" })
    routeMemo(wikiDir, memo, { agentId: "a", origin: "continuity-memo" })
    expect(listFactProposals(new FactLedger(wikiDir), "pending")).toHaveLength(2)
  })

  it("leaves a memo with no claims untouched", () => {
    const r = routeMemo(wikiDir, "- Drafting the release notes", { agentId: "a", origin: "continuity-memo" })
    expect(r).toMatchObject({ workState: "- Drafting the release notes", pinned: "- Drafting the release notes", proposals: [] })
  })

  it("approval records the fact with the person's confirmation; rejection records nothing", () => {
    const ledger = new FactLedger(wikiDir)
    const [claim, cited] = routeMemo(wikiDir, memo, { agentId: "a", origin: "continuity-memo" }).proposals
    const { write } = approveFactProposal(ledger, claim.id, "operator", { value: "active", source: "vendor dashboard" })
    expect(write.fact).toMatchObject({ subject: "Vendor account", value: "active", source: "vendor dashboard", confirmedBy: "operator" })
    rejectFactProposal(ledger, cited.id, "operator", "not checked")
    expect(ledger.list()).toHaveLength(1)
    expect(listFactProposals(ledger, "pending")).toHaveLength(0)
    expect(() => approveFactProposal(ledger, claim.id, "operator")).toThrow(/already approved/)
  })

  it("a rotation stores only work state as memory and pins the flagged memo", () => {
    const store = new MemoryStore(root)
    const pinned: string[] = []
    const r = storeRotationMemo(store, { setRotationMemo: (_a, _c, _i, m) => { pinned.push(m) } }, {
      wikiDir, agentId: "a", channel: "telegram", chatId: "123", reason: "tier-2", memo,
    })
    expect(r.proposals).toBe(2)
    const facts = store.getAll("a")
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ category: "task-state", content: "[Rotation memo · tier-2] - Reviewing PR #12 for the importer" })
    expect(facts[0].content).not.toMatch(/past due|active per/)
    expect(pinned[0]).toContain("UNVERIFIED claim")
  })

  it("a memo made only of claims adds no memory at all", () => {
    const store = new MemoryStore(root)
    storeRotationMemo(store, { setRotationMemo: () => {} }, {
      wikiDir, agentId: "a", channel: "telegram", chatId: "123", reason: "continuity",
      memo: "- Vendor account is past due since 09-11",
    })
    expect(store.getAll("a")).toHaveLength(0)
    expect(listFactProposals(new FactLedger(wikiDir))[0].origin).toBe("continuity-memo")
  })

  it("reads subject and value from simple claims only", () => {
    expect(parseClaim("- The build server went down (per status page)")).toMatchObject({ subject: "The build server", value: "down", attribute: "outage status" })
    expect(parseClaim("Down again, retrying later")).toEqual({})
  })
})

describe("memory references the wiki instead of copying it", () => {
  it("replaces lines that restate a wiki fact with one reference", () => {
    const store = new MemoryStore(root)
    new FactLedger(wikiDir).write({
      subject: "vendor account", attribute: "billing status", value: "active",
      source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: at(0),
    })
    const a = memory(store, "m1", "Vendor account is past due since 09-11", 17)
    const b = memory(store, "m2", "vendor account billing is overdue, remind the owner", 10)
    const c = memory(store, "m3", "Owner prefers short replies", 30)
    const ctx = store.buildContext([a, b, c])
    const refs = ctx.split("\n").filter((l) => l.startsWith("- [wiki f-"))
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatch(/vendor account · billing status: active \(GET \/v1\/user, checked \d{4}-\d{2}-\d{2} by ops-agent\)/)
    expect(ctx).not.toContain("past due since 09-11")
    expect(ctx).not.toContain("overdue")
    expect(ctx).toContain("Owner prefers short replies")
  })

  it("flags the reference when the wiki fact itself is past its TTL", () => {
    const store = new MemoryStore(root)
    new FactLedger(wikiDir).write({
      subject: "vendor account", attribute: "billing status", value: "active",
      source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: at(20),
    })
    const ctx = store.buildContext([memory(store, "m1", "Vendor account is past due", 25)])
    expect(ctx).toMatch(/- \[wiki f-[0-9a-f]+\] UNVERIFIED \(20d old\) vendor account/)
  })

  it("keeps a newer memory line that says something else, marked", () => {
    const store = new MemoryStore(root)
    new FactLedger(wikiDir).write({
      subject: "vendor account", attribute: "billing status", value: "active",
      source: "GET /v1/user", verifiedBy: "ops-agent", verifiedAt: at(3),
    })
    const ctx = store.buildContext([memory(store, "m1", "Vendor account payment failed this morning", 0)])
    expect(ctx).toMatch(/Vendor account payment failed this morning \(DM, [^)]+\) \[differs from wiki f-/)
  })
})

describe("migration: flag unsourced volatile memory", () => {
  it("lists without writing, then flags with a backup, and is idempotent", () => {
    const store = new MemoryStore(root)
    memory(store, "m1", "Vendor account is past due since 09-11", 0)
    memory(store, "m2", "The build server is down", 0)
    memory(store, "m3", "Only 40 credits left on the TTS plan", 0)
    memory(store, "m4", "deploy path is /var/www/x", 0)
    memory(store, "m5", "Vendor plan was downgraded", 0, { provenance: { source: "vendor dashboard", verifiedAt: at(0) } })
    const before = readFileSync(store.fileFor("a"), "utf-8")

    const dry = flagUnsourced(store, "a")
    expect(dry.flagged.map((f) => f.id)).toEqual(["m1", "m2", "m3"])
    expect(readFileSync(store.fileFor("a"), "utf-8")).toBe(before)

    const run = flagUnsourced(store, "a", { apply: true })
    expect(run.flagged).toHaveLength(3)
    expect(run.backup && readFileSync(run.backup, "utf-8")).toBe(before)
    const after = store.getAll("a")
    expect(after.filter((f) => f.unverified).map((f) => f.id)).toEqual(["m1", "m2", "m3"])

    // A fresh flagged line is still rendered UNVERIFIED.
    expect(store.buildContext(after)).toMatch(/UNVERIFIED \(0d old\) Vendor account is past due/)

    const again = flagUnsourced(store, "a", { apply: true })
    expect(again.flagged).toHaveLength(0)
    expect(again.backup).toBeUndefined()
    expect(readdirSync(resolve(root, ".agentx/memory/_backup"))).toHaveLength(1)
  })

  it("does nothing for an agent with no memory", () => {
    const store = new MemoryStore(root)
    expect(flagUnsourced(store, "nobody", { apply: true })).toEqual({ agentId: "nobody", flagged: [] })
    expect(existsSync(resolve(root, ".agentx/memory/_backup"))).toBe(false)
  })
})
