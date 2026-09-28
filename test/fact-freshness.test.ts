import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  citedCheck, classifyAttribute, classifyFact, isVolatile, needsRecheck, splitMemo, VERIFY_OR_ASK_RULE,
} from "../src/agents/fact-freshness"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"

const DAY = 86_400_000
const NOW = Date.parse("2026-09-28T12:00:00Z")
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const fact = (content: string, daysAgo: number, sender = "owner") =>
  ({ content, createdAt: at(daysAgo), source: { sender } })

describe("fact classes", () => {
  it("treats account, billing, outage and deploy state as volatile", () => {
    expect(classifyFact("vendor account is past due since 09-11")).toBe("billing")
    expect(classifyFact("only 40 credits left on the TTS plan")).toBe("billing")
    expect(classifyFact("the API key was revoked")).toBe("account")
    expect(classifyFact("the ticket is blocked by legal")).toBe("account")
    expect(classifyFact("the build server is down")).toBe("outage")
    expect(classifyFact("#229 deployed on the staging box")).toBe("deploy")
    expect(isVolatile(fact("Owner prefers short replies", 0))).toBe(false)
  })

  it("does not flag lasting notes that only mention a volatile topic", () => {
    // The over-flagging the slice-1 review pointed out.
    expect(classifyFact("deploy path is /var/www/x")).toBe("stable")
    expect(classifyFact("deploy target is the staging box")).toBe("stable")
    expect(classifyFact("I wrote it down in the handbook")).toBe("stable")
    expect(classifyFact("billing contact is the finance team")).toBe("stable")
    expect(classifyFact("the balance sheet lives in the shared drive")).toBe("stable")
  })

  it("classifies structured facts by attribute, stable names first", () => {
    expect(classifyAttribute("billing status")).toBe("billing")
    expect(classifyAttribute("deploy path")).toBe("stable")
    expect(classifyAttribute("account status", "vendor account is suspended")).toBe("account")
  })

  it("treats session summaries as work state whatever they say", () => {
    expect(isVolatile(fact("[Rotation memo · tier-2] PR #10 reviewed", 0, "system:rotation"))).toBe(true)
  })
})

describe("needsRecheck", () => {
  it("asks for a re-check only once a volatile fact passes its TTL", () => {
    expect(needsRecheck(fact("vendor account is past due", 1), NOW)).toBe(false)
    expect(needsRecheck(fact("vendor account is past due", 17), NOW)).toBe(true)
    expect(needsRecheck(fact("Owner prefers short replies", 90), NOW)).toBe(false)
    expect(needsRecheck({ content: "invoice is overdue", createdAt: "garbage", source: { sender: "x" } }, NOW)).toBe(true)
  })

  it("counts age from the last check, and honours an explicit class and TTL", () => {
    const old = { ...fact("vendor account is past due", 30), provenance: { verifiedAt: at(1), source: "GET /v1/user" } }
    expect(needsRecheck(old, NOW)).toBe(false)
    const pinned = { ...fact("plan tier is Pro", 10), provenance: { volatility: "billing" as const, ttlDays: 30 } }
    expect(needsRecheck(pinned, NOW)).toBe(false)
  })

  it("always re-checks a line the migration flagged", () => {
    expect(needsRecheck({ ...fact("vendor account is past due", 0), unverified: { since: at(0), reason: "x" } }, NOW)).toBe(true)
  })
})

describe("session memo claims", () => {
  it("splits work state from claims about outside systems", () => {
    const { workState, claims } = splitMemo([
      "- Reviewing PR #12 for the importer",
      "- Vendor account is past due since 09-11",
      "- Next: reply to the owner about the schedule",
      "- Staging API went down after the migration",
    ].join("\n"))
    expect(workState).toHaveLength(2)
    expect(claims).toEqual(["- Vendor account is past due since 09-11", "- Staging API went down after the migration"])
  })

  it("reads the check a claim cites", () => {
    expect(citedCheck("Vendor account active per GET /v1/user, 2026-09-28")).toEqual({
      source: "GET /v1/user", verifiedAt: "2026-09-28T00:00:00.000Z",
    })
    expect(citedCheck("Vendor account is past due")).toBeNull()
  })
})

describe("memory block verify-or-ask", () => {
  let root: string
  let store: MemoryStore
  beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), "agentx-fresh-")); store = new MemoryStore(root) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const write = (content: string, daysAgo: number): MemoryFact => {
    const f: MemoryFact = {
      id: `f${daysAgo}`, agentId: "a", category: "fact", content, keywords: [],
      source: { channel: "telegram", chatId: "123", sender: "owner", date: at(daysAgo).slice(0, 10) },
      createdAt: at(daysAgo),
    }
    appendFileSync(resolve(root, ".agentx/memory/a.jsonl"), JSON.stringify(f) + "\n")
    return f
  }

  it("flags a stale billing fact and adds the rule", () => {
    const stale = write("vendor account is past due since 09-11", 17)
    const stable = write("Owner prefers short replies", 30)
    const ctx = store.buildContext([stale, stable])
    expect(ctx).toContain(VERIFY_OR_ASK_RULE)
    expect(ctx).toMatch(/UNVERIFIED \(\d+d old\) vendor account is past due/)
    expect(ctx).not.toMatch(/UNVERIFIED[^\n]*Owner prefers/)
  })

  it("does not flag a lasting deploy-path note", () => {
    const ctx = store.buildContext([write("deploy path is /var/www/x", 40)])
    expect(ctx).not.toContain("UNVERIFIED")
  })

  it("adds nothing when no fact needs a re-check", () => {
    const ctx = store.buildContext([write("Owner prefers short replies", 30)])
    expect(ctx).not.toContain("UNVERIFIED")
    expect(ctx).not.toContain(VERIFY_OR_ASK_RULE)
  })
})
