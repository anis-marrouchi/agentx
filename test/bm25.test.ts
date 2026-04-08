import { describe, it, expect } from "vitest"
import { tokenize, buildIndex, score, scoreAll, STOP_WORDS } from "../src/memory/bm25"

describe("BM25", () => {
  describe("tokenize", () => {
    it("lowercases and splits on non-alphanumeric", () => {
      expect(tokenize("Hello World")).toEqual(["hello", "world"])
    })

    it("removes stop words", () => {
      const result = tokenize("the quick brown fox is very fast")
      expect(result).not.toContain("the")
      expect(result).not.toContain("is")
      expect(result).not.toContain("very")
      expect(result).toContain("quick")
      expect(result).toContain("brown")
      expect(result).toContain("fox")
      expect(result).toContain("fast")
    })

    it("filters tokens with length <= 2", () => {
      expect(tokenize("go to an ox")).toEqual([])
    })

    it("handles empty string", () => {
      expect(tokenize("")).toEqual([])
    })
  })

  describe("buildIndex", () => {
    it("computes correct document frequencies", () => {
      const index = buildIndex(["deploy staging server", "deploy production server"])
      expect(index.df.get("deploy")).toBe(2)
      expect(index.df.get("staging")).toBe(1)
      expect(index.df.get("production")).toBe(1)
      expect(index.df.get("server")).toBe(2)
    })

    it("computes correct term frequencies", () => {
      const index = buildIndex(["deploy deploy deploy staging"])
      const tf = index.tf.get(0)!
      expect(tf.get("deploy")).toBe(3)
      expect(tf.get("staging")).toBe(1)
    })

    it("computes average document length", () => {
      const index = buildIndex(["one two three", "four five six seven eight"])
      // doc0: 3 tokens (after stop word filter: "one", "two", "three")
      // doc1: 5 tokens ("four", "five", "six", "seven", "eight")
      expect(index.avgDocLen).toBe(4)
    })

    it("handles empty corpus", () => {
      const index = buildIndex([])
      expect(index.docCount).toBe(0)
      expect(index.avgDocLen).toBe(0)
    })
  })

  describe("score", () => {
    it("returns 0 for query with no matching terms", () => {
      const index = buildIndex(["deploy staging server"])
      expect(score("database migration", 0, index)).toBe(0)
    })

    it("returns positive score for matching terms", () => {
      const index = buildIndex(["deploy staging server"])
      expect(score("deploy server", 0, index)).toBeGreaterThan(0)
    })

    it("scores higher for docs with more term occurrences", () => {
      const index = buildIndex([
        "deploy deploy deploy the staging server for deploy",
        "deploy staging once",
      ])
      const s0 = score("deploy", 0, index)
      const s1 = score("deploy", 1, index)
      expect(s0).toBeGreaterThan(s1)
    })

    it("returns 0 for out-of-range docIndex", () => {
      const index = buildIndex(["hello world"])
      expect(score("hello", 5, index)).toBe(0)
    })
  })

  describe("scoreAll", () => {
    it("returns results sorted by score descending", () => {
      const index = buildIndex([
        "marketing strategy for Q2 growth",
        "deploy staging server nginx configuration deploy",
        "database backup procedures weekly",
        "deploy production server with nginx proxy deploy deploy",
      ])
      const results = scoreAll("deploy nginx server", index)
      expect(results.length).toBeGreaterThan(0)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it("excludes zero-score documents", () => {
      const index = buildIndex([
        "deploy staging server",
        "marketing strategy growth",
      ])
      const results = scoreAll("deploy server", index)
      expect(results.every((r) => r.score > 0)).toBe(true)
      expect(results.some((r) => r.docIndex === 1)).toBe(false)
    })

    it("handles empty query", () => {
      const index = buildIndex(["deploy staging server"])
      expect(scoreAll("", index)).toEqual([])
    })

    it("handles single-doc corpus", () => {
      const index = buildIndex(["deploy staging server"])
      const results = scoreAll("deploy", index)
      expect(results.length).toBe(1)
      expect(results[0].docIndex).toBe(0)
    })

    it("rare terms score higher than common terms", () => {
      // "nginx" appears in 1 doc, "server" in all 3 — nginx should contribute more
      const index = buildIndex([
        "nginx server configuration proxy",
        "database server backup restore",
        "application server monitoring logs",
      ])
      const nginxScore = scoreAll("nginx", index)
      const serverScore = scoreAll("server", index)
      // nginx is rarer, so IDF is higher — single match scores more
      expect(nginxScore[0].score).toBeGreaterThan(serverScore[0].score)
    })
  })
})
