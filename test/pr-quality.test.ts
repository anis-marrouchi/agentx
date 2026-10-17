import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import * as lib from "../scripts/pr-quality-lib.mjs"

const {
  area,
  citedNumbers,
  closingNumbers,
  counted,
  isAgentPr,
  isEnabled,
  isFix,
  judge,
  median,
  pctChange,
  renderReport,
  summarise,
  titleType,
  weekEnding,
  windowRange,
} = lib
const settings = JSON.parse(readFileSync(new URL("../contrib/pr-quality.json", import.meta.url), "utf8"))

type Pr = { number: number; title: string; body?: string; labels?: string[]; head?: string; base?: string; mergedAt: string }
const pr = (p: Pr) => ({ body: "", labels: [], head: "claude/x", base: "main", ...p })

const week = windowRange({ from: "2026-10-10", to: "2026-10-16" })
const prs = [
  pr({ number: 1, title: "feat(calls): ring again", mergedAt: "2026-10-10T08:00:00Z", body: "Closes #100" }),
  pr({ number: 2, title: "fix(calls): clear the mark (#1 follow-up)", mergedAt: "2026-10-10T10:00:00Z", body: "Refs #1. After review." }),
  pr({ number: 3, title: "fix(app): late fix", mergedAt: "2026-10-13T08:00:00Z", body: "Fixes #1" }),
  pr({ number: 4, title: "chore(main): release 1.0.0", head: "release-please--branches--main", mergedAt: "2026-10-11T00:00:00Z" }),
  pr({ number: 5, title: "docs: by hand", head: "docs-tweak", mergedAt: "2026-10-12T00:00:00Z", body: "Fixes #101" }),
  pr({ number: 6, title: "fix: outside the week", mergedAt: "2026-10-17T00:00:00Z" }),
  pr({ number: 7, title: "fix: stacked", base: "claude/other", mergedAt: "2026-10-12T00:00:00Z" }),
]
const files = new Map([
  [2, ["src/calls/store.ts", "test/calls.test.ts"]],
  [3, ["src/daemon/ui/pages/app.ts", "src/daemon/index.ts"]],
  [7, ["src/calls/service.ts"]],
])
const issueCreated = new Map([
  [100, "2026-10-10T06:00:00Z"],
  [101, "2026-10-11T00:00:00Z"],
])

describe("switch and settings", () => {
  it("is on unless enabled is false", () => {
    expect(isEnabled({})).toBe(true)
    expect(isEnabled({ enabled: true })).toBe(true)
    expect(isEnabled({ enabled: false })).toBe(false)
  })

  it("ships switched on, with the #987 baseline week and budgets", () => {
    expect(settings.enabled).toBe(true)
    expect(settings.baseline).toEqual({ from: "2026-10-09", to: "2026-10-16" })
    expect(settings.budgets).toEqual({ costPct: 20, leadHours: 1 })
  })
})

describe("windows", () => {
  it("includes both days", () => {
    expect(week.end - week.start).toBe(7 * 24 * 3600 * 1000)
    expect(weekEnding("2026-10-16", 7)).toEqual({ from: "2026-10-10", to: "2026-10-16" })
  })
})

describe("classification", () => {
  it("reads the conventional-commit type", () => {
    expect(titleType("fix(calls): x")).toBe("fix")
    expect(titleType("feat!: x")).toBe("feat")
    expect(titleType("Merge pull request #1")).toBe("")
  })

  it("treats a fix title, or a configured pattern, as a fix", () => {
    expect(isFix(pr({ number: 1, title: "fix: x", mergedAt: "" }), settings)).toBe(true)
    expect(isFix(pr({ number: 1, title: "style: x (#9 review nit)", mergedAt: "" }), settings)).toBe(false)
    const withPatterns = { ...settings, fix: { titleTypes: ["fix"], titlePatterns: ["review nit"] } }
    expect(isFix(pr({ number: 1, title: "style: x (#9 review nit)", mergedAt: "" }), withPatterns)).toBe(true)
  })

  it("finds agent PRs by label, branch or body", () => {
    const base = { number: 1, title: "x", mergedAt: "", head: "topic" }
    expect(isAgentPr(pr(base), settings)).toBe(false)
    expect(isAgentPr(pr({ ...base, labels: ["agent:coder-agent"] }), settings)).toBe(true)
    expect(isAgentPr(pr({ ...base, head: "claude/topic" }), settings)).toBe(true)
    expect(isAgentPr(pr({ ...base, body: "🤖 Generated with [Claude Code](https://claude.com/claude-code)" }), settings)).toBe(true)
  })

  it("collects cited and closed numbers", () => {
    expect(citedNumbers("Refs #12, #12 and (#7). Not a/b#3 or x#4")).toEqual([12, 7])
    expect(closingNumbers("Closes #5. fixes #6, Resolved: #7. Refs #8")).toEqual([5, 6, 7])
  })

  it("groups paths by folder", () => {
    expect(area("src/daemon/index.ts", 2)).toBe("src/daemon")
    expect(area("src/cli.ts", 2)).toBe("src")
    expect(area("README.md", 2)).toBe("README.md")
  })

  it("takes the median", () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
})

describe("counted", () => {
  it("counts every merged PR in the window by default, any base, releases included", () => {
    const { merged, fixes } = counted(prs, week, settings)
    expect(merged.map((p: Pr) => p.number)).toEqual([1, 2, 3, 4, 5, 7])
    expect(fixes.map((p: Pr) => p.number)).toEqual([2, 3, 7])
  })

  it("keeps agent PRs only, without releases, in agent scope", () => {
    const { merged } = counted(prs, week, settings, "agent")
    expect(merged.map((p: Pr) => p.number)).toEqual([1, 2, 3, 7])
  })

  it("keeps one target branch when base is set", () => {
    const { merged } = counted(prs, week, { ...settings, base: "main" })
    expect(merged.map((p: Pr) => p.number)).not.toContain(7)
  })
})

describe("summarise", () => {
  const s = summarise(prs, week, settings, { files, issueCreated })

  it("counts fixes, their share and the agent-only share", () => {
    expect(s).toMatchObject({ merged: 6, fixes: 3, agentMerged: 4, agentFixes: 3 })
    expect(s.fixShare).toBe(0.5)
    expect(s.agentFixShare).toBe(0.75)
  })

  it("measures the gap from the cited PR and counts the fast ones", () => {
    // #2 cites #1 merged 2 h before; #3 closes #1 (a PR) merged 72 h before.
    expect(s.citing).toBe(2)
    expect(s.medianGapHours).toBe(37)
    expect(s.fastFixes).toBe(1)
    expect(s.fastFixesPer100).toBeCloseTo(100 / 6)
  })

  it("ignores citations of later or unknown PRs", () => {
    const later = [pr({ number: 9, title: "fix: x", mergedAt: "2026-10-11T00:00:00Z", body: "#10 #404" }), pr({ number: 10, title: "feat: y", mergedAt: "2026-10-12T00:00:00Z" })]
    expect(summarise(later, week, settings).citing).toBe(0)
  })

  it("reads files for tests, UI and hotspots, skipping test files in hotspots", () => {
    expect(s).toMatchObject({ filesKnown: 3, withTests: 1, ui: 1, reviewMentions: 1 })
    expect(s.hotspots).toEqual([
      { path: "src/calls", touches: 2 },
      { path: "src/daemon", touches: 2 },
    ])
  })

  it("measures issue→merge lead time from issues only", () => {
    // #1: 2 h after #100; #5: 24 h after #101; #3 closes #1, which is not an issue.
    expect(s.leadTimes).toBe(2)
    expect(s.medianLeadHours).toBe(13)
  })

  it("gives cost per merged PR only when the cost file covers the window", () => {
    expect(s.costPerPr).toBeNull()
    const cost = new Map([["2026-10-10", 6], ["2026-10-16", 6], ["2026-10-20", 100]])
    expect(summarise(prs, week, settings, { cost }).costPerPr).toBe(2)
    expect(summarise(prs, week, settings, { cost: new Map([["2026-10-01", 5]]) }).costPerPr).toBeNull()
  })
})

describe("judge and render", () => {
  const baseline = { fixShare: 0.37, fastFixesPer100: 10, costPerPr: 2, medianLeadHours: 3 }
  const budgets = { fastFixHours: 24, costPct: 20, leadHours: 1 }

  it("passes each criterion only within its budget", () => {
    const good = judge({ fixShare: 0.3, fastFixesPer100: 8, costPerPr: 2.4, medianLeadHours: 4 }, baseline, { budgets })
    expect(good.map((c: { ok: boolean }) => c.ok)).toEqual([true, true, true, true])
    const bad = judge({ fixShare: 0.37, fastFixesPer100: 10, costPerPr: 2.5, medianLeadHours: 4.5 }, baseline, { budgets })
    expect(bad.map((c: { ok: boolean }) => c.ok)).toEqual([false, false, false, false])
  })

  it("leaves a criterion open when data is missing", () => {
    const open = judge({ fixShare: null, fastFixesPer100: null, costPerPr: null, medianLeadHours: null }, baseline, { budgets })
    expect(open.map((c: { ok: boolean | null }) => c.ok)).toEqual([null, null, null, null])
    expect(pctChange(0, 5)).toBeNull()
    expect(pctChange(2, 2.5)).toBe(25)
  })

  it("prints cost as a percentage change only, never the amount", () => {
    const cost = new Map([["2026-10-10", 123.45]])
    const w = summarise(prs, week, settings, { files, issueCreated, cost })
    const b = { ...w, costPerPr: w.costPerPr / 2, from: "2026-10-01", to: "2026-10-07" }
    const md = renderReport(w, b, settings)
    expect(md).toContain("+100.0%")
    expect(md).not.toMatch(/123|20\.57|10\.29/)
    expect(md).toContain("| Fix share | 50% | 50% |")
    expect(md).toContain("`src/calls`: 2 file change(s)")
  })
})
