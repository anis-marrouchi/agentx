import { describe, expect, it } from "vitest"
import {
  buildJudgePrompt,
  buildScorecard,
  checkArticle,
  envelopeUsage,
  findDuplicates,
  parseJudgeReply,
  pickSample,
  renderScorecard,
  summariseRuns,
  termOverlap,
  uncitedWithFacts,
  type AbsorbCallRecord,
  type EvalEntry,
} from "../../src/wiki/absorb-eval"

// #808: the absorb scorecard and the before/after telemetry.

const entries = new Map<string, EvalEntry>([
  ["e1", {
    id: "e1",
    date: "2026-10-07",
    content: "Merged the voice login fix in commit 1a01e02. Review at https://code.example.test/reviews/311. 48 tests pass.",
  }],
  ["e2", {
    id: "e2",
    date: "2026-10-07",
    content: "Deployed the staging billing service; release notes at https://docs.example.test/billing/notes and build 9f3c2d1.",
  }],
  ["e3", {
    id: "e3",
    date: "2026-10-06",
    content: "Lunch order for the team: pizza margherita, salad, lemonade. Delivery around noon tomorrow afternoon.",
  }],
])

const article = (over: Partial<Parameters<typeof checkArticle>[0]> = {}) => ({
  path: "agent-a/events/2026-10-07-voice-login-fix.md",
  title: "Voice login fix",
  type: "event",
  content: "The [[Voice App]] login fix merged in commit 1a01e02 with 48 tests passing. Review: https://code.example.test/reviews/311.",
  sources: ["e1"],
  ...over,
})

describe("pickSample", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ path: `p${String(i).padStart(2, "0")}` }))

  it("is stable for a seed and order-independent", () => {
    const a = pickSample(items, 5, "seed-1")
    const b = pickSample([...items].reverse(), 5, "seed-1")
    expect(a).toEqual(b)
    expect(a).toHaveLength(5)
  })

  it("changes with the seed", () => {
    expect(pickSample(items, 5, "seed-1")).not.toEqual(pickSample(items, 5, "seed-2"))
  })

  it("caps at the pool size", () => {
    expect(pickSample(items.slice(0, 3), 10, "x")).toHaveLength(3)
  })
})

describe("checkArticle", () => {
  it("passes a faithful article", () => {
    const a = article()
    const c = checkArticle(a, entries, () => [a.content])
    expect(c.missingSources).toEqual([])
    expect(c.weakSources).toEqual([])
    expect(c.ungrounded).toEqual([])
    expect(c.lost).toEqual([])
  })

  it("flags a commit, link and number no source carries", () => {
    const a = article({
      content: "The login fix merged in commit 1a01e02 and 7bb9e10 with 512 tests. Review: https://code.example.test/reviews/311 and https://code.example.test/reviews/999.",
    })
    const c = checkArticle(a, entries, () => [a.content])
    expect(c.ungrounded).toEqual(expect.arrayContaining(["commit 7bb9e10", "link https://code.example.test/reviews/999", "number 512"]))
    expect(c.ungrounded).not.toContain("commit 1a01e02")
  })

  it("counts facts from the earlier version as grounded", () => {
    const a = article({
      content: "Login fix in commit 1a01e02, follow-up in 7bb9e10. Review: https://code.example.test/reviews/311.",
      previous: "Follow-up landed in 7bb9e10.",
    })
    expect(checkArticle(a, entries, () => [a.content]).ungrounded).toEqual([])
  })

  it("reports a missing source and an off-subject one", () => {
    const a = article({ sources: ["e1", "e3", "gone"] })
    const c = checkArticle(a, entries, () => [a.content])
    expect(c.missingSources).toEqual(["gone"])
    expect(c.weakSources).toEqual(["e3"])
  })

  it("reports identifiers lost from a cited entry", () => {
    const a = article({ content: "The voice login fix merged.", sources: ["e1"] })
    const c = checkArticle(a, entries, () => [a.content])
    expect(c.lost.map((l) => l.fact)).toEqual(["commit 1a01e02", "link https://code.example.test/reviews/311"])
  })

  it("does not count a fact a sibling article carries as lost", () => {
    const a = article({ content: "The voice login fix merged.", sources: ["e1"] })
    const sibling = "Review https://code.example.test/reviews/311 for commit 1a01e02."
    expect(checkArticle(a, entries, () => [a.content, sibling]).lost).toEqual([])
  })
})

describe("findDuplicates", () => {
  const catalog = [
    { path: "a/projects/billing-service.md", title: "Billing Service", type: "project", sources: ["e2", "e4"] },
    { path: "a/projects/the-billing-service.md", title: "The Billing Service", type: "project", sources: ["e9"] },
    { path: "a/concepts/billing.md", title: "Billing", type: "concept", sources: ["e2", "e4", "e5"] },
    { path: "a/people/jane-doe.md", title: "Jane Doe", type: "person", sources: ["e7"] },
  ]

  it("pairs same-type near-identical titles and shared sources", () => {
    const pairs = findDuplicates(catalog)
    expect(pairs.map((p) => [p.a, p.b, p.reason])).toEqual(expect.arrayContaining([
      ["a/projects/billing-service.md", "a/projects/the-billing-service.md", "title"],
      ["a/projects/billing-service.md", "a/concepts/billing.md", "sources"],
    ]))
    expect(pairs.some((p) => p.a.includes("jane") || p.b.includes("jane"))).toBe(false)
  })

  it("keeps titles that differ only by a number apart", () => {
    expect(findDuplicates([
      { path: "a/events/release-2.md", title: "Release 2", type: "event" },
      { path: "a/events/release-3.md", title: "Release 3", type: "event" },
    ])).toEqual([])
  })

  it("keeps only pairs touching the focus set", () => {
    expect(findDuplicates(catalog, new Set(["a/people/jane-doe.md"]))).toEqual([])
  })
})

describe("judge", () => {
  it("puts the article, the earlier version and the cut entries in the prompt", () => {
    const long: EvalEntry = { id: "e9", content: "x".repeat(5000) }
    const p = buildJudgePrompt(article({ previous: "OLD BODY" }), [entries.get("e1")!, long])
    expect(p).toContain("Voice login fix")
    expect(p).toContain("OLD BODY")
    expect(p).toContain("--- ENTRY e1")
    expect(p).toContain("[…cut]")
  })

  it("parses a reply and rejects a malformed one", () => {
    expect(parseJudgeReply({ claims: 5, supported: 4, unsupported: ["x"], off_subject: ["e3"], verdict: "major" })).toEqual({
      claims: 5, supported: 4, unsupported: ["x"], contradicted: [], offSubject: ["e3"], missing: [], verdict: "major",
    })
    expect(parseJudgeReply({ claims: 3, unsupported: ["x"], verdict: "minor" })?.supported).toBe(2)
    expect(parseJudgeReply({ claims: 3, verdict: "fine" })).toBeNull()
    expect(parseJudgeReply([])).toBeNull()
  })
})

describe("scorecard", () => {
  it("aggregates checks, duplicates and judge verdicts", () => {
    const good = article()
    const bad = article({ path: "agent-a/events/x.md", content: "Merged in 7bb9e10.", sources: ["e1", "e3", "gone"] })
    const checks = [good, bad].map((a) => checkArticle(a, entries, () => [a.content]))
    const card = buildScorecard(
      checks,
      [{ a: "agent-a/events/x.md", b: "agent-a/events/y.md", reason: "title", score: 0.8 }],
      { seed: "s", since: "2026-10-07" },
      [
        { path: good.path, verdict: { claims: 4, supported: 4, unsupported: [], contradicted: [], offSubject: [], missing: [], verdict: "good" } },
        { path: bad.path, verdict: { claims: 2, supported: 0, unsupported: ["merged in 7bb9e10"], contradicted: [], offSubject: ["e3"], missing: ["review link"], verdict: "major" } },
      ],
    )
    expect(card.sample).toMatchObject({ articles: 2, byType: { event: 2 } })
    expect(card.citations).toMatchObject({ withSources: 2, missingSources: 1, articlesWithWeak: 1 })
    expect(card.grounding.articlesWithUngrounded).toBe(1)
    expect(card.lost.lostFacts).toBe(2)
    expect(card.duplicates.articlesInPair).toBe(1)
    expect(card.judge).toMatchObject({ judged: 2, claims: 6, supported: 4, articlesWithWrongMerge: 1, verdicts: { good: 1, minor: 0, major: 1 } })

    const md = renderScorecard(card)
    expect(md).toContain("| Judge: claims supported by the cited entries | 4/6 (67%) | no |")
    expect(md).toContain("commit 7bb9e10")
    expect(md).toContain("## Method")
  })
})

describe("telemetry", () => {
  it("reads cost and tokens from the claude envelope", () => {
    expect(envelopeUsage({
      total_cost_usd: 0.12, duration_api_ms: 30000,
      usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 },
    })).toEqual({ costUsd: 0.12, apiMs: 30000, inputTokens: 10, outputTokens: 2000, cacheReadTokens: 5000, cacheWriteTokens: 700 })
    expect(envelopeUsage("nope")).toEqual({})
  })

  const call = (over: Partial<AbsorbCallRecord>): AbsorbCallRecord => ({
    kind: "call", at: "2026-10-07T20:10:00.000Z", agent: "a", model: "sonnet",
    entries: 10, articles: 3, refused: 0, failed: false, wallMs: 60_000, promptChars: 1000, costUsd: 0.2, ...over,
  })

  it("groups by label and uses the run span for wall time", () => {
    const s = summariseRuns([
      call({ label: "serial", at: "2026-10-07T20:01:00.000Z" }),
      call({ label: "serial", at: "2026-10-07T20:02:00.000Z", agent: "b" }),
      { kind: "run", label: "serial", startedAt: "2026-10-07T20:00:00.000Z", endedAt: "2026-10-07T20:02:00.000Z", max: 10, model: "sonnet" },
      call({ label: "parallel", at: "2026-10-07T21:01:00.000Z" }),
      call({ label: "parallel", at: "2026-10-07T21:01:00.000Z", agent: "b", failed: true, refused: 1, heldCited: 2 }),
    ])
    const serial = s.find((x) => x.label === "serial")!
    const parallel = s.find((x) => x.label === "parallel")!
    expect(serial).toMatchObject({ calls: 2, entries: 20, wallMs: 120_000, entriesPerMinute: 10 })
    expect(serial.costPerEntry).toBeCloseTo(0.02)
    // No run record: first call start to last call end.
    expect(parallel).toMatchObject({ calls: 2, failed: 1, refused: 1, heldCited: 2, wallMs: 60_000 })
    expect(parallel.entriesPerMinute).toBe(20)
  })
})

describe("uncitedWithFacts", () => {
  it("reports identifiers in uncited entries that no article carries", () => {
    const all = "Billing release notes: https://docs.example.test/billing/notes"
    expect(uncitedWithFacts([entries.get("e1")!, entries.get("e2")!, entries.get("e3")!], all)).toEqual([
      { entry: "e1", facts: ["commit 1a01e02", "link https://code.example.test/reviews/311"] },
      { entry: "e2", facts: ["commit 9f3c2d1"] },
    ])
  })
})
