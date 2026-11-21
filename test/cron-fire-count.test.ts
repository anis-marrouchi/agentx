import { describe, it, expect } from "vitest"
import { countFires, firesMoreOften, parseCron } from "../src/crons/fire-count"

// #863 v2.1 B5 + v2.2 suggestion: "more often" = more fires in the next
// 31 days than the approved schedule, both counted from the same start, in
// the job's own timezone.

const DAY = 86_400_000

describe("countFires", () => {
  it("counts a daily job over 31 days", () => {
    expect(countFires("0 9 * * *", "UTC", Date.parse("2026-11-01T00:00:00Z"))).toBe(31)
  })

  it("counts every 15 minutes, and stops past the cap", () => {
    expect(countFires("*/15 * * * *", "UTC", Date.parse("2026-11-01T00:00:00Z"), 1)).toBe(96)
    expect(countFires("* * * * *", "UTC", Date.parse("2026-11-01T00:00:00Z"), 31, 10)).toBe(11)
  })

  it("reads the day in the job's timezone", () => {
    // 23:30 UTC on Sunday is 00:30 Monday in Tunis (UTC+1).
    const start = Date.parse("2026-11-01T00:00:00Z")
    expect(countFires("30 0 * * 1", "Africa/Tunis", start, 7)).toBe(1)
    const tunisMonday = countFires("30 0 * * 1", "Africa/Tunis", start, 1)
    const utcMonday = countFires("30 0 * * 1", "UTC", start, 1)
    // 2026-11-01 is a Sunday: 00:30 Tunis Monday = 23:30Z Sunday, inside day one.
    expect([tunisMonday, utcMonday]).toEqual([1, 0])
  })

  it("a day-of-month plus day-of-week cron fires on either (0 9 1 * 1)", () => {
    // December 2026: the 1st is a Tuesday; Mondays are 7, 14, 21, 28.
    const start = Date.parse("2026-11-30T12:00:00Z")
    expect(countFires("0 9 1 * 1", "UTC", start, 31)).toBe(5)
    expect(countFires("0 9 1 * *", "UTC", start, 31)).toBe(1)
    expect(countFires("0 9 * * 1", "UTC", start, 31)).toBe(4)
  })

  it("takes 7 as Sunday and refuses a bad field", () => {
    expect(parseCron("0 9 * * 7").dows.has(0)).toBe(true)
    expect(() => parseCron("0 25 * * *")).toThrow(/out of range/)
    expect(() => parseCron("0 9 * *")).toThrow(/five fields/)
  })
})

describe("firesMoreOften", () => {
  it("monthly to weekly asks approval, on any start date", () => {
    const base = Date.parse("2026-11-01T00:00:00Z")
    for (let d = 0; d < 62; d++) {
      const r = firesMoreOften("0 9 * * 1", "0 9 1 * *", "Africa/Tunis", base + d * DAY + 3_600_000 * (d % 24))
      expect(r.more, `start day ${d}`).toBe(true)
      expect(r.approved).toBeLessThanOrEqual(2)
    }
  })

  it("the same or less often goes through", () => {
    const start = Date.parse("2026-11-28T00:00:00Z")
    expect(firesMoreOften("0 9 * * 1", "0 9 * * *", "UTC", start).more).toBe(false)
    expect(firesMoreOften("30 10 * * *", "0 9 * * *", "UTC", start).more).toBe(false)
    expect(firesMoreOften("0 9,18 * * *", "0 9 * * *", "UTC", start).more).toBe(true)
  })
})
