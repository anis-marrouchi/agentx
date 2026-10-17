import {
  areaOf, isAgentPr, isExternalPr, isFix, isReleasePr, leadTimeOf, mentionsReview, percentile, regressionOf,
  touchesTests, touchesUi, weekOf,
  type PrRecord,
} from "./classify"

// --- Quality report: aggregation, baselines, rendering ---
//
// The JSON shape below is a public contract (#994 posts it and compares
// weeks). Add fields freely; never rename or remove one without bumping
// QUALITY_REPORT_SCHEMA. Documented in docs/guides/quality-report.md.

export const QUALITY_REPORT_SCHEMA = "agentx.quality-report/v1"

export type Scope = "agent" | "all"

export interface LeadStats { n: number; medianHours: number | null; p90Hours: number | null }

export interface CostStats {
  /** Absolute USD figures. Left out of `--public` output. */
  perMergedPr?: number | null
  total?: number | null
  /** PRs with any AgentX cost matched. */
  attributedPrs: number
  /** PRs from a Claude cloud session with no AgentX match, billed outside AgentX. */
  externalPrs: number
  /** attributedPrs / (mergedPrs - externalPrs); null when that is 0. */
  attributionRate: number | null
  /** "unattributed" when no PR in the row has a cost match; "external" when
   *  none has a match and every PR is external. */
  status: "attributed" | "unattributed" | "external"
  /** % change of perMergedPr vs the compared baseline, when one is given. */
  changePct?: number | null
}

export interface ReportRow {
  mergedPrs: number
  fixes: number
  /** fixes / mergedPrs, 0..1; null when there are no PRs. */
  fixShare: number | null
  regressionFixes24h: number
  regressionFixes72h: number
  /** Regression fixes per 100 merged PRs, so weeks of different size compare; null when there are no PRs. */
  regressionFixes24hPer100: number | null
  regressionFixes72hPer100: number | null
  /** Fixes whose title or description mentions a review. */
  fixesMentioningReview: number
  /** Fixes that change a test file. */
  fixesTouchingTests: number
  /** Fixes that change dashboard or app files. */
  fixesTouchingUi: number
  leadTime: { issue: LeadStats; pr: LeadStats }
  /** Null when CI data was not read (`--no-ci` or no access). */
  ciMinutes: number | null
  cost: CostStats
}

export interface QualityReport {
  schema: typeof QUALITY_REPORT_SCHEMA
  repo: string
  base: string
  since: string
  until: string
  generatedAt: string
  /** Which PRs the week and area rows count. */
  scope: Scope
  public: boolean
  totals: { agent: ReportRow; all: ReportRow }
  weeks: Array<ReportRow & { week: string }>
  areas: Array<ReportRow & { area: string }>
  /** Release PRs left out of every row, and the fix share if they were
   *  counted in the denominator (to compare with figures that include them). */
  excluded: { releasePrs: number; fixShareWithReleases: number | null }
  comparison?: Comparison
}

export interface RowDelta {
  mergedPrs: number
  /** Percentage points. */
  fixSharePts: number | null
  regressionFixes24h: number
  regressionFixes72h: number
  regressionFixes24hPer100: number | null
  regressionFixes72hPer100: number | null
  issueLeadMedianHours: number | null
  prLeadMedianHours: number | null
  ciMinutes: number | null
  costPerMergedPrPct: number | null
  attributionRatePts: number | null
}

export interface Comparison {
  baseline: string
  baselineSince: string
  baselineUntil: string
  totals: { agent: RowDelta; all: RowDelta }
  areas: Array<RowDelta & { area: string }>
}

/** Per-PR facts the aggregation needs beyond the classifiers. */
export interface PrExtras {
  /** CI minutes per PR number; missing key = no data. */
  ciMinutes?: Map<number, number>
  /** Model cost in USD per PR number; only PRs with a match. */
  cost?: Map<number, number>
}

export interface BuildOptions {
  repo: string
  base?: string
  since: string
  until: string
  scope?: Scope
  generatedAt?: string
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

/**
 * Build the report. `prs` may include PRs merged before `since` (up to 72 h
 * earlier) so regression citations at the window start resolve; only PRs
 * merged inside [since, until] are counted.
 */
export function buildReport(prs: PrRecord[], opts: BuildOptions, extras: PrExtras = {}): QualityReport {
  const mergedAt = new Map(prs.map((p) => [p.number, p.mergedAt]))
  const from = Date.parse(`${opts.since}T00:00:00Z`)
  const to = Date.parse(`${opts.until}T23:59:59.999Z`)
  const inWindow = prs.filter((p) => {
    const t = Date.parse(p.mergedAt)
    return t >= from && t <= to
  })
  const nonRelease = inWindow.filter((p) => !isReleasePr(p))
  const agent = nonRelease.filter(isAgentPr)
  const scope = opts.scope ?? "agent"
  const rows = scope === "agent" ? agent : nonRelease
  const ciRead = extras.ciMinutes !== undefined

  const row = (list: PrRecord[]): ReportRow => {
    let fixes = 0, r24 = 0, r72 = 0, ci = 0, costTotal = 0, attributed = 0, external = 0
    let review = 0, tests = 0, ui = 0
    const issueLead: number[] = []
    const prLead: number[] = []
    for (const pr of list) {
      if (isFix(pr.title)) {
        fixes++
        if (mentionsReview(pr)) review++
        if (touchesTests(pr.files)) tests++
        if (touchesUi(pr.files)) ui++
      }
      const reg = regressionOf(pr, mergedAt)
      if (reg.within24h) r24++
      if (reg.within72h) r72++
      const lead = leadTimeOf(pr)
      if (lead) (lead.kind === "issue" ? issueLead : prLead).push(lead.hours)
      ci += extras.ciMinutes?.get(pr.number) ?? 0
      const c = extras.cost?.get(pr.number)
      if (c !== undefined) { costTotal += c; attributed++ } else if (isExternalPr(pr)) external++
    }
    const lead = (v: number[]): LeadStats => ({
      n: v.length,
      medianHours: nullable(percentile(v, 50), 1),
      p90Hours: nullable(percentile(v, 90), 1),
    })
    return {
      mergedPrs: list.length,
      fixes,
      fixShare: list.length ? round(fixes / list.length, 4) : null,
      regressionFixes24h: r24,
      regressionFixes72h: r72,
      regressionFixes24hPer100: per100(r24, list.length),
      regressionFixes72hPer100: per100(r72, list.length),
      fixesMentioningReview: review,
      fixesTouchingTests: tests,
      fixesTouchingUi: ui,
      leadTime: { issue: lead(issueLead), pr: lead(prLead) },
      ciMinutes: ciRead ? round(ci, 1) : null,
      cost: {
        perMergedPr: attributed ? round(costTotal / attributed) : null,
        total: attributed ? round(costTotal) : null,
        attributedPrs: attributed,
        externalPrs: external,
        attributionRate: list.length - external ? round(attributed / (list.length - external), 4) : null,
        status: attributed ? "attributed" : list.length && external === list.length ? "external" : "unattributed",
      },
    }
  }

  const groupBy = (key: (p: PrRecord) => string) => {
    const m = new Map<string, PrRecord[]>()
    for (const p of rows) {
      const k = key(p)
      m.set(k, [...(m.get(k) || []), p])
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0]))
  }

  return {
    schema: QUALITY_REPORT_SCHEMA,
    repo: opts.repo,
    base: opts.base ?? "main",
    since: opts.since,
    until: opts.until,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    scope,
    public: false,
    totals: { agent: row(agent), all: row(nonRelease) },
    weeks: groupBy((p) => weekOf(p.mergedAt)).map(([week, list]) => ({ week, ...row(list) })),
    areas: groupBy((p) => areaOf(p.files)).map(([area, list]) => ({ area, ...row(list) })),
    excluded: {
      releasePrs: inWindow.length - nonRelease.length,
      fixShareWithReleases: inWindow.length ? round(inWindow.filter((p) => isFix(p.title)).length / inWindow.length, 4) : null,
    },
  }
}

function per100(n: number, of: number): number | null {
  return of ? round((n * 100) / of, 1) : null
}

function nullable(v: number | null, d: number): number | null {
  return v === null ? null : round(v, d)
}

const diff = (a: number | null | undefined, b: number | null | undefined, d = 1) =>
  a == null || b == null ? null : round(a - b, d)

const pctChange = (now: number | null | undefined, then: number | null | undefined) =>
  now == null || then == null || then === 0 ? null : round(((now - then) / then) * 100, 1)

function rowDelta(now: ReportRow, then: ReportRow): RowDelta {
  return {
    mergedPrs: now.mergedPrs - then.mergedPrs,
    fixSharePts: diff(now.fixShare === null ? null : now.fixShare * 100, then.fixShare === null ? null : then.fixShare * 100),
    regressionFixes24h: now.regressionFixes24h - then.regressionFixes24h,
    regressionFixes72h: now.regressionFixes72h - then.regressionFixes72h,
    regressionFixes24hPer100: diff(now.regressionFixes24hPer100, then.regressionFixes24hPer100),
    regressionFixes72hPer100: diff(now.regressionFixes72hPer100, then.regressionFixes72hPer100),
    issueLeadMedianHours: diff(now.leadTime.issue.medianHours, then.leadTime.issue.medianHours),
    prLeadMedianHours: diff(now.leadTime.pr.medianHours, then.leadTime.pr.medianHours),
    ciMinutes: diff(now.ciMinutes, then.ciMinutes),
    costPerMergedPrPct: pctChange(now.cost.perMergedPr, then.cost.perMergedPr),
    attributionRatePts: diff(
      now.cost.attributionRate === null ? null : now.cost.attributionRate * 100,
      then.cost.attributionRate === null ? null : then.cost.attributionRate * 100,
    ),
  }
}

/** Attach deltas against a saved baseline (which keeps its absolute costs locally). */
export function compareReports(now: QualityReport, baseline: QualityReport, name: string): QualityReport {
  const thenAreas = new Map(baseline.areas.map((a) => [a.area, a]))
  const out: QualityReport = structuredClone(now)
  out.comparison = {
    baseline: name,
    baselineSince: baseline.since,
    baselineUntil: baseline.until,
    totals: {
      agent: rowDelta(now.totals.agent, baseline.totals.agent),
      all: rowDelta(now.totals.all, baseline.totals.all),
    },
    areas: now.areas.flatMap((a) => {
      const then = thenAreas.get(a.area)
      return then ? [{ area: a.area, ...rowDelta(a, then) }] : []
    }),
  }
  // Cost change per row, for --public which shows only this.
  const ref = baseline.totals[now.scope].cost.perMergedPr
  const setChange = (r: ReportRow, then: number | null | undefined) => { r.cost.changePct = pctChange(r.cost.perMergedPr, then) }
  setChange(out.totals.agent, baseline.totals.agent.cost.perMergedPr)
  setChange(out.totals.all, baseline.totals.all.cost.perMergedPr)
  for (const w of out.weeks) setChange(w, ref)
  for (const a of out.areas) setChange(a, thenAreas.get(a.area)?.cost.perMergedPr)
  return out
}

/** Strip every absolute cost. What is left is safe to post in public. */
export function toPublic(report: QualityReport): QualityReport {
  const out: QualityReport = structuredClone(report)
  out.public = true
  const strip = (r: ReportRow) => {
    delete r.cost.perMergedPr
    delete r.cost.total
    if (r.cost.changePct === undefined) r.cost.changePct = null
  }
  strip(out.totals.agent)
  strip(out.totals.all)
  out.weeks.forEach(strip)
  out.areas.forEach(strip)
  return out
}

// --- Text rendering ------------------------------------------------------

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`)
const hrs = (v: number | null) => (v === null ? "—" : v < 48 ? `${round(v, 1)}h` : `${round(v / 24, 1)}d`)
const num = (v: number | null) => (v === null ? "—" : v.toFixed(1))
const signed = (v: number | null, unit = "") => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}${unit}`)

function costCell(r: ReportRow, isPublic: boolean): string {
  const ext = r.cost.externalPrs ? `, ${r.cost.externalPrs} external` : ""
  if (r.cost.status !== "attributed") return `${r.cost.status}${r.cost.status === "unattributed" ? ext : ""}`
  const rate = `${pct(r.cost.attributionRate)} matched${ext}`
  if (isPublic) {
    const change = r.cost.changePct
    return `${change === null || change === undefined ? "no baseline" : signed(change, "%")} (${rate})`
  }
  return `$${(r.cost.perMergedPr ?? 0).toFixed(2)} (${rate})`
}

const HEAD = ["PRs", "Fixes", "Fix share", "Reg ≤24h (/100)", "Reg ≤72h (/100)", "Fix review/tests/UI", "Lead issue p50/p90", "Lead PR p50/p90", "CI min", "Cost/PR"]

function cells(r: ReportRow, isPublic: boolean): string[] {
  return [
    String(r.mergedPrs),
    String(r.fixes),
    pct(r.fixShare),
    `${r.regressionFixes24h} (${num(r.regressionFixes24hPer100)})`,
    `${r.regressionFixes72h} (${num(r.regressionFixes72hPer100)})`,
    `${r.fixesMentioningReview}/${r.fixesTouchingTests}/${r.fixesTouchingUi}`,
    `${hrs(r.leadTime.issue.medianHours)} / ${hrs(r.leadTime.issue.p90Hours)}`,
    `${hrs(r.leadTime.pr.medianHours)} / ${hrs(r.leadTime.pr.p90Hours)}`,
    r.ciMinutes === null ? "—" : String(Math.round(r.ciMinutes)),
    costCell(r, isPublic),
  ]
}

function table(label: string, rows: Array<[string, string[]]>): string[] {
  const all = [[label, ...HEAD], ...rows.map(([k, c]) => [k, ...c])]
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => r[i].length)))
  const line = (r: string[]) => "  " + r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")
  return [line(all[0]), ...all.slice(1).map(line)]
}

export function renderReport(r: QualityReport): string {
  const out: string[] = []
  const scopeLabel = r.scope === "agent" ? "agent PRs" : "all non-release PRs"
  out.push("", `  Quality report — ${r.repo} (${r.base}), ${r.since} → ${r.until}`)
  out.push(`  Rows count ${scopeLabel}. ${r.excluded.releasePrs} release PRs left out (fix share with them counted: ${pct(r.excluded.fixShareWithReleases)}).${r.public ? " Public: cost shown as change vs baseline only." : ""}`)
  out.push("")
  out.push(...table("Total", [
    ["agent PRs", cells(r.totals.agent, r.public)],
    ["all non-release", cells(r.totals.all, r.public)],
  ]))
  out.push("")
  out.push(...table("Week of", r.weeks.map((w) => [w.week, cells(w, r.public)] as [string, string[]])))
  out.push("")
  out.push(...table("Area", r.areas.map((a) => [a.area, cells(a, r.public)] as [string, string[]])))
  if (r.comparison) {
    const c = r.comparison
    out.push("", `  Compared with baseline "${c.baseline}" (${c.baselineSince} → ${c.baselineUntil})`)
    const d = (label: string, x: RowDelta) =>
      `  ${label.padEnd(16)} PRs ${signed(x.mergedPrs)}, fix share ${signed(x.fixSharePts, " pts")}, ` +
      `reg ≤24h ${signed(x.regressionFixes24h)} (${signed(x.regressionFixes24hPer100, "/100")}), ` +
      `reg ≤72h ${signed(x.regressionFixes72h)} (${signed(x.regressionFixes72hPer100, "/100")}), ` +
      `lead p50 issue ${signed(x.issueLeadMedianHours, "h")} / PR ${signed(x.prLeadMedianHours, "h")}, ` +
      `CI ${signed(x.ciMinutes, " min")}, cost/PR ${signed(x.costPerMergedPrPct, "%")}`
    out.push(d("agent PRs", c.totals.agent), d("all non-release", c.totals.all))
    for (const a of c.areas) out.push(d(a.area, a))
  }
  out.push("")
  return out.join("\n")
}
