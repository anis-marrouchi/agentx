import { describe, expect, it } from "vitest"
import {
  PROMOTABLE_KINDS,
  parseReviewStamp,
  reviewStamp,
  reviewsToCandidates,
} from "../../src/wiki/review-candidates"

const review = (obj: Record<string, unknown>) => JSON.stringify(obj)

const row = (id: string, result: string, agent = "devops-agent") => ({
  id, agent, source: "telegram", updated_at: Date.UTC(2026, 8, 19), result,
})

const LONG = "The deploy left a debug port open on the production host after the run finished"
const LONG2 = "Retries were counted per attempt rather than per job, so the alert fired early"

describe("reviewStamp", () => {
  it("keys on the text, not the position", () => {
    // The monitor re-reviews a session as it progresses, so the same
    // finding reappears at a different index later. Indexing by position
    // would promote it again as something new.
    expect(reviewStamp("r1", "warnings", LONG)).toBe(reviewStamp("r1", "warnings", LONG))
  })

  it("ignores case and surrounding whitespace", () => {
    expect(reviewStamp("r1", "warnings", `  ${LONG.toUpperCase()}  `)).toBe(reviewStamp("r1", "warnings", LONG))
  })

  it("separates kinds and reviews", () => {
    expect(reviewStamp("r1", "decisions", LONG)).not.toBe(reviewStamp("r1", "warnings", LONG))
    expect(reviewStamp("r2", "warnings", LONG)).not.toBe(reviewStamp("r1", "warnings", LONG))
  })

  it("round-trips through the parser", () => {
    const parsed = parseReviewStamp(reviewStamp("sess-1/abc", "warnings", LONG))!
    expect(parsed.reviewId).toBe("sess-1/abc")
    expect(parsed.kind).toBe("warnings")
  })

  it("rejects a stamp from another source", () => {
    expect(parseReviewStamp("memory:devops/project_x@123")).toBeNull()
  })
})

describe("reviewsToCandidates", () => {
  it("promotes the kinds that describe what is or was", () => {
    const rows = [row("r1", review({
      decisions: [{ text: LONG, evidence: "log line 4" }],
      context: [{ text: LONG2 }],
    }))]
    const c = reviewsToCandidates(rows)
    expect(c).toHaveLength(2)
    expect(c.map((x) => x.memory.type).sort()).toEqual(["project", "reference"])
  })

  it("never promotes actions", () => {
    // An action goes stale the moment it is done or abandoned, and a
    // wiki full of last month's to-dos is worse than one without them.
    expect(PROMOTABLE_KINDS.actions).toBeUndefined()
    const rows = [row("r1", review({ actions: [{ text: LONG, when: "now" }] }))]
    expect(reviewsToCandidates(rows)).toEqual([])
  })

  it("carries the evidence into the body", () => {
    // A warning without it is an assertion a reader has to take on faith,
    // and the monitor already collected it.
    const rows = [row("r1", review({ warnings: [{ text: LONG, evidence: "port 9222 still listening" }] }))]
    expect(reviewsToCandidates(rows)[0].memory.body).toContain("port 9222 still listening")
    expect(reviewsToCandidates(rows)[0].memory.body).toContain("**Evidence:**")
  })

  it("works without evidence rather than emitting an empty section", () => {
    const rows = [row("r1", review({ warnings: [{ text: LONG }] }))]
    const body = reviewsToCandidates(rows)[0].memory.body
    expect(body).toContain(LONG)
    expect(body).not.toContain("**Evidence:**")
  })

  it("drops findings too short to carry anything", () => {
    const rows = [row("r1", review({ warnings: [{ text: "deploy ok" }] }))]
    expect(reviewsToCandidates(rows)).toEqual([])
  })

  it("dedupes a finding restated across reviews of the same run", () => {
    const rows = [
      row("r1", review({ warnings: [{ text: LONG }] })),
      row("r2", review({ warnings: [{ text: LONG }] })),
    ]
    expect(reviewsToCandidates(rows)).toHaveLength(1)
  })

  it("keeps two genuinely different findings", () => {
    const rows = [row("r1", review({ warnings: [{ text: LONG }, { text: LONG2 }] }))]
    expect(reviewsToCandidates(rows)).toHaveLength(2)
  })

  it("survives a row whose result is not JSON", () => {
    expect(reviewsToCandidates([row("r1", "not json")])).toEqual([])
  })

  it("ignores a kind that is not an array", () => {
    expect(reviewsToCandidates([row("r1", review({ warnings: "oops" }))])).toEqual([])
  })

  it("can be narrowed to specific kinds", () => {
    const rows = [row("r1", review({
      decisions: [{ text: LONG }],
      warnings: [{ text: LONG2 }],
    }))]
    const c = reviewsToCandidates(rows, { kinds: ["decisions"] })
    expect(c).toHaveLength(1)
    expect(c[0].memory.type).toBe("project")
  })

  it("attributes the finding to the agent whose session produced it", () => {
    const rows = [row("r1", review({ decisions: [{ text: LONG }] }), "marketing-agent")]
    const c = reviewsToCandidates(rows)[0]
    expect(c.agentId).toBe("marketing-agent")
    expect(c.memory.body).toContain("marketing-agent")
  })

  it("produces a slug-safe name and a one-line description", () => {
    const rows = [row("r1", review({ decisions: [{ text: LONG }] }))]
    const m = reviewsToCandidates(rows)[0].memory
    expect(m.name).toMatch(/^[a-z0-9-]+$/)
    expect(m.description.length).toBeLessThanOrEqual(200)
  })

  it("stamps with the review prefix so the ledger can tell the source apart", () => {
    const rows = [row("r1", review({ decisions: [{ text: LONG }] }))]
    expect(reviewsToCandidates(rows)[0].stamp.startsWith("review:")).toBe(true)
  })
})

describe("recurrence ranking", () => {
  it("counts how many reviews stated the same finding", () => {
    const rows = [
      row("r1", review({ warnings: [{ text: LONG }] })),
      row("r2", review({ warnings: [{ text: LONG }] })),
      row("r3", review({ warnings: [{ text: LONG }] })),
    ]
    const c = reviewsToCandidates(rows)
    expect(c).toHaveLength(1)
    expect(c[0].occurrences).toBe(3)
  })

  it("puts recurring findings first, because --max decides what gets seen", () => {
    // A finding stated once is usually about that session; one stated a
    // dozen times is a property of the fleet. Without this the 5,000
    // candidates arrive in arbitrary order.
    const rows = [
      row("r1", review({ warnings: [{ text: LONG2 }] })),
      row("r2", review({ warnings: [{ text: LONG }] })),
      row("r3", review({ warnings: [{ text: LONG }] })),
    ]
    const c = reviewsToCandidates(rows)
    expect(c[0].memory.description).toBe(LONG)
    expect(c[0].occurrences).toBe(2)
    expect(c[1].occurrences).toBe(1)
  })

  it("counts a restatement even when the wording case differs", () => {
    const rows = [
      row("r1", review({ warnings: [{ text: LONG }] })),
      row("r2", review({ warnings: [{ text: LONG.toUpperCase() }] })),
    ]
    expect(reviewsToCandidates(rows)[0].occurrences).toBe(2)
  })

  it("does not merge the same text under different kinds", () => {
    // "we decided X" and "X is a problem" are different claims even when
    // the sentence is identical.
    const rows = [row("r1", review({ decisions: [{ text: LONG }], warnings: [{ text: LONG }] }))]
    const c = reviewsToCandidates(rows)
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.occurrences === 1)).toBe(true)
  })
})

describe("recurrence counts sessions, not review rows", () => {
  const sess = (id: string, sessionId: string, text: string) => ({
    id, session_id: sessionId, agent: "devops-agent", source: "cli",
    updated_at: Date.UTC(2026, 8, 19), result: review({ warnings: [{ text }] }),
  })

  it("does not inflate a long session into a fleet pattern", () => {
    // The monitor re-reviews a run as it progresses. Counting rows made
    // one miner run that restated an observation 24 times look like the
    // most recurrent finding on the fleet; the judge then threw it out
    // as a snapshot from a single run.
    const rows = [
      sess("r1", "s1", LONG), sess("r2", "s1", LONG), sess("r3", "s1", LONG),
    ]
    expect(reviewsToCandidates(rows)[0].occurrences).toBe(1)
  })

  it("counts a finding that genuinely spans sessions", () => {
    const rows = [
      sess("r1", "s1", LONG), sess("r2", "s2", LONG), sess("r3", "s3", LONG),
    ]
    expect(reviewsToCandidates(rows)[0].occurrences).toBe(3)
  })

  it("ranks a cross-session finding above a much-repeated single-session one", () => {
    const rows = [
      sess("r1", "s1", LONG2), sess("r2", "s1", LONG2), sess("r3", "s1", LONG2), sess("r4", "s1", LONG2),
      sess("r5", "s2", LONG), sess("r6", "s3", LONG),
    ]
    const c = reviewsToCandidates(rows)
    expect(c[0].memory.description).toBe(LONG)
    expect(c[0].occurrences).toBe(2)
  })

  it("falls back to the row id when no session is recorded", () => {
    const rows = [row("r1", review({ warnings: [{ text: LONG }] })), row("r2", review({ warnings: [{ text: LONG }] }))]
    expect(reviewsToCandidates(rows)[0].occurrences).toBe(2)
  })
})
