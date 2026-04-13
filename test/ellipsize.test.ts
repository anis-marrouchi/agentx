import { describe, it, expect } from "vitest"
import { ellipsize, firstLines } from "../src/utils/ellipsize"

describe("ellipsize", () => {
  it("returns input unchanged when under the budget", () => {
    expect(ellipsize("short", 20)).toBe("short")
  })

  it("prefers line boundary over word boundary", () => {
    const input = "line one\nline two continues here with more words"
    // budget 20 → ellipsis "…" leaves 19. "line one\n" is 9 chars.
    // The last \n before char 19 is at index 8, which is < 60% of 19 (11.4).
    // So it falls through to word boundary.
    // last space before 19 in "line one\nline two c" is at index 13 (> 11.4) ✓
    const out = ellipsize(input, 20)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(20)
  })

  it("never cuts mid-word when a word boundary is available", () => {
    const input = "Duration: 328s Pipeline number three six nine failed"
    const out = ellipsize(input, 25)
    const prefix = out.slice(0, -1) // drop the ellipsis
    // The prefix must be a complete substring of the input ending on a
    // word boundary — i.e., the next char in the original is whitespace
    // or end-of-string (never a word char, which would mean mid-word cut).
    expect(input.startsWith(prefix)).toBe(true)
    const nextChar = input[prefix.length]
    expect(nextChar === undefined || /\s/.test(nextChar)).toBe(true)
    expect(out.endsWith("…")).toBe(true)
  })

  it("keeps GitLab pipeline body readable past the first line", () => {
    const body = "[GitLab Pipeline FAILED] Project: mtgl/mtgl-system-v2\nRef: main\nDuration: 328s\nPipeline #369 — test:php failed"
    const out = ellipsize(body, 120)
    // Should preserve complete lines + ellipsis on its own line
    expect(out).toContain("Duration: 328s")
    expect(out).not.toMatch(/P…$/) // not the "P" orphan we saw in prod
  })

  it("does not append ellipsis when text is already within budget", () => {
    const exact = "12345"
    expect(ellipsize(exact, 5)).toBe("12345")
  })
})

describe("firstLines", () => {
  it("takes only the requested line count", () => {
    const input = "a\nb\nc\nd\ne\nf"
    expect(firstLines(input, 3, 100)).toBe("a\nb\nc")
  })

  it("ellipsizes when over char budget", () => {
    const long = "the quick brown fox\njumps over the lazy dog\neats all the kibble"
    const out = firstLines(long, 5, 25)
    expect(out.length).toBeLessThanOrEqual(25)
    expect(out.endsWith("…")).toBe(true)
  })

  it("handles empty input", () => {
    expect(firstLines("", 3, 100)).toBe("")
  })
})
