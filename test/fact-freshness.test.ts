import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { isVolatile, needsRecheck, VERIFY_OR_ASK_RULE } from "../src/agents/fact-freshness"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"

const DAY = 86_400_000
const NOW = Date.parse("2026-09-28T12:00:00Z")
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const fact = (content: string, daysAgo: number, sender = "anis") =>
  ({ content, createdAt: at(daysAgo), source: { sender } })

describe("fact freshness", () => {
  it("treats account, billing, outage and deploy state as volatile", () => {
    expect(isVolatile(fact("ElevenLabs is past due since 09-11", 0))).toBe(true)
    expect(isVolatile(fact("clawd is down", 0))).toBe(true)
    expect(isVolatile(fact("#229 deployed on clawd", 0))).toBe(true)
    expect(isVolatile(fact("Anis prefers short replies", 0))).toBe(false)
  })

  it("treats session summaries as volatile whatever they say", () => {
    expect(isVolatile(fact("[Rotation memo · tier-2] PR #10 reviewed", 0, "system:rotation"))).toBe(true)
  })

  it("asks for a re-check only once a volatile fact passes its TTL", () => {
    expect(needsRecheck(fact("ElevenLabs is past due", 1), NOW)).toBe(false)
    expect(needsRecheck(fact("ElevenLabs is past due", 17), NOW)).toBe(true)
    expect(needsRecheck(fact("Anis prefers short replies", 90), NOW)).toBe(false)
    expect(needsRecheck({ content: "billing overdue", createdAt: "garbage", source: { sender: "x" } }, NOW)).toBe(true)
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
      source: { channel: "telegram", chatId: "123", sender: "anis", date: at(daysAgo).slice(0, 10) },
      createdAt: at(daysAgo),
    }
    appendFileSync(resolve(root, ".agentx/memory/a.jsonl"), JSON.stringify(f) + "\n")
    return f
  }

  it("flags a stale billing fact and adds the rule", () => {
    const stale = write("ElevenLabs is past due since 09-11", 17)
    const stable = write("Anis prefers short replies", 30)
    const ctx = store.buildContext([stale, stable])
    expect(ctx).toContain(VERIFY_OR_ASK_RULE)
    expect(ctx).toMatch(/UNVERIFIED \(\d+d old\) ElevenLabs is past due/)
    expect(ctx).not.toMatch(/UNVERIFIED[^\n]*Anis prefers/)
  })

  it("adds nothing when no fact needs a re-check", () => {
    const ctx = store.buildContext([write("Anis prefers short replies", 30)])
    expect(ctx).not.toContain("UNVERIFIED")
    expect(ctx).not.toContain(VERIFY_OR_ASK_RULE)
  })
})
