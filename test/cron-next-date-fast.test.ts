import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getNextCronDate } from "../src/crons/scheduler"
import { listInbox } from "../src/approvals/inbox"

// #2075: getNextCronDate walked minute by minute, ~525,000 steps for a
// dated cron whose day had passed, and GET /approvals blocked on it.

/** The old minute-by-minute search, kept as the reference answer. */
function slowNext(expression: string, after: Date, timezone: string): Date | null {
  const [mi, ho, dm, mo, dw] = expression.split(" ").map((f, i) => {
    const [lo, hi] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]][i]
    const out = new Set<number>()
    for (const part of f.split(",")) {
      if (part === "*") for (let v = lo; v <= hi; v++) out.add(v)
      else if (part.includes("/")) {
        const [r, s] = part.split("/")
        for (let v = r === "*" ? lo : Number(r); v <= hi; v += Number(s)) out.add(v)
      } else if (part.includes("-")) {
        const [a, b] = part.split("-").map(Number)
        for (let v = a; v <= b; v++) out.add(v)
      } else out.add(Number(part))
    }
    return out
  })
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
  let t = Math.floor((after.getTime() + 60_000) / 60_000) * 60_000
  // 3 days: enough for every expression below except the month-bound
  // ones, which are skipped where they do not match soon.
  const limit = t + 3 * 24 * 60 * 60_000
  for (; t < limit; t += 60_000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]))
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
    if (mi.has(p.minute) && ho.has(p.hour % 24) && dm.has(p.day) && mo.has(p.month) && dw.has(dow)) return new Date(t)
  }
  return null
}

describe("getNextCronDate (#2075)", () => {
  it("finds a passed dated cron's slot next year in under 200 ms", () => {
    const t0 = performance.now()
    const next = getNextCronDate("0 14 21 11 *", new Date("2026-11-22T09:00:00Z"), "UTC")
    const ms = performance.now() - t0
    expect(next.toISOString()).toBe("2027-11-21T14:00:00.000Z")
    // The old minute-by-minute walk took ~1.5 s; 200 ms leaves room for a busy CI runner.
    expect(ms).toBeLessThan(200)
  })

  it("matches the minute-by-minute answer across zones, DST changes and field kinds", () => {
    const expressions = [
      "* * * * *", "*/15 * * * *", "0 * * * *", "30 2 * * *", "0 0 * * *", "59 23 * * *",
      "0 9 * * 1-5", "0 9 * * 0", "15 10 1,15 * *", "0 3 * * 6", "45 1 * * *",
      "0 2 * 3 *", "0 2 * 10,11 *", "*/7 4-6 * * 2", "0 12 31 * *", "0 0 1 * *", "30 1 * 11 *",
    ]
    const zones = ["UTC", "Africa/Tunis", "Europe/Paris", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu"]
    // Around the 2026 DST changes (EU 29 Mar / 25 Oct, US 8 Mar / 1 Nov,
    // Lord Howe 5 Apr / 4 Oct) and an ordinary day.
    const starts = [
      "2026-03-07T22:10:00Z", "2026-03-28T23:30:00Z", "2026-04-04T14:20:00Z",
      "2026-10-03T15:40:00Z", "2026-10-24T23:59:30Z", "2026-10-31T21:05:00Z", "2026-06-15T12:00:00Z",
    ]
    for (const expr of expressions) {
      for (const tz of zones) {
        for (const iso of starts) {
          const after = new Date(iso)
          const want = slowNext(expr, after, tz)
          if (!want) continue
          expect(getNextCronDate(expr, after, tz).toISOString(), `${expr} ${tz} ${iso}`).toBe(want.toISOString())
        }
      }
    }
  })

  it("reads the weekday in the job's zone, not the host's", () => {
    // Monday 22:00 in New York is Tuesday 03:00Z.
    const next = getNextCronDate("0 22 * * 1", new Date("2026-11-22T12:00:00Z"), "America/New_York")
    expect(next.toISOString()).toBe("2026-11-24T03:00:00.000Z")
  })
})

describe("Desk schedule cards (#2075)", () => {
  let root = ""
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  function withCrons(crons: Record<string, unknown>): string {
    root = mkdtempSync(join(tmpdir(), "agentx-2075-"))
    writeFileSync(join(root, "agentx.json"), JSON.stringify({ crons }))
    return root
  }
  const pending = { action: "create", requestedBy: "coder-agent", requestedAt: "2026-11-21T10:00:00Z" }
  const now = Date.parse("2026-11-22T09:00:00Z")

  it("lists 3 passed dated schedules in under 200 ms", () => {
    withCrons(Object.fromEntries(["0 14 21 11 *", "0 18 21 11 *", "0 20 21 11 *"].map((s, i) => [
      `old-${i}`, { agent: "coder-agent", schedule: s, timezone: "UTC", prompt: "check", approval: pending },
    ])))
    const t0 = performance.now()
    const { items } = listInbox({ root, now }, { kinds: ["schedule"] })
    expect(performance.now() - t0).toBeLessThan(200)
    expect(items).toHaveLength(3)
    expect(items[0].detail).toContain("first run")
  })

  it("says a one-time schedule's time has passed instead of a run next year", () => {
    withCrons({
      late: { agent: "coder-agent", schedule: "0 14 21 11 *", runAt: "2026-11-21T14:00:00.000Z", timezone: "UTC", prompt: "x".repeat(400), approval: pending },
      soon: { agent: "coder-agent", schedule: "0 18 23 11 *", runAt: "2026-11-23T18:00:00.000Z", timezone: "UTC", prompt: "check", approval: pending },
    })
    const { items } = listInbox({ root, now }, { kinds: ["schedule"] })
    const late = items.find((i) => i.key === "schedule:late")!
    const soon = items.find((i) => i.key === "schedule:soon")!
    expect(late.detail).toMatch(/^Its time has passed \(.*21 Nov 2026.*\); enabling it runs it now, late/)
    expect(late.detail).not.toContain("2027")
    expect(soon.detail).toMatch(/first run .*23 Nov 2026/)
  })
})
