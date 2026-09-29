import { describe, it, expect } from "vitest"
import { rankCatalogPool } from "../src/wiki/query"
import { DEFAULT_SHORTLIST } from "../src/decisions/seats/wiki-rerank"

// The retrieval scorer's graph weight multiplied zero for every query: no
// caller ever passed the request's intent path. Catalog candidates are now
// ordered by text match, reordered within the matches by shared branch.
// The branch never lifts an article the text did not match above one it
// did: the reranker's shortlist is finite, and a busy category has more
// same-branch articles than slots.

const pool = [
  { title: "Deploy checklist", tags: ["ops"], graphPath: ["ops", "deploy.staging"] },
  { title: "Deploy postmortem 2026-05", tags: ["incident"], graphPath: ["ops", "incident.review"] },
  { title: "Code review guidelines", tags: ["code"], graphPath: ["code", "review.merge-request"] },
  { title: "Office plants", tags: [] },
]

describe("rankCatalogPool", () => {
  it("without a path it is a plain text ranking", () => {
    const order = rankCatalogPool("how do we deploy", pool)
    expect(order.slice(0, 2).sort()).toEqual([0, 1])
    expect(order).toHaveLength(pool.length)
  })

  it("with a path, the branch reorders equal text matches", () => {
    const order = rankCatalogPool("how do we deploy", pool, ["ops", "deploy.staging"])
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(1)
  })

  it("a branch match alone ranks after every text match, ahead of the rest", () => {
    const order = rankCatalogPool("what is the process", pool, ["code", "review.merge-request"])
    // Nothing matches the text; the branch article leads, plants last.
    expect(order[0]).toBe(2)
    expect(order[order.length - 1]).toBe(3)
  })

  it("a strong text match in another category stays in the shortlist under a flood of same-branch articles", () => {
    const flood = Array.from({ length: DEFAULT_SHORTLIST + 10 }, (_, k) => ({
      title: `Ops runbook ${k}`, tags: ["ops"], graphPath: ["ops", `runbook.${k}`],
    }))
    const answer = { title: "Invoice numbering rules", tags: ["billing"], graphPath: ["admin", "invoice.numbering"] }
    const order = rankCatalogPool("how are invoice numbers assigned", [...flood, answer], ["ops", "deploy.staging"])
    expect(order[0]).toBe(flood.length)
    expect(order.slice(0, DEFAULT_SHORTLIST)).toContain(flood.length)
  })

  it("every article stays in the order exactly once", () => {
    const order = rankCatalogPool("plants", pool, ["ops"])
    expect([...order].sort()).toEqual([0, 1, 2, 3])
  })
})
