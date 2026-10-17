import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import {
  addsTest, areaOf, citedNumbers, isAgentPr, isExternalPr, isFix, isReleasePr, isTestFile, leadTimeOf, mentionsReview,
  percentile, regressionOf, touchesUi, weekOf,
  type PrRecord,
} from "../src/quality/classify"
import { buildReport, compareReports, renderMarkdown, renderReport, toPublic, QUALITY_REPORT_SCHEMA } from "../src/quality/report"
import { BUILD_CALL_RE, matchCosts, mentionsBranch, readTaskCosts, type TaskCost } from "../src/quality/cost"
import { fetchCiMinutes, fetchMergedPrs, weekChunks, type GhRunner } from "../src/quality/github"

function pr(over: Partial<PrRecord> & { number: number }): PrRecord {
  return {
    title: "feat: something",
    body: "",
    createdAt: "2026-01-05T08:00:00Z",
    mergedAt: "2026-01-05T10:00:00Z",
    headRefName: "claude/some-work-abc",
    labels: [],
    files: ["src/daemon/index.ts"],
    closingIssues: [],
    commits: [],
    ...over,
  }
}

describe("release PR exclusion", () => {
  it("knows release-please by title, branch or label", () => {
    expect(isReleasePr(pr({ number: 1, title: "chore(main): release 0.139.2" }))).toBe(true)
    expect(isReleasePr(pr({ number: 2, title: "chore: release 1.0.0" }))).toBe(true)
    expect(isReleasePr(pr({ number: 3, title: "Merge it", headRefName: "release-please--branches--main--components--x" }))).toBe(true)
    expect(isReleasePr(pr({ number: 4, labels: ["autorelease: tagged"] }))).toBe(true)
    expect(isReleasePr(pr({ number: 5, title: "chore(deps): bump vitest" }))).toBe(false)
    expect(isReleasePr(pr({ number: 6, title: "fix(release): tag order" }))).toBe(false)
  })

  it("an agent PR has a claude/ branch or an agent:* label, and is never a release PR", () => {
    expect(isAgentPr(pr({ number: 1 }))).toBe(true)
    expect(isAgentPr(pr({ number: 2, headRefName: "feature/x", labels: ["agent:coder"] }))).toBe(true)
    expect(isAgentPr(pr({ number: 3, headRefName: "feature/x" }))).toBe(false)
    expect(isAgentPr(pr({ number: 4, title: "chore(main): release 1.2.3", labels: ["agent:coder"] }))).toBe(false)
  })
})

describe("fix detection", () => {
  it.each([
    ["fix: crash on start", true],
    ["fix(daemon): crash on start", true],
    ["fix(api)!: drop a field", true],
    ["Fix(ui): case does not matter", true],
    ["feat(fix): a feature about fixes", false],
    ["test(presence): fix red build", false],
    ["fixup: wording", false],
    ["Revert \"fix: x\"", false],
  ])("%s → %s", (title, expected) => {
    expect(isFix(title)).toBe(expected)
  })
})

describe("regression citation window", () => {
  const merged = new Map<number, string>([
    [10, "2026-01-05T10:00:00Z"],
    [11, "2026-01-03T09:00:00Z"],
    [12, "2026-01-01T09:00:00Z"],
  ])

  it("collects #N and /pull/N, not its own number or HTML entities", () => {
    const p = pr({ number: 20, title: "fix: x (#20)", body: "Follow-up to #10, see https://github.com/o/r/pull/11 and &#12;" })
    expect(citedNumbers(p).sort()).toEqual([10, 11])
  })

  it("≤24 h counts in both buckets", () => {
    const hit = regressionOf(pr({ number: 20, title: "fix: x", body: "follow-up to #10", mergedAt: "2026-01-06T09:00:00Z" }), merged)
    expect(hit).toEqual({ within24h: true, within72h: true, cited: [10] })
  })

  it("between 24 h and 72 h counts only in the 72 h bucket", () => {
    const hit = regressionOf(pr({ number: 20, title: "fix: x (#11)", mergedAt: "2026-01-05T09:00:00Z" }), merged)
    expect(hit.within24h).toBe(false)
    expect(hit.within72h).toBe(true)
  })

  it("older than 72 h, cited after the fix, an unknown number, or not a fix: no regression", () => {
    expect(regressionOf(pr({ number: 20, title: "fix: x (#12)", mergedAt: "2026-01-05T09:00:01Z" }), merged).within72h).toBe(false)
    expect(regressionOf(pr({ number: 20, title: "fix: x (#10)", mergedAt: "2026-01-05T09:00:00Z" }), merged).within72h).toBe(false)
    expect(regressionOf(pr({ number: 20, title: "fix: x (#999)", mergedAt: "2026-01-05T11:00:00Z" }), merged).within72h).toBe(false)
    expect(regressionOf(pr({ number: 20, title: "feat: x (#10)", mergedAt: "2026-01-05T11:00:00Z" }), merged).within72h).toBe(false)
  })

  it("the closest cited PR decides the 24 h bucket", () => {
    const hit = regressionOf(pr({ number: 20, title: "fix: x", body: "#11 and #10", mergedAt: "2026-01-05T12:00:00Z" }), merged)
    expect(hit.within24h).toBe(true)
    expect(hit.cited.sort()).toEqual([10, 11])
  })
})

describe("area mapping", () => {
  it("picks the src/<dir> with the most changed files", () => {
    expect(areaOf(["src/daemon/a.ts", "src/channels/b.ts", "src/channels/c.ts", "test/x.test.ts"])).toBe("channels")
  })
  it("is `other` when nothing is under src/", () => {
    expect(areaOf(["docs/a.md", "test/b.test.ts", "package.json"])).toBe("other")
    expect(areaOf([])).toBe("other")
  })
  it("files directly in src/ are the `src` area; ties go alphabetically", () => {
    expect(areaOf(["src/program.ts", "src/cli.ts", "src/daemon/a.ts"])).toBe("src")
    expect(areaOf(["src/web/a.ts", "src/agents/b.ts"])).toBe("agents")
  })
})

describe("lead time, weeks and percentiles", () => {
  it("uses the earliest closing issue, else the PR's own opening", () => {
    const withIssue = pr({ number: 1, closingIssues: [{ number: 5, createdAt: "2026-01-04T10:00:00Z" }, { number: 6, createdAt: "2026-01-05T00:00:00Z" }] })
    expect(leadTimeOf(withIssue)).toEqual({ kind: "issue", hours: 24 })
    expect(leadTimeOf(pr({ number: 2 }))).toEqual({ kind: "pr", hours: 2 })
  })
  it("weeks start on Monday, UTC", () => {
    expect(weekOf("2026-01-05T00:00:00Z")).toBe("2026-01-05") // a Monday
    expect(weekOf("2026-01-11T23:59:59Z")).toBe("2026-01-05") // the Sunday after
    expect(weekOf("2026-01-12T00:00:00Z")).toBe("2026-01-12")
  })
  it("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
  })
  it("splits a range into inclusive 7-day chunks", () => {
    expect(weekChunks("2026-01-01", "2026-01-16")).toEqual([
      ["2026-01-01", "2026-01-07"], ["2026-01-08", "2026-01-14"], ["2026-01-15", "2026-01-16"],
    ])
  })
})

// One fixture week: a release PR, three agent PRs (two fixes, one regression),
// one human PR, plus a PR merged before the window that a fix cites.
const fixture: PrRecord[] = [
  pr({ number: 1, title: "feat(wiki): pages", mergedAt: "2026-01-03T12:00:00Z", files: ["src/wiki/a.ts"] }),
  pr({ number: 2, title: "chore(main): release 1.0.0", headRefName: "release-please--branches--main", mergedAt: "2026-01-05T09:00:00Z" }),
  pr({ number: 3, title: "fix(wiki): page lock (#1 follow-up)", mergedAt: "2026-01-05T11:00:00Z", files: ["src/wiki/a.ts"],
    closingIssues: [{ number: 90, createdAt: "2026-01-04T11:00:00Z" }] }),
  pr({ number: 4, title: "feat(daemon): x", mergedAt: "2026-01-06T10:00:00Z", body: "https://claude.ai/code/session_abc123" }),
  pr({ number: 5, title: "fix: y", mergedAt: "2026-01-07T10:00:00Z" }),
  pr({ number: 6, title: "docs: z", headRefName: "someone/docs", mergedAt: "2026-01-08T10:00:00Z", files: ["docs/a.md"] }),
]

describe("fix details", () => {
  it("review mentions, added tests and UI files", () => {
    expect(mentionsReview(pr({ number: 1, title: "fix: address review on #12" }))).toBe(true)
    expect(mentionsReview(pr({ number: 2, body: "Reviewer asked for this." }))).toBe(true)
    expect(mentionsReview(pr({ number: 3, title: "fix: preview pane" }))).toBe(false)
    expect(isTestFile("test/a.test.ts")).toBe(true)
    expect(isTestFile("src/x/a.test.mjs")).toBe(true)
    expect(isTestFile("src/x/__fixtures__/a.json")).toBe(true)
    expect(isTestFile("src/testing.ts") || isTestFile("docs/test.md")).toBe(false)
    expect(addsTest(pr({ number: 4, files: ["test/a.test.ts"] }))).toBe(false) // edited, not added
    expect(addsTest(pr({ number: 5, files: ["test/b.test.ts"], addedFiles: ["test/b.test.ts"] }))).toBe(true)
    expect(addsTest(pr({ number: 6, addedFiles: ["src/a.ts"] }))).toBe(false)
    expect(touchesUi(["src/daemon/ui/assistant.ts"])).toBe(true)
    expect(touchesUi(["src/web/activity-graph/a.ts"])).toBe(true)
    expect(touchesUi(["src/boards/config.ts"])).toBe(true)
    expect(touchesUi(["src/daemon/board-dashboard.ts"])).toBe(true)
    expect(touchesUi(["apps/phone/App.tsx"])).toBe(true)
    expect(touchesUi(["src/daemon/index.ts"])).toBe(false)
  })
})

describe("buildReport", () => {
  const report = buildReport(fixture, { repo: "o/r", since: "2026-01-05", until: "2026-01-11", generatedAt: "2026-01-12T00:00:00Z" },
    { ciMinutes: new Map([[3, 4], [4, 6], [5, 2], [6, 1]]), cost: new Map([[3, 1.5], [5, 0.5]]) })

  it("counts only the window, leaves release PRs out and reports both totals", () => {
    expect(report.schema).toBe(QUALITY_REPORT_SCHEMA)
    expect(report.excluded.releasePrs).toBe(1)
    expect(report.excluded.fixShareWithReleases).toBe(0.4) // 2 fixes / 5 merged
    expect(report.totals.all.mergedPrs).toBe(4)
    expect(report.totals.all.fixes).toBe(2)
    expect(report.totals.all.fixShare).toBe(0.5)
    expect(report.totals.agent.mergedPrs).toBe(3)
    expect(report.totals.agent.fixShare).toBe(0.6667)
  })

  it("a fix may cite a PR merged before the window", () => {
    expect(report.totals.agent.regressionFixes24h).toBe(0)
    expect(report.totals.agent.regressionFixes72h).toBe(1)
  })

  it("regression fixes per 100 merged PRs", () => {
    expect(report.totals.agent.regressionFixes24hPer100).toBe(0)
    expect(report.totals.agent.regressionFixes72hPer100).toBe(33.3) // 1 of 3
    expect(report.totals.all.regressionFixes72hPer100).toBe(25) // 1 of 4
    const empty = buildReport([], { repo: "o/r", since: "2026-01-05", until: "2026-01-11" })
    expect(empty.totals.all.regressionFixes24hPer100).toBeNull()
  })

  it("counts what fixes touched", () => {
    expect(report.totals.agent).toMatchObject({ fixesMentioningReview: 0, fixesAddingTests: 0, fixesTouchingUi: 0 })
    const touched = buildReport([
      pr({ number: 7, title: "fix(ui): review follow-up", files: ["src/daemon/ui/a.ts", "test/a.test.ts"], addedFiles: ["test/a.test.ts"] }),
      pr({ number: 8, title: "fix: z", files: ["test/b.test.ts"] }),
      pr({ number: 9, title: "feat: review queue", files: ["src/web/a.ts", "test/c.test.ts"], addedFiles: ["test/c.test.ts"] }),
    ], { repo: "o/r", since: "2026-01-05", until: "2026-01-11" })
    expect(touched.totals.agent).toMatchObject({ fixesMentioningReview: 1, fixesAddingTests: 1, fixesTouchingUi: 1 })
    expect(renderReport(touched)).toContain("1/1/1")
  })

  it("a cloud-session PR stays external when a local task pushed it; that cost is follow-up", () => {
    // #4 is a cloud-session PR that a local task rebased for $5.
    const r = buildReport(fixture, { repo: "o/r", since: "2026-01-05", until: "2026-01-11" },
      { cost: new Map([[3, 1.5], [4, 5], [5, 0.5]]) })
    expect(r.totals.agent.cost).toMatchObject({
      perMergedPr: 1, total: 2, attributedPrs: 2, externalPrs: 1, attributionRate: 1,
      followUpPrs: 1, followUpTotal: 5, status: "attributed",
    })
    const onlyExternal = buildReport(fixture, { repo: "o/r", since: "2026-01-05", until: "2026-01-11" }, { cost: new Map([[4, 5]]) })
    expect(onlyExternal.totals.agent.cost.attributedPrs).toBe(0)
    expect(onlyExternal.totals.agent.cost.perMergedPr).toBeNull()
    expect(renderReport(r)).toContain("Local follow-up on external PRs (rebases, conflict fixes), not in Cost/PR: agent PRs: $5.00 on 1 PR;")
    const pub = toPublic(r)
    expect(JSON.stringify(pub)).not.toContain("followUpTotal")
    expect(renderReport(pub)).toContain("agent PRs: 1 PR;")
    expect(renderReport(pub)).not.toMatch(/\$\d/)
  })

  it("--format markdown renders GitHub tables", () => {
    const md = renderMarkdown(report)
    expect(md).toContain("### Quality report — o/r (main), 2026-01-05 → 2026-01-11")
    expect(md).toContain("| Total | PRs | Fixes | Fix share | Reg ≤24h (/100) |")
    expect(md).toContain("| --- | ---: |")
    expect(md).toContain("| agent PRs | 3 | 2 | 67% | 0 (0) | 1 (33.3) |")
    expect(md).toContain("| Week of |")
    expect(md).toContain("| Area |")
  })

  it("lead time splits issue-linked and unlinked PRs", () => {
    expect(report.totals.agent.leadTime.issue).toEqual({ n: 1, medianHours: 24, p90Hours: 24 })
    expect(report.totals.agent.leadTime.pr.n).toBe(2)
  })

  it("CI minutes and cost per PR with attribution rate; cloud-session PRs are external", () => {
    expect(report.totals.agent.ciMinutes).toBe(12)
    expect(report.totals.agent.cost).toMatchObject({
      perMergedPr: 1, total: 2, attributedPrs: 2, externalPrs: 1, attributionRate: 1, status: "attributed",
    })
  })

  it("rows by week and by area", () => {
    expect(report.weeks.map((w) => [w.week, w.mergedPrs])).toEqual([["2026-01-05", 3]])
    expect(report.areas.map((a) => [a.area, a.mergedPrs])).toEqual([["daemon", 2], ["wiki", 1]])
  })

  it("no cost match prints unattributed, never 0", () => {
    const bare = buildReport(fixture, { repo: "o/r", since: "2026-01-05", until: "2026-01-11" })
    expect(bare.totals.all.cost.perMergedPr).toBeNull()
    expect(bare.totals.all.cost.status).toBe("unattributed")
    expect(bare.totals.all.ciMinutes).toBeNull()
    const text = renderReport(bare)
    expect(text).toContain("unattributed")
    expect(text).not.toContain("$0.00")
  })

  it("--scope all puts every non-release PR in the rows", () => {
    const all = buildReport(fixture, { repo: "o/r", since: "2026-01-05", until: "2026-01-11", scope: "all" })
    expect(all.areas.map((a) => a.area)).toEqual(["daemon", "other", "wiki"])
  })
})

describe("baselines and --public", () => {
  const opts = { repo: "o/r", since: "2026-01-05", until: "2026-01-11" }
  const then = buildReport(fixture, opts, { cost: new Map([[3, 2], [5, 2]]) })
  const now = buildReport(fixture, opts, { cost: new Map([[3, 1.5], [5, 0.5]]) })

  it("--compare gives deltas and a cost % change", () => {
    const c = compareReports(now, then, "before")
    expect(c.comparison?.baseline).toBe("before")
    expect(c.comparison?.totals.agent.costPerMergedPrPct).toBe(-50)
    expect(c.comparison?.totals.agent.mergedPrs).toBe(0)
    expect(c.totals.agent.cost.changePct).toBe(-50)
  })

  it("a baseline saved before the per-100 fields compares without NaN", () => {
    const old = structuredClone(then)
    for (const r of [old.totals.agent, old.totals.all, ...old.areas] as any[]) {
      delete r.regressionFixes24hPer100
      delete r.regressionFixes72hPer100
    }
    const c = compareReports(now, old, "before")
    expect(c.comparison?.totals.agent.regressionFixes24hPer100).toBeNull()
    expect(renderReport(c)).not.toContain("NaN")
    expect(renderMarkdown(c)).not.toContain("NaN")
  })

  it("--public removes every absolute amount", () => {
    const pub = toPublic(compareReports(now, then, "before"))
    expect(pub.public).toBe(true)
    const json = JSON.stringify(pub)
    expect(json).not.toContain("perMergedPr")
    expect(json).not.toContain("\"total\"")
    const text = renderReport(pub)
    expect(text).not.toMatch(/\$\d/)
    expect(text).toContain("-50%")
  })

  it("--public without a baseline says so", () => {
    expect(renderReport(toPublic(now))).toContain("no baseline")
  })
})

describe("cost attribution", () => {
  const prs = [
    pr({ number: 7, headRefName: "claude/fix-login-a1" }),
    pr({ number: 8, headRefName: "claude/fix-login-a1-more" }),
    pr({ number: 9, headRefName: "main" }),
  ]
  const task = (over: Partial<TaskCost>): TaskCost => ({ buildInputs: [], openedPrs: [], usd: 1, ...over })

  it("charges the task that pushed the branch, not the longer branch next to it", () => {
    const m = matchCosts(prs, [task({ buildInputs: ['Bash {"command":"git push -u origin claude/fix-login-a1"}'] })])
    expect([...m]).toEqual([[7, 1]])
  })

  it("charges the task that opened the PR", () => {
    expect([...matchCosts(prs, [task({ openedPrs: [8, 999] })])]).toEqual([[8, 1]])
  })

  it("splits a task that built two PRs, ignores shared branches and tasks that built nothing", () => {
    const m = matchCosts(prs, [
      task({ usd: 2, buildInputs: ["git push origin claude/fix-login-a1 claude/fix-login-a1-more"] }),
      task({ buildInputs: ["git push origin main"] }),
      task({ buildInputs: [] }),
    ])
    expect(m.get(7)).toBe(1)
    expect(m.get(8)).toBe(1)
    expect(m.has(9)).toBe(false)
  })

  it("matches whole branch names only", () => {
    expect(mentionsBranch('{"head":"claude/x-1"}', "claude/x-1")).toBe(true)
    expect(mentionsBranch("origin claude/x-10", "claude/x-1")).toBe(false)
    expect(mentionsBranch("origin feat/claude/x-1", "claude/x-1")).toBe(false)
  })

  it("read-only calls that pass a head branch are not build calls", () => {
    expect(BUILD_CALL_RE.test('mcp__github__list_pull_requests {"head":"o:claude/x-1","state":"open"}')).toBe(false)
    expect(BUILD_CALL_RE.test('mcp__github__create_pull_request {"head":"claude/x-1","base":"main"}')).toBe(true)
    expect(BUILD_CALL_RE.test('mcp__github__push_files {"branch":"claude/x-1"}')).toBe(true)
  })

  it("a cloud-session link marks a PR external", () => {
    expect(isExternalPr({ body: "https://claude.ai/code/session_01ABC" })).toBe(true)
    expect(isExternalPr({ body: "plain" })).toBe(false)
  })
})

describe("GitHub readers (fake gh, no network)", () => {
  it("reads merged PRs page by page, per 7-day chunk, without duplicates", async () => {
    const calls: string[] = []
    const node = (n: number) => ({
      number: n, title: `fix: ${n}`, body: null, createdAt: "2026-01-05T00:00:00Z", mergedAt: `2026-01-0${n}T00:00:00Z`,
      headRefName: "claude/x", labels: { nodes: [{ name: "agent:coder" }] }, files: { nodes: [{ path: "src/a/b.ts", changeType: "MODIFIED" }, { path: "test/n.test.ts", changeType: "ADDED" }] },
      closingIssuesReferences: { nodes: [{ number: 40, createdAt: "2026-01-01T00:00:00Z" }] },
      commits: { nodes: [{ commit: { oid: `sha${n}` } }] },
    })
    const gh: GhRunner = async (args) => {
      const q = args.find((a) => a.startsWith("q="))!
      const cursor = args.find((a) => a.startsWith("cursor="))
      calls.push(`${q}|${cursor ?? ""}`)
      const page = cursor
        ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(2), {}] }
        : { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1), node(2)] }
      return JSON.stringify({ data: { search: page } })
    }
    const prs = await fetchMergedPrs("o/r", "main", "2026-01-01", "2026-01-10", gh)
    expect(calls).toHaveLength(4) // two chunks × two pages
    expect(calls[0]).toContain("repo:o/r is:pr is:merged base:main merged:2026-01-01..2026-01-07")
    expect(prs.map((p) => p.number)).toEqual([1, 2])
    expect(prs[0]).toMatchObject({ body: "", labels: ["agent:coder"], files: ["src/a/b.ts", "test/n.test.ts"], addedFiles: ["test/n.test.ts"], commits: ["sha1"],
      closingIssues: [{ number: 40, createdAt: "2026-01-01T00:00:00Z" }] })
  })

  it("sums job durations of CI runs on the PR's commits and caches finished runs", async () => {
    const prs = [pr({ number: 1, commits: ["a", "b"], createdAt: "2026-01-05T00:00:00Z" }), pr({ number: 2, commits: ["c"] })]
    const jobCalls: string[] = []
    const gh: GhRunner = async ([, path]) => {
      if (path.includes("/workflows/ci.yml/runs")) {
        return JSON.stringify({ total_count: 3, workflow_runs: [
          { id: 100, head_sha: "a", status: "completed" },
          { id: 101, head_sha: "b", status: "in_progress" },
          { id: 102, head_sha: "zzz", status: "completed" },
        ] })
      }
      jobCalls.push(path)
      return JSON.stringify({ jobs: [
        { started_at: "2026-01-05T10:00:00Z", completed_at: "2026-01-05T10:03:00Z" },
        { started_at: "2026-01-05T10:00:00Z", completed_at: "2026-01-05T10:01:30Z" },
        { started_at: "2026-01-05T10:00:00Z", completed_at: null },
      ] })
    }
    const cache = new Map<number, number>()
    const m = await fetchCiMinutes("o/r", prs, "2026-01-05", "2026-01-06", { gh, cache })
    expect(m.get(1)).toBe(9)
    expect(m.get(2)).toBe(0)
    expect([...cache]).toEqual([[100, 4.5]])
    jobCalls.length = 0
    await fetchCiMinutes("o/r", prs, "2026-01-05", "2026-01-06", { gh, cache })
    expect(jobCalls).toEqual(["repos/o/r/actions/runs/101/jobs?filter=all&per_page=100"])
  })

  it("warns when a 7-day chunk has more runs than GitHub lists", async () => {
    const pages: string[] = []
    const gh: GhRunner = async ([, path]) => {
      if (path.includes("/runs?")) { pages.push(path); return JSON.stringify({ total_count: 1500, workflow_runs: [] }) }
      return JSON.stringify({ jobs: [] })
    }
    const warnings: string[] = []
    await fetchCiMinutes("o/r", [pr({ number: 1, createdAt: "2026-01-05T00:00:00Z" })], "2026-01-05", "2026-01-06",
      { gh, onWarning: (m) => warnings.push(m) })
    expect(pages).toHaveLength(10)
    expect(warnings).toEqual(["CI runs 2026-01-05..2026-01-06: 1500 runs, GitHub lists only 1,000. CI minutes for that week are a lower bound."])
  })
})

describe("readTaskCosts (temporary trace store)", () => {
  it("keeps tasks with a build call, reads opened PR URLs and prices tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "quality-"))
    const path = join(dir, "db.sqlite")
    try {
      const db = new Database(path)
      db.exec(`
        CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, model TEXT, started_at INTEGER,
          input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER);
        CREATE TABLE task_trace_steps (task_id TEXT, seq INTEGER, name TEXT, action TEXT,
          input_summary TEXT, output_summary TEXT);
      `)
      const trace = db.prepare("INSERT INTO task_traces VALUES (?, 'claude-sonnet-4-6', ?, 1000000, 0, 0, 0)")
      trace.run("built", 1000)
      trace.run("talked", 1000)
      trace.run("listed", 1000)
      trace.run("too-old", 1)
      const step = db.prepare("INSERT INTO task_trace_steps VALUES (?, ?, ?, ?, ?, ?)")
      step.run("built", 0, "tool_use", "Bash", '{"command":"git push -u origin claude/x-1"}', null)
      step.run("built", 1, "tool_result", null, null, "ok")
      step.run("built", 2, "tool_use", "Bash", '{"command":"gh pr create --fill"}', null)
      step.run("built", 3, "tool_result", null, null, "https://github.com/o/r/pull/42")
      step.run("talked", 0, "tool_use", "Bash", '{"command":"gh pr view 42"}', null)
      step.run("listed", 0, "tool_use", "mcp__github__list_pull_requests", '{"head":"o:claude/x-1"}', null)
      step.run("too-old", 0, "tool_use", "Bash", '{"command":"git push origin claude/x-1"}', null)
      db.close()

      const tasks = readTaskCosts(path, "o/r", 500, 2000)!
      expect(tasks).toHaveLength(1)
      expect(tasks[0].openedPrs).toEqual([42])
      expect(tasks[0].buildInputs).toHaveLength(2)
      expect(tasks[0].usd).toBeCloseTo(3) // 1M input tokens at $3/MTok
      expect(readTaskCosts(join(dir, "missing.sqlite"), "o/r", 0, 1)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
