import { describe, it, expect } from "vitest"
import { rankCatalogPool } from "../src/wiki/query"

// The retrieval scorer's graph weight multiplied zero for every query: no
// caller ever passed the request's intent path. Catalog candidates are now
// ordered by text match plus how much of the path they share.

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

  it("with a path, articles on the same branch move ahead of equal text matches", () => {
    const order = rankCatalogPool("how do we deploy", pool, ["ops", "deploy.staging"])
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(1)
  })

  it("a branch match alone can surface an article the text missed", () => {
    const order = rankCatalogPool("what is the process", pool, ["code", "review.merge-request"])
    expect(order[0]).toBe(2)
  })

  it("every article stays in the order exactly once", () => {
    const order = rankCatalogPool("plants", pool, ["ops"])
    expect([...order].sort()).toEqual([0, 1, 2, 3])
  })
})
