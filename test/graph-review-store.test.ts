import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { beforeEach, describe, expect, it } from "vitest"
import { ReviewStore, buildQueue, labelStats } from "../src/graph/review-store"
import type { ClassificationRow, Review } from "../src/graph/review-store"

let dir: string
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "graphrev-")) })

const row = (msgHash: string, confidence?: number): ClassificationRow =>
  ({ msgHash, path: ["a", "b"], confidence, status: "approved" })

describe("ReviewStore", () => {
  it("starts empty and writes nothing until a verdict is recorded", () => {
    const s = new ReviewStore(dir)
    expect(s.load().size).toBe(0)
  })

  it("round-trips a verdict", () => {
    const s = new ReviewStore(dir)
    s.record({ msgHash: "h1", verdict: "wrong", correctPath: ["x", "y"], reviewer: "me" })
    const got = s.load().get("h1")!
    expect(got.verdict).toBe("wrong")
    expect(got.correctPath).toEqual(["x", "y"])
    expect(got.ts).toBeTruthy()
  })

  it("keeps the latest verdict when a reviewer changes their mind", () => {
    const s = new ReviewStore(dir)
    s.record({ msgHash: "h1", verdict: "correct", reviewer: "me" })
    s.record({ msgHash: "h1", verdict: "wrong", reviewer: "me" })
    expect(s.load().get("h1")!.verdict).toBe("wrong")
    expect(s.load().size).toBe(1)
  })

  it("skips corrupt lines rather than losing the whole log", () => {
    const s = new ReviewStore(dir)
    s.record({ msgHash: "h1", verdict: "correct", reviewer: "me" })
    writeFileSync(s.path, `${"{ not json"}\n${JSON.stringify({ msgHash: "h2", verdict: "wrong", reviewer: "m", ts: "t" })}\n`)
    expect([...s.load().keys()]).toEqual(["h2"])
  })

  it("is a separate log from classifications.jsonl", () => {
    // approveClassification() appends a copy of the row with the status
    // flipped, so writing a human verdict there would be
    // indistinguishable from the classifier's own auto-approve — the
    // conflation that left 8,871 rows looking like ground truth.
    expect(new ReviewStore(dir).path).toMatch(/reviews\.jsonl$/)
  })
})

describe("buildQueue", () => {
  const rows = [
    row("a", 0.05), row("b", 0.15), row("c", 0.35), row("d", 0.55),
    row("e", 0.85), row("f", 0.95), row("g", 0.92), row("h"),
  ]

  it("uncertain mode puts the least confident first", () => {
    const q = buildQueue(rows, new Set(), { n: 3, strategy: "uncertain" })
    expect(q.map((r) => r.msgHash)).toEqual(["a", "b", "c"])
  })

  it("uncertain mode sorts cache hits last — no number to be unsure about", () => {
    const q = buildQueue(rows, new Set(), { n: 8, strategy: "uncertain" })
    expect(q[q.length - 1].msgHash).toBe("h")
  })

  it("stratified mode spreads across the confidence range", () => {
    // Labelling only the bottom leaves the top bins empty, and the top
    // bins are where an overconfident model does its damage.
    const q = buildQueue(rows, new Set(), { n: 4, strategy: "stratified" })
    const bins = new Set(q.filter((r) => r.confidence != null).map((r) => Math.floor(r.confidence! * 10)))
    expect(bins.size).toBeGreaterThan(2)
  })

  it("defaults to stratified, because calibration is the point", () => {
    const q = buildQueue(rows, new Set(), { n: 4 })
    const low = q.filter((r) => (r.confidence ?? 0) < 0.5).length
    expect(low).toBeLessThan(4)
  })

  it("never re-offers something already reviewed", () => {
    const q = buildQueue(rows, new Set(["a", "b", "c"]), { n: 10 })
    expect(q.map((r) => r.msgHash)).not.toEqual(expect.arrayContaining(["a", "b", "c"]))
  })

  it("collapses the append-only log to one row per message", () => {
    // The log re-records a row on every status change.
    const dupes = [row("a", 0.1), row("a", 0.2), row("a", 0.3)]
    expect(buildQueue(dupes, new Set(), { n: 10 })).toHaveLength(1)
  })

  it("returns nothing when everything is reviewed", () => {
    expect(buildQueue(rows, new Set(rows.map((r) => r.msgHash)), { n: 10 })).toEqual([])
  })

  it("still offers cache hits once the scored rows run out", () => {
    const q = buildQueue([row("h")], new Set(), { n: 5 })
    expect(q.map((r) => r.msgHash)).toEqual(["h"])
  })
})

describe("labelStats", () => {
  const rows = [row("a", 0.95), row("b", 0.95), row("c", 0.15), row("d")]
  const reviews = (...rs: Array<[string, Review["verdict"]]>) =>
    new Map(rs.map(([h, v]) => [h, { msgHash: h, verdict: v, reviewer: "m", ts: "t" } as Review]))

  it("counts verdicts and excludes `unsure` from accuracy", () => {
    // An unsure verdict is not half a correct one; counting it either
    // way invents a judgement the reviewer declined to make.
    const st = labelStats(rows, reviews(["a", "correct"], ["b", "wrong"], ["c", "unsure"]))
    expect(st.reviewed).toBe(3)
    expect(st.accuracy).toBe(0.5)
    expect(st.unsure).toBe(1)
  })

  it("bins by confidence so overconfidence is visible", () => {
    const st = labelStats(rows, reviews(["a", "correct"], ["b", "wrong"]))
    const top = st.byBin.find((b) => b.bin === "0.9-1.0")!
    expect(top.n).toBe(2)
    expect(top.accuracy).toBe(0.5) // claimed 0.95, right half the time
  })

  it("counts only confidence-carrying rows as calibratable", () => {
    const st = labelStats(rows, reviews(["a", "correct"], ["d", "correct"]))
    expect(st.reviewed).toBe(2)
    expect(st.calibratable).toBe(1)
  })

  it("ignores a review whose classification is gone", () => {
    expect(labelStats(rows, reviews(["zz", "correct"])).reviewed).toBe(0)
  })

  it("reports zero accuracy rather than NaN with no decided verdicts", () => {
    const st = labelStats(rows, reviews(["c", "unsure"]))
    expect(st.accuracy).toBe(0)
  })
})
