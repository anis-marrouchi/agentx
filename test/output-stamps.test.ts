import { describe, expect, it } from "vitest"
import { outStamp, outStampAt, outStampTrim, type OutStamp } from "../src/agents/output-stamps"

// #2306: the Task page shows when each step happened. The run's output
// buffer keeps, for each chunk that starts a line, its offset and time.

/** Feed chunks in as the registry does, one per tick. */
function feed(chunks: Array<[string, number]>): { buf: string; stamps: OutStamp[] } {
  let buf = ""
  const stamps: OutStamp[] = []
  for (const [c, at] of chunks) { outStamp(stamps, buf, c, at); buf += c }
  return { buf, stamps }
}

describe("outStamp", () => {
  it("stamps each chunk that starts a line, not the rest of a line", () => {
    const { buf, stamps } = feed([["→ Read({})\n", 100], ["Here is", 200], [" the answer\n", 300], ["← ok\n", 400]])
    expect(stamps).toEqual([[0, 100], [11, 200], [buf.indexOf("← ok"), 400]])
  })
  it("stamps a line that starts inside a chunk, once", () => {
    const { buf, stamps } = feed([["writing", 100], [" more\n→ Bash({})\n← done\n", 200]])
    expect(stamps).toEqual([[0, 100], [buf.indexOf("→ Bash"), 200]])
  })
  it("does not stamp a chunk that only ends the line", () => {
    const { stamps } = feed([["a", 100], ["b\n", 200]])
    expect(stamps).toEqual([[0, 100]])
  })
})

describe("outStampTrim", () => {
  it("moves the stamp in force at the cut to offset 0", () => {
    expect(outStampTrim([[0, 100], [10, 200], [30, 300]], 15)).toEqual([[0, 200], [15, 300]])
  })
  it("keeps a stamp that lands right on the cut", () => {
    expect(outStampTrim([[0, 100], [10, 200]], 10)).toEqual([[0, 200]])
  })
  it("is empty when nothing was stamped", () => {
    expect(outStampTrim([], 10)).toEqual([])
  })
})

describe("outStampAt", () => {
  const stamps: OutStamp[] = [[0, 100], [10, 200], [30, 300]]
  it("gives the time of the latest stamp at or before the offset", () => {
    expect(outStampAt(stamps, 0)).toBe(100)
    expect(outStampAt(stamps, 9)).toBe(100)
    expect(outStampAt(stamps, 10)).toBe(200)
    expect(outStampAt(stamps, 99)).toBe(300)
  })
  it("gives 0 when no stamp covers it", () => {
    expect(outStampAt([], 5)).toBe(0)
    expect(outStampAt(null, 5)).toBe(0)
    expect(outStampAt([[10, 200]], 5)).toBe(0)
  })
})
