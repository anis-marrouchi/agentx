import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { AgentMemory, type MemoryRecord } from "../src/agents/agent-memory"
import type { WikiIndex } from "../src/wiki/types"
import {
  DEFAULT_PROMOTE_TYPES,
  PROMOTION_LEDGER_FILE,
  appendPromotionLedger,
  getUnpromotedMemories,
  groupCandidates,
  listAllAgentMemories,
  memoryKey,
  memoryStamp,
  mergeSources,
  parseMemoryStamp,
  parsePromotionResponse,
  readPromotionLedger,
  type MemoryCandidate,
  type PromotionLedger,
} from "../src/wiki/promote"
import { PROMOTE_BODY_LIMIT, buildMemoryPromotePrompt } from "../src/wiki/prompts"

const ROOT = resolve(__dirname, "../.test-wiki-promote")
const WIKI_DIR = resolve(ROOT, "wiki")

function mem(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    name: "server_ports",
    type: "project",
    description: "daemon ports",
    body: "HTTP=19900",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...over,
  }
}

function index(articles: Array<{ path?: string; sources?: string[] }> = []): WikiIndex {
  return {
    articles: articles.map((a, i) => ({
      path: a.path ?? `concepts/a${i}.md`,
      title: `A${i}`,
      tags: [],
      owner: "memory-promoter",
      access: "public" as const,
      aliases: [],
      backlinks: 0,
      sources: a.sources,
    })),
    lastRebuilt: "2026-07-01T00:00:00.000Z",
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(WIKI_DIR, { recursive: true })
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe("promotion stamps", () => {
  it("round-trips memoryStamp → parseMemoryStamp", () => {
    const m = mem({ type: "feedback", name: "no_mock_db", updatedAt: "2026-07-01T12:34:56.789Z" })
    const stamp = memoryStamp("clawd", m)
    expect(stamp).toBe("memory:clawd/feedback_no_mock_db@2026-07-01T12:34:56.789Z")
    const parsed = parseMemoryStamp(stamp)!
    expect(parsed).toMatchObject({
      agentId: "clawd",
      type: "feedback",
      name: "no_mock_db",
      updatedAt: "2026-07-01T12:34:56.789Z",
      key: "clawd/feedback_no_mock_db",
    })
    expect(parsed.key).toBe(memoryKey("clawd", m))
  })

  it("returns null for raw entry ids and malformed stamps", () => {
    expect(parseMemoryStamp("entry-abc123")).toBeNull()
    expect(parseMemoryStamp("memory:")).toBeNull()
    expect(parseMemoryStamp("memory:no-slash@2026")).toBeNull()
    expect(parseMemoryStamp("memory:a/no-underscore@2026")).toBeNull()
    expect(parseMemoryStamp("memory:a/badtype_x@2026")).toBeNull()
    expect(parseMemoryStamp("memory:a/project_x")).toBeNull() // no version
    expect(parseMemoryStamp("memory:a/project_@2026")).toBeNull() // empty name
  })
})

describe("mergeSources", () => {
  it("replaces stale stamps for the same key, keeps raw entry ids and other stamps", () => {
    const old = memoryStamp("clawd", mem({ updatedAt: "2026-06-01T10:00:00.000Z" }))
    const other = memoryStamp("cx", mem({ name: "wacli", type: "reference" }))
    const fresh = memoryStamp("clawd", mem({ updatedAt: "2026-07-01T10:00:00.000Z" }))
    const merged = mergeSources(["entry-1", old, other], [fresh])
    expect(merged).toEqual(["entry-1", other, fresh])
  })

  it("dedupes and tolerates undefined existing", () => {
    const s = memoryStamp("a", mem())
    expect(mergeSources(undefined, [s, s])).toEqual([s])
  })
})

describe("listAllAgentMemories", () => {
  it("enumerates agent subdirs and skips underscore/dot dirs", () => {
    const store = new AgentMemory({ baseDir: ROOT })
    store.save({ agentId: "clawd", type: "project", name: "ports", description: "d", body: "b" })
    store.save({ agentId: "cx", type: "reference", name: "wacli", description: "d", body: "b" })
    mkdirSync(resolve(store.baseDir, "_scratch"), { recursive: true })
    mkdirSync(resolve(store.baseDir, ".hidden"), { recursive: true })

    const all = listAllAgentMemories(ROOT)
    expect(all).toHaveLength(2)
    expect(all.map((x) => x.agentId).sort()).toEqual(["clawd", "cx"])
  })

  it("returns empty when the memory root does not exist", () => {
    expect(listAllAgentMemories(resolve(ROOT, "nope"))).toEqual([])
  })
})

describe("promotion ledger", () => {
  it("round-trips entries and compacts to newest per key", () => {
    appendPromotionLedger(WIKI_DIR, [
      { stamp: memoryStamp("a", mem({ updatedAt: "2026-06-01T00:00:00.000Z" })), decision: "skipped", reason: "old", at: "2026-06-02T00:00:00.000Z" },
    ])
    appendPromotionLedger(WIKI_DIR, [
      { stamp: memoryStamp("a", mem({ updatedAt: "2026-07-01T00:00:00.000Z" })), decision: "promoted", article: "concepts/x.md", at: "2026-07-02T00:00:00.000Z" },
    ])
    const ledger = readPromotionLedger(WIKI_DIR)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].decision).toBe("promoted")
    expect(ledger[0].stamp).toContain("@2026-07-01")
  })

  it("treats a corrupt ledger as empty", () => {
    writeFileSync(resolve(WIKI_DIR, PROMOTION_LEDGER_FILE), "{not json")
    expect(readPromotionLedger(WIKI_DIR)).toEqual([])
    writeFileSync(resolve(WIKI_DIR, PROMOTION_LEDGER_FILE), JSON.stringify({ nope: true }))
    expect(readPromotionLedger(WIKI_DIR)).toEqual([])
  })
})

describe("getUnpromotedMemories", () => {
  const all = [
    { agentId: "clawd", memory: mem() },
    { agentId: "cx", memory: mem({ name: "wacli", type: "reference", updatedAt: "2026-06-15T10:00:00.000Z" }) },
    { agentId: "clawd", memory: mem({ name: "anis", type: "user" }) },
  ]

  it("excludes user memories by default, includes them when opted in", () => {
    const def = getUnpromotedMemories(all, index(), [])
    expect(def.map((c) => c.key).sort()).toEqual(["clawd/project_server_ports", "cx/reference_wacli"])
    expect(DEFAULT_PROMOTE_TYPES).not.toContain("user")

    const withUser = getUnpromotedMemories(all, index(), [], { types: ["user"] })
    expect(withUser.map((c) => c.key)).toEqual(["clawd/user_anis"])
  })

  it("skips memories already stamped into article sources; re-runs are no-ops", () => {
    const stamped = index([{ sources: ["entry-1", memoryStamp("clawd", mem())] }])
    const out = getUnpromotedMemories(all, stamped, [])
    expect(out.map((c) => c.key)).toEqual(["cx/reference_wacli"])
  })

  it("re-promotes when updatedAt is newer than the recorded stamp or skip", () => {
    const oldStamp = memoryStamp("clawd", mem({ updatedAt: "2026-05-01T00:00:00.000Z" }))
    const stamped = index([{ sources: [oldStamp] }])
    const out = getUnpromotedMemories(all, stamped, [])
    expect(out.map((c) => c.key)).toContain("clawd/project_server_ports")

    const ledger: PromotionLedger = [
      { stamp: memoryStamp("cx", mem({ name: "wacli", type: "reference", updatedAt: "2026-06-15T10:00:00.000Z" })), decision: "skipped", reason: "n/a", at: "2026-06-16T00:00:00.000Z" },
    ]
    const suppressed = getUnpromotedMemories(all, index(), ledger)
    expect(suppressed.map((c) => c.key)).not.toContain("cx/reference_wacli")

    const newer = all.map((x) =>
      x.agentId === "cx" ? { ...x, memory: { ...x.memory, updatedAt: "2026-06-20T10:00:00.000Z" } } : x,
    )
    const resurfaced = getUnpromotedMemories(newer, index(), ledger)
    expect(resurfaced.map((c) => c.key)).toContain("cx/reference_wacli")
  })

  it("filters by agent and by since-window with injected now", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z")
    const byAgent = getUnpromotedMemories(all, index(), [], { agentFilter: "cx" })
    expect(byAgent.map((c) => c.agentId)).toEqual(["cx"])

    // cx memory updated 2026-06-15 → outside a 7d window, inside 30d
    const week = getUnpromotedMemories(all, index(), [], { sinceMs: 7 * 86400_000, now })
    expect(week.map((c) => c.key)).toEqual([])
    const month = getUnpromotedMemories(all, index(), [], { sinceMs: 30 * 86400_000, now })
    expect(month.map((c) => c.key).sort()).toEqual(["clawd/project_server_ports", "cx/reference_wacli"])
  })

  it("sorts newest first and honors max", () => {
    const out = getUnpromotedMemories(all, index(), [], { max: 1 })
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe("cx/reference_wacli") // 06-15 > 06-01
  })
})

function cand(agentId: string, over: Partial<MemoryRecord> = {}): MemoryCandidate {
  const memory = mem(over)
  return { agentId, memory, key: memoryKey(agentId, memory), stamp: memoryStamp(agentId, memory) }
}

describe("groupCandidates", () => {
  it("clusters same type_name across agents as corroboration with higher confidence", () => {
    const clusters = groupCandidates([
      cand("clawd"),
      cand("devops", { updatedAt: "2026-06-10T00:00:00.000Z" }),
      cand("cx", { name: "wacli", type: "reference" }),
      cand("cx", { name: "style", type: "feedback" }),
    ])
    expect(clusters).toHaveLength(3)
    const corroborated = clusters.find((c) => c.candidates.length === 2)!
    expect(corroborated.corroboratingAgents).toEqual(["clawd", "devops"])
    // 0.5 + 0.15·1 + 0.05 (project) = 0.70
    expect(corroborated.confidence).toBeCloseTo(0.7)
    const singleRef = clusters.find((c) => c.candidates[0].memory.name === "wacli")!
    expect(singleRef.confidence).toBeCloseTo(0.55) // reference boost, single agent
    const singleFb = clusters.find((c) => c.candidates[0].memory.type === "feedback")!
    expect(singleFb.confidence).toBeCloseTo(0.5) // no boost
  })
})

describe("parsePromotionResponse", () => {
  const offered = new Set([cand("clawd").stamp, cand("cx", { name: "wacli", type: "reference" }).stamp])
  const goodArticle = {
    path: "concepts/ports.md",
    title: "Server Ports",
    type: "concept",
    related: ["Clawd Server"],
    tags: ["infra"],
    content: "Ports for [[Clawd Server]] …",
    promotedFrom: [cand("clawd").stamp],
  }

  it("parses a valid response surrounded by prose", () => {
    const text = `Here you go:\n${JSON.stringify({ articles: [goodArticle], skipped: [{ memory: cand("cx", { name: "wacli", type: "reference" }).stamp, reason: "transient" }], gaps: ["Clawd Server — no article"] })}\nDone.`
    const out = parsePromotionResponse(text, offered)
    if ("error" in out) throw new Error(out.error)
    expect(out.articles).toHaveLength(1)
    expect(out.articles[0].promotedFrom).toEqual([cand("clawd").stamp])
    expect(out.skipped).toEqual([{ stamp: cand("cx", { name: "wacli", type: "reference" }).stamp, reason: "transient" }])
    expect(out.gaps).toEqual(["Clawd Server — no article"])
    expect(out.warnings).toEqual([])
  })

  it("errors on prose-only, unbalanced, and articles-missing responses", () => {
    expect(parsePromotionResponse("no json here", offered)).toHaveProperty("error")
    expect(parsePromotionResponse('{"articles": [', offered)).toHaveProperty("error")
    expect(parsePromotionResponse('{"gaps": []}', offered)).toHaveProperty("error")
  })

  it("drops hallucinated stamps; drops articles left with zero valid stamps", () => {
    const fake = "memory:ghost/project_nope@2026-01-01T00:00:00.000Z"
    const text = JSON.stringify({
      articles: [
        { ...goodArticle, promotedFrom: [cand("clawd").stamp, fake] },
        { ...goodArticle, path: "concepts/ghost.md", promotedFrom: [fake] },
      ],
      skipped: [{ memory: fake, reason: "x" }],
      gaps: [],
    })
    const out = parsePromotionResponse(text, offered)
    if ("error" in out) throw new Error(out.error)
    expect(out.articles).toHaveLength(1)
    expect(out.articles[0].promotedFrom).toEqual([cand("clawd").stamp])
    expect(out.skipped).toEqual([])
    expect(out.warnings.length).toBeGreaterThanOrEqual(3)
  })

  it("is not fooled by braces inside JSON strings", () => {
    const text = JSON.stringify({ articles: [{ ...goodArticle, content: 'code: `if (x) { return "}" }`' }], skipped: [], gaps: [] })
    const out = parsePromotionResponse(text, offered)
    if ("error" in out) throw new Error(out.error)
    expect(out.articles[0].content).toContain('"}"')
  })
})

describe("buildMemoryPromotePrompt", () => {
  it("contains the wikilink mandate, exact stamps, corroboration, and truncated bodies", () => {
    const long = cand("clawd", { body: "x".repeat(PROMOTE_BODY_LIMIT + 500) })
    const clusters = groupCandidates([long, cand("devops")])
    const prompt = buildMemoryPromotePrompt(
      "memory-promoter",
      clusters,
      [{ title: "Clawd Server", path: "concepts/clawd-server.md", type: "concept" }],
      "",
    )
    expect(prompt).toContain("2–5 other articles via `[[Article Title]]` wikilinks")
    expect(prompt).toContain(long.stamp)
    expect(prompt).toContain("corroborated by: clawd, devops (2 agents)")
    expect(prompt).toContain("[… truncated]")
    expect(prompt).not.toContain("x".repeat(PROMOTE_BODY_LIMIT + 1))
    expect(prompt).toContain("[[Clawd Server]] — concepts/clawd-server.md")
    expect(prompt).toContain("Never a secret")
    expect(prompt).toContain('"promotedFrom"')
  })
})
