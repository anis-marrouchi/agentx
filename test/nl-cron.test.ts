import { describe, it, expect } from "vitest"
import { parseEnglishToCron, slugifyScheduleId } from "../src/utils/nl-cron"

describe("parseEnglishToCron", () => {
  const cases: Array<[string, string]> = [
    ["every morning at 9",         "0 9 * * *"],
    ["every morning",              "0 9 * * *"],   // default 9am
    ["every evening at 6pm",       "0 18 * * *"],
    ["every evening",              "0 18 * * *"],  // default 6pm
    ["every night",                "0 22 * * *"],
    ["daily at 9:30am",            "30 9 * * *"],
    ["every day at 14:30",         "30 14 * * *"],
    ["at 9am",                     "0 9 * * *"],
    ["at 9:30 pm",                 "30 21 * * *"],
    ["at noon",                    "0 12 * * *"],
    ["at midnight",                "0 0 * * *"],
    ["weekdays at 6pm",            "0 18 * * 1-5"],
    ["weekends at 10am",           "0 10 * * 0,6"],
    ["every monday at 10am",       "0 10 * * 1"],
    ["every tuesday and friday at 3pm", "0 15 * * 2,5"],
    ["every 15 minutes",           "*/15 * * * *"],
    ["every 5 mins",               "*/5 * * * *"],
    ["every minute",               "* * * * *"],
    ["every hour",                 "0 * * * *"],
    ["hourly",                     "0 * * * *"],
    ["every 2 hours",              "0 */2 * * *"],
    ["1st of every month at 9am",  "0 9 1 * *"],
    ["15th of every month at noon","0 12 15 * *"],
  ]

  for (const [input, expectedCron] of cases) {
    it(`parses "${input}" → ${expectedCron}`, () => {
      const r = parseEnglishToCron(input)
      expect(r).not.toBeNull()
      expect(r!.cron).toBe(expectedCron)
      expect(r!.human).toBeTruthy()
    })
  }

  it("returns null for unknown phrasings", () => {
    expect(parseEnglishToCron("when the sun aligns with Mars")).toBeNull()
    expect(parseEnglishToCron("")).toBeNull()
    // "25:00" is a valid number but out of range
    expect(parseEnglishToCron("at 25:00")).toBeNull()
  })

  it("accepts both am/pm and 24-hour", () => {
    expect(parseEnglishToCron("at 2pm")?.cron).toBe("0 14 * * *")
    expect(parseEnglishToCron("at 14:00")?.cron).toBe("0 14 * * *")
    expect(parseEnglishToCron("at 12am")?.cron).toBe("0 0 * * *")
    expect(parseEnglishToCron("at 12pm")?.cron).toBe("0 12 * * *")
  })
})

describe("slugifyScheduleId", () => {
  it("produces stable slugs", () => {
    expect(slugifyScheduleId("every morning at 9", "devops")).toBe("every-morning-at-9-devops")
    expect(slugifyScheduleId("weekdays", "pm")).toBe("weekdays-pm")
    expect(slugifyScheduleId("", "foo")).toBe("job-foo")
  })

  it("truncates overly long phrases", () => {
    const id = slugifyScheduleId("a".repeat(200), "bob")
    expect(id.length).toBeLessThanOrEqual(50)
    expect(id.endsWith("-bob")).toBe(true)
  })
})
