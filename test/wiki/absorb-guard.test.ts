import { describe, expect, it } from "vitest"
import { describeDrops, droppedFacts, hasDrops, mergeUpdateMeta } from "../../src/wiki/absorb-guard"
import type { WikiArticleMeta } from "../../src/wiki/types"

// Trimmed from the live article Opus rewrote blind in the 2026-10-07 A/B
// (events/2026-09-27-agentx-pr-198-peer-event-feed-review-not-ready.md).
const OLD = `AgentX PR #198 Peer Event Feed Reviewed: NOT READY (2026-09-27)
## Identity
- **What changed:** the [[DevOps Agent]] posted Verdict: NOT READY on PR #198 (closes #166), commit \`1a01e02\`. Comment: https://github.com/anis-marrouchi/agentx/pull/198#issuecomment-5859942151.
- **Involved:** reviewer [[DevOps Agent]], requester [[Anis Marrouchi]].

## Results
Typecheck passes; the PR's 3 new test files pass (16/16).
1. The dashboard route \`/api/mesh/feed\` is handled before the token check.
2. After 45 s of quiet the follower marks the peer down; reproduced as 16 down/up flips in 1.5 s.
- Dedup map capped at 20,000 entries.`

// What Opus wrote over it: the re-review only.
const BLIND = `AgentX PR #198 Peer Event Feed Reviewed: READY (2026-09-27)
The [[DevOps Agent]] re-reviewed PR #198 at head \`056ff66\` and posted Verdict: READY:
https://github.com/anis-marrouchi/agentx/pull/198#issuecomment-5860129896. 27 new tests pass; full suite 3037 passed, 22 skipped.`

// A merge that keeps the first review as history.
const MERGED = `AgentX PR #198 Peer Event Feed Reviewed: NOT READY, Then READY (2026-09-27)
## Identity
- **What changed:** the [[DevOps Agent]] reviewed PR #198 (closes #166) twice for [[Anis Marrouchi]].

## First review — NOT READY at \`1a01e02\`
Comment: https://github.com/anis-marrouchi/agentx/pull/198#issuecomment-5859942151. 3 test files, 16/16 passing.
- Dashboard route \`/api/mesh/feed\` before the token check.
- Older peers flap after 45 s of quiet: 16 down/up flips in 1.5 s.
- Dedup map capped at 20000 entries.

## Re-review — READY at \`056ff66\`
https://github.com/anis-marrouchi/agentx/pull/198#issuecomment-5860129896. 27 new tests; 3037 passed, 22 skipped.`

describe("droppedFacts", () => {
  it("catches the A/B blind rewrite: commit, comment URL, wikilink and counts", () => {
    const d = droppedFacts(OLD, BLIND)
    expect(hasDrops(d)).toBe(true)
    expect(d.commits).toEqual(["1a01e02"])
    expect(d.links).toContain("https://github.com/anis-marrouchi/agentx/pull/198#issuecomment-5859942151")
    expect(d.links).toContain("[[anis marrouchi]]")
    expect(d.numbers).toEqual(expect.arrayContaining(["166", "16/16", "45", "16", "1.5", "20000"]))
    expect(describeDrops(d)).toMatch(/commits 1a01e02/)
  })

  it("passes a merge that keeps the old facts as history", () => {
    const d = droppedFacts(OLD, MERGED)
    expect(d).toEqual({ commits: [], links: [], numbers: [] })
  })

  it("ignores numbered-list markers, which a rewrite renumbers", () => {
    const before = "Steps\n1. build\n2. deploy at 14:00"
    const after = "Steps\n- build\n- deploy at 14:00"
    expect(hasDrops(droppedFacts(before, after))).toBe(false)
  })

  it("a number inside a longer one does not count as kept", () => {
    expect(droppedFacts("7 notes", "17 notes").numbers).toEqual(["7"])
    expect(droppedFacts("16 flips", "16/16 tests").numbers).toEqual(["16"])
    expect(droppedFacts("v0.115.0", "v0.115.1").numbers).toEqual(["0.115.0"])
  })

  it("keeps a number next to a letter or a dash", () => {
    expect(hasDrops(droppedFacts("PR-198 and #166", "see PR-198, #166"))).toBe(false)
  })

  it("reads thousands separators either way", () => {
    expect(hasDrops(droppedFacts("20,000 entries", "20000 entries"))).toBe(false)
    expect(hasDrops(droppedFacts("20000 entries", "20,000 entries"))).toBe(false)
  })

  it("does not take hex-looking words for commits", () => {
    expect(droppedFacts("the facade was defaced", "rewritten").commits).toEqual([])
  })

  it("a commit kept inside a URL or as a longer SHA counts as kept", () => {
    expect(droppedFacts("at 1a01e02", "https://github.com/x/y/commit/1a01e02f9").commits).toEqual([])
  })

  it("wikilinks compare by target, case-insensitively, aliases ignored", () => {
    expect(hasDrops(droppedFacts("by [[DevOps Agent]]", "by [[devops agent|the reviewer]]"))).toBe(false)
  })

  it("a URL's trailing full stop is punctuation, not part of the link", () => {
    expect(hasDrops(droppedFacts("See https://x.tld/a.", "Link: https://x.tld/a"))).toBe(false)
  })
})

describe("mergeUpdateMeta", () => {
  const old: WikiArticleMeta = {
    title: "Old",
    type: "event",
    related: ["DevOps Agent", "Anis Marrouchi"],
    tags: ["agentx"],
    owner: "devops-agent",
    access: "shared",
    sharedWith: ["secretary-agent"],
    created: "2026-09-27",
    lastUpdated: "2026-09-27",
    sources: ["devops-agent-mukbrpfj"],
    graphPath: ["code", "review.merge-request"],
  }
  const next: WikiArticleMeta = {
    title: "New",
    type: "event",
    related: ["DevOps Agent", "AgentX Mesh"],
    tags: ["agentx", "code-review"],
    owner: "devops-agent",
    access: "public",
    created: "2026-10-07",
    lastUpdated: "2026-10-07",
    sources: ["devops-agent-mukcp96h"],
  }

  it("unions sources and related, keeps creation date, access and graph path", () => {
    const m = mergeUpdateMeta(old, next)
    // The A/B rewrite replaced sources: [mukbrpfj] with the new entry only.
    expect(m.sources).toEqual(["devops-agent-mukbrpfj", "devops-agent-mukcp96h"])
    expect(m.related).toEqual(["DevOps Agent", "Anis Marrouchi", "AgentX Mesh"])
    expect(m.created).toBe("2026-09-27")
    expect(m.lastUpdated).toBe("2026-10-07")
    expect(m.access).toBe("shared")
    expect(m.sharedWith).toEqual(["secretary-agent"])
    expect(m.graphPath).toEqual(["code", "review.merge-request"])
    expect(m.title).toBe("New")
    expect(m.tags).toEqual(["agentx", "code-review"])
  })

  it("a new graph path replaces the old one", () => {
    expect(mergeUpdateMeta(old, { ...next, graphPath: ["ops"] }).graphPath).toEqual(["ops"])
  })
})
