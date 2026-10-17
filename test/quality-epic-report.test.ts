import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { qualityReportConfigSchema } from "../src/daemon/config"
import {
  baselineFile, fenced, gateState, isoWeek, parseVerdict, postWeekly, publicProblem, readBaseline, readQualityState,
  reportCommandLine, reportFile, verdictComment, weekMarker, weekRange, weeklyDue, weeksBetween, writeQualityState,
  type IssueComments, type QualityReportSettings,
} from "../src/quality/epic-report"

// The weekly report on the epic (#994). What must hold:
//   - one comment per week: a re-run edits it, never adds a second
//   - it is due from Monday's time on and stays due until posted
//   - a failure is logged and retried; a missed week is named, never silent
//   - no cost amounts and no names reach the public issue
//   - the comment says which gates were on, and from when
//   - the verdict needs every gate and cites the numbers

// Monday 2026-10-19 09:00 UTC; last week is 2026-W42 (12–18 Oct).
const MONDAY_9 = Date.parse("2026-10-19T09:00:00Z")

function settings(over: Partial<QualityReportSettings> = {}): QualityReportSettings {
  const base = qualityReportConfigSchema.parse({})
  return { ...base, enabled: true, repo: "acme/widgets", issue: 1, timezone: "UTC", ...over }
}

function fakeGitHub() {
  const comments: { id: number; body: string }[] = []
  let next = 100
  const gh: IssueComments = {
    find: async (marker) => {
      const c = comments.find((x) => x.body.includes(marker))
      return c ? { id: c.id, url: `u/${c.id}` } : undefined
    },
    create: async (body) => { const id = next++; comments.push({ id, body }); return { id, url: `u/${id}` } },
    update: async (id, body) => {
      const c = comments.find((x) => x.id === id)
      if (!c) throw new Error("404")
      c.body = body
      return { id, url: `u/${id}` }
    },
  }
  return { gh, comments }
}

const REPORT = "| Metric | Baseline | This week | Change |\n|---|---|---|---|\n| Fix share | 37% | 30% | -7 pts |\n| Cost per merged PR | | | +8% |"

describe("weeks", () => {
  it("numbers ISO weeks across a year end", () => {
    expect(isoWeek("2026-10-19")).toBe("2026-W43")
    expect(isoWeek("2026-10-18")).toBe("2026-W42")
    expect(isoWeek("2027-01-01")).toBe("2026-W53")
    expect(weekRange("2026-W42")).toEqual({ from: "2026-10-12", to: "2026-10-18" })
    expect(weeksBetween("2026-W40", "2026-W43")).toEqual(["2026-W41", "2026-W42"])
  })

  it("is due from Monday's time, stays due all week, and once posted is done", () => {
    const s = settings({ time: "08:00" })
    expect(weeklyDue(s, {}, Date.parse("2026-10-19T07:59:00Z")).due).toBe(false)
    expect(weeklyDue(s, {}, MONDAY_9)).toMatchObject({ due: true, week: "2026-W42" })
    expect(weeklyDue(s, {}, Date.parse("2026-10-22T03:00:00Z")).due).toBe(true)
    expect(weeklyDue(s, { lastPosted: "2026-W42" }, MONDAY_9).due).toBe(false)
  })

  it("names the weeks that were never posted", () => {
    expect(weeklyDue(settings(), { lastPosted: "2026-W39" }, MONDAY_9).skipped).toEqual(["2026-W40", "2026-W41"])
  })
})

describe("the report command", () => {
  const proc = { execPath: "/opt/node/bin/node", argv: ["/opt/node/bin/node", "/srv/agentx/dist/cli.js"] }

  it("adds the week and the baseline, and runs this install's CLI", () => {
    expect(reportCommandLine(["agentx", "quality", "report", "--public"], "2026-W42", "baseline", proc)).toEqual([
      "/opt/node/bin/node", "/srv/agentx/dist/cli.js", "quality", "report", "--public",
      "--since", "2026-10-12", "--until", "2026-10-18", "--compare", "baseline",
    ])
  })

  it("leaves another command and a bare agentx binary as they are", () => {
    expect(reportCommandLine(["./report.sh"], "2026-W42", undefined, proc)).toEqual(["./report.sh", "--since", "2026-10-12", "--until", "2026-10-18"])
    expect(reportCommandLine(["agentx", "quality", "report"], "2026-W42", undefined, { execPath: "/x/node", argv: ["/x/node", "/usr/bin/agentx"] })[0]).toBe("agentx")
  })

  it("fences the fixed-width table, even when it holds backticks", () => {
    expect(fenced("  a  b\n  1  2\n")).toBe("```text\n  a  b\n  1  2\n```")
    expect(fenced("x ``` y")).toBe("````text\nx ``` y\n````")
  })
})

describe("gates", () => {
  it("says how each gate stood that week", () => {
    expect(gateState({ id: "a", since: "2026-10-01" }, "2026-W42")).toBe("on (since 2026-10-01)")
    expect(gateState({ id: "a", since: "2026-10-14" }, "2026-W42")).toBe("on from 2026-10-14")
    expect(gateState({ id: "a", since: "2026-10-20" }, "2026-W42")).toBe("off")
    expect(gateState({ id: "a", since: "2026-10-01", until: "2026-10-15" }, "2026-W42")).toBe("on 2026-10-01, off 2026-10-15")
  })
})

describe("public check", () => {
  it("refuses cost amounts, emails and handles; allows percentages", () => {
    expect(publicProblem("cost +8%")).toBeUndefined()
    expect(publicProblem("see `@/daemon/index.ts`")).toBeUndefined()
    expect(publicProblem("cost $12.40")).toMatch(/cost amount/)
    expect(publicProblem("12 USD")).toMatch(/cost amount/)
    expect(publicProblem("thanks @someone")).toMatch(/name/)
    expect(publicProblem("mail a@b.co")).toMatch(/email/)
  })
})

describe("postWeekly", () => {
  let root: string
  const logs: string[] = []
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "quality-")); logs.length = 0 })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const deps = (gh: IssueComments, over: Partial<Parameters<typeof postWeekly>[0]> = {}) => ({
    root, settings: settings({ gates: [{ id: "review", label: "Pre-merge review", since: "2026-10-14" }] }),
    comments: gh, runReport: async () => REPORT, log: (m: string) => logs.push(m), now: MONDAY_9, ...over,
  })

  it("posts once, with the gates and the numbers, and stores the report", async () => {
    const { gh, comments } = fakeGitHub()
    expect(await postWeekly(deps(gh))).toMatchObject({ status: "posted", week: "2026-W42" })
    expect(await postWeekly(deps(gh))).toMatchObject({ status: "not-due" })
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain(weekMarker("2026-W42"))
    expect(comments[0].body).toContain("| Pre-merge review | on from 2026-10-14 |")
    expect(comments[0].body).toContain("+8%")
    expect(comments[0].body).toContain("```text\n| Metric |")
    expect(readFileSync(reportFile(root, "2026-W42"), "utf-8")).toContain("Fix share")
  })

  it("edits the week's comment on a re-run, even with the local state lost", async () => {
    const { gh, comments } = fakeGitHub()
    await postWeekly(deps(gh), { week: "2026-W42" })
    rmSync(join(root, ".agentx"), { recursive: true, force: true })
    expect(await postWeekly(deps(gh), { week: "2026-W42" })).toMatchObject({ status: "updated" })
    expect(comments).toHaveLength(1)
  })

  it("logs a failure, retries after an hour, and posts nothing with a cost amount", async () => {
    const { gh, comments } = fakeGitHub()
    const res = await postWeekly(deps(gh, { runReport: async () => "Cost: $41.20" }))
    expect(res).toMatchObject({ status: "failed" })
    expect(logs.join("\n")).toMatch(/2026-W42 FAILED.*cost amount/)
    expect(comments).toHaveLength(0)
    expect(readQualityState(root).failure?.week).toBe("2026-W42")
    expect(await postWeekly(deps(gh, { now: MONDAY_9 + 10 * 60_000 }))).toMatchObject({ status: "not-due" })
    expect(await postWeekly(deps(gh, { now: MONDAY_9 + 61 * 60_000 }))).toMatchObject({ status: "posted" })
    expect(readQualityState(root).failure).toBeUndefined()
  })

  it("names missed weeks in the comment and the log", async () => {
    const { gh, comments } = fakeGitHub()
    writeQualityState(root, { lastPosted: "2026-W40" })
    await postWeekly(deps(gh))
    expect(comments[0].body).toContain("No report was posted for 2026-W41")
    expect(logs.join("\n")).toMatch(/WARNING.*2026-W41/)
  })

  it("names a week that failed all week as failed, not as missed", async () => {
    const { gh, comments } = fakeGitHub()
    writeQualityState(root, { lastPosted: "2026-W40" })
    const s = settings({ gates: [] })
    await postWeekly(deps(gh, { settings: s, runReport: async () => { throw new Error("gh: not logged in") }, now: Date.parse("2026-10-12T09:00:00Z") }))
    expect(readQualityState(root).failed?.["2026-W41"]).toBeTruthy()
    await postWeekly(deps(gh, { settings: s }))
    expect(comments[0].body).toContain("No report was posted for 2026-W41: every try failed")
    expect(comments[0].body).not.toContain("daemon was not running")
    expect(logs.join("\n")).toMatch(/WARNING.*2026-W41 \(every try failed\)/)
  })

  it("flags the verdict as due after week 3", async () => {
    const { gh, comments } = fakeGitHub()
    const s = settings({ gates: [{ id: "review", since: "2026-09-21" }] })
    await postWeekly(deps(gh, { settings: s }))
    expect(comments[0].body).toContain("agentx quality verdict")
  })
})

describe("verdict", () => {
  const gates = [{ id: "review", since: "2026-09-21" }, { id: "ui", label: "UI evidence", since: "2026-09-24" }]

  it("parses the owner's call", () => {
    expect(parseVerdict("review=keep:fixes down")).toEqual({ gate: "review", verdict: "keep", reason: "fixes down" })
    expect(parseVerdict("ui=off")).toEqual({ gate: "ui", verdict: "switch-off" })
    expect(() => parseVerdict("ui=maybe")).toThrow()
  })

  const baseline = { name: "baseline", since: "2026-10-09", until: "2026-10-16", agent: 0.48, all: 0.4615 }

  it("needs every gate and cites the numbers", () => {
    const report = { week: "2026-W42", text: REPORT }
    expect(() => verdictComment({ verdicts: [parseVerdict("review=keep")], gates, report, baseline })).toThrow(/no verdict for: ui/)
    const body = verdictComment({ verdicts: [parseVerdict("review=keep"), parseVerdict("ui=tune:slow")], gates, report, baseline })
    expect(body).toContain("| UI evidence | 2026-09-24 | **tune** | slow |")
    expect(body).toContain("Fix share")
    expect(body).toContain("2026-10-09 to 2026-10-16 baseline (48% agent PRs, 46% all non-release PRs)")
  })

  it("reads the baseline's fix share from the saved report", () => {
    const root = mkdtempSync(join(tmpdir(), "quality-"))
    try {
      expect(readBaseline(root, "baseline")).toBeUndefined()
      mkdirSync(join(root, ".agentx/quality/baselines"), { recursive: true })
      writeFileSync(baselineFile(root, "baseline"), JSON.stringify({
        since: "2026-10-09", until: "2026-10-16", totals: { agent: { fixShare: 0.4792 }, all: { fixShare: 0.4615 } },
      }))
      expect(readBaseline(root, "baseline")).toEqual({ ...baseline, agent: 0.4792 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
