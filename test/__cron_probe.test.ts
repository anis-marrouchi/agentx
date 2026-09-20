import { describe, it } from "vitest"
import { getNextCronDate } from "../src/crons/scheduler"

describe("probe", () => {
  it("monthly schedule around its own slot", () => {
    const tz = "Africa/Tunis"
    const expr = "0 9 20 * *"
    // Tunis is UTC+1. 09:00 Tunis on the 20th = 08:00Z.
    for (const iso of [
      "2026-09-20T07:59:59.500Z",
      "2026-09-20T08:00:00.000Z",
      "2026-09-20T08:00:15.000Z",
      "2026-09-20T08:00:45.000Z",
      "2026-09-20T08:01:00.000Z",
      "2026-09-20T09:30:00.000Z",
    ]) {
      const after = new Date(iso)
      const next = getNextCronDate(expr, after, tz)
      const deltaMin = (next.getTime() - after.getTime()) / 60000
      console.log(`  after=${iso}  ->  next=${next.toISOString()}  (+${deltaMin.toFixed(1)} min)${deltaMin <= 0 ? "   <-- NOT IN FUTURE" : ""}`)
    }
  })
})
