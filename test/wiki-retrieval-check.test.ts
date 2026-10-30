import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DEFAULT_RETRIEVAL_FLOOR, findRetrievalCases, hitAt, isArticlePath, parseRetrievalCases } from "../src/wiki/retrieval-check"

describe("wiki retrieval check (#603)", () => {
  it("reads compiled articles only", () => {
    expect(isArticlePath("agents/ops/graph/concept/deploys.md")).toBe(true)
    expect(isArticlePath("concept/deploys.md")).toBe(true)
    for (const rel of ["raw/2026-10-01/ops-x.md", "agents/ops/raw/e.md", "_facts.md", "agents/_index/a.md", "WIKI.md", "agents/ops/log.md", "worldview.md", "concept/notes.txt"]) {
      expect(isArticlePath(rel), rel).toBe(false)
    }
  })

  it("reads a questions file with a floor, or a bare list with the default floor", () => {
    const one = { query: "how do we deploy", expectedTitleContains: "Deploys" }
    expect(parseRetrievalCases(JSON.stringify({ floor: 0.8, cases: [one] }))).toEqual({ floor: 0.8, cases: [{ name: "how do we deploy", ...one }] })
    expect(parseRetrievalCases(JSON.stringify([{ ...one, name: "deploy", category: "infra" }]))).toEqual({
      floor: DEFAULT_RETRIEVAL_FLOOR,
      cases: [{ name: "deploy", category: "infra", ...one }],
    })
  })

  it("says what is wrong with a bad file", () => {
    expect(() => parseRetrievalCases("[]")).toThrow(/no cases/)
    expect(() => parseRetrievalCases(JSON.stringify([{ query: "q" }]))).toThrow(/case 1: "expectedTitleContains" is missing/)
    expect(() => parseRetrievalCases(JSON.stringify({ floor: 2, cases: [{ query: "q", expectedTitleContains: "t" }] }))).toThrow(/floor/)
  })

  it("counts a hit only in the first k titles, any case", () => {
    expect(hitAt(["A", "Deploy steps", "C"], "deploy", 3)).toBe(true)
    expect(hitAt(["A", "B", "C", "Deploy steps"], "deploy", 3)).toBe(false)
  })

  it("finds the private file in .agentx/ or from the environment, never in the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-cases-"))
    try {
      expect(findRetrievalCases(dir, {})).toBeNull()
      mkdirSync(join(dir, ".agentx"))
      writeFileSync(join(dir, ".agentx", "retrieval-cases.json"), "[]")
      expect(findRetrievalCases(dir, {})).toBe(join(dir, ".agentx", "retrieval-cases.json"))
      const other = join(dir, "mine.json")
      writeFileSync(other, "[]")
      expect(findRetrievalCases(dir, { AGENTX_RETRIEVAL_CASES: other })).toBe(other)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
