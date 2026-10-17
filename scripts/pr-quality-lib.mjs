// Pure helpers for the weekly PR quality report (#987). No network, no files:
// the runner in pr-quality.mjs fetches, this module counts and renders.
//
// A PR here is { number, title, body, labels: string[], head, base, mergedAt }
// with mergedAt an ISO string. Files are repo paths; times are ISO strings.
import { matchesAny } from './docs-gate-lib.mjs'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** The report is off when `enabled` is false in the settings. */
export function isEnabled(settings) {
  return settings.enabled !== false
}

/** `{ from, to }` as YYYY-MM-DD, both days included → [start, end) in ms (UTC). */
export function windowRange({ from, to }) {
  return { from, to, start: Date.parse(`${from}T00:00:00Z`), end: Date.parse(`${to}T00:00:00Z`) + DAY_MS }
}

/** The `days` whole days that end with `to` (YYYY-MM-DD, included). */
export function weekEnding(to, days) {
  const end = Date.parse(`${to}T00:00:00Z`)
  return { from: new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10), to }
}

const inRange = (iso, range) => {
  const t = Date.parse(iso)
  return t >= range.start && t < range.end
}

/** Conventional-commit type of a title (`fix(calls): …` → `fix`), or ''. */
export function titleType(title) {
  return title.match(/^\s*([a-z]+)(?:\([^)]*\))?!?:/i)?.[1].toLowerCase() ?? ''
}

/** A PR written by an agent: by label, branch name or body marker. */
export function isAgentPr(pr, { agent }) {
  return (
    pr.labels.some((l) => agent.labelPrefixes.some((p) => l.startsWith(p))) ||
    agent.headPrefixes.some((p) => pr.head.startsWith(p)) ||
    agent.bodyPatterns.some((p) => new RegExp(p, 'i').test(pr.body ?? ''))
  )
}

/** Release and bot PRs that are never counted. */
export function isExcluded(pr, { exclude }) {
  return exclude.headPrefixes.some((p) => pr.head.startsWith(p))
}

/** A PR that fixes or follows up on an earlier change, judged by its title. */
export function isFix(pr, { fix }) {
  return fix.titleTypes.includes(titleType(pr.title)) || fix.titlePatterns.some((p) => new RegExp(p, 'i').test(pr.title))
}

/** Every `#123` in a text, in order, without repeats. */
export function citedNumbers(text) {
  return [...new Set([...(text ?? '').matchAll(/(?<![\w/])#(\d+)\b/g)].map((m) => Number(m[1])))]
}

/** Issues closed by the PR body (`Fixes #1`, `Closes #2`, `Resolves #3`). */
export function closingNumbers(text) {
  return [
    ...new Set([...(text ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)].map((m) => Number(m[1]))),
  ]
}

export function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Top-level folder (to `depth` parts) of a path; files at the root stay as they are. */
export function area(path, depth) {
  const parts = path.split('/')
  return parts.length <= depth ? parts.slice(0, -1).join('/') || path : parts.slice(0, depth).join('/')
}

/**
 * The merged PRs of one window, and the fixes among them. `scope` "all" counts
 * every merged PR, as the #987 baseline does; "agent" keeps agent PRs only and
 * drops excluded ones (releases). A null `base` accepts any target branch.
 */
export function counted(prs, range, settings, scope = settings.scope) {
  const merged = prs
    .filter((p) => p.mergedAt && (settings.base == null || p.base === settings.base) && inRange(p.mergedAt, range))
    .filter((p) => scope === 'all' || (!isExcluded(p, settings) && isAgentPr(p, settings)))
  return { merged, fixes: merged.filter((p) => isFix(p, settings)) }
}

/**
 * Count one window.
 *
 * @param prs          every merged PR fetched (all windows), used to look up cited PRs
 * @param range        from windowRange()
 * @param settings     contrib/pr-quality.json
 * @param files        Map PR number → changed paths (fixes only; missing = unknown)
 * @param issueCreated Map issue number → createdAt (real issues only, not PRs)
 * @param cost         optional Map YYYY-MM-DD → spend for that day (local only)
 */
export function summarise(prs, range, settings, { files = new Map(), issueCreated = new Map(), cost } = {}) {
  const byNumber = new Map(prs.map((p) => [p.number, p]))
  const { merged, fixes } = counted(prs, range, settings)
  const agent = counted(prs, range, settings, 'agent')

  const reviewRe = new RegExp(settings.reviewPattern, 'i')
  const citing = []
  for (const f of fixes) {
    const gaps = citedNumbers(`${f.title}\n${f.body ?? ''}`)
      .map((n) => byNumber.get(n))
      .filter((p) => p && p.mergedAt && p.number !== f.number && Date.parse(p.mergedAt) <= Date.parse(f.mergedAt))
      .map((p) => (Date.parse(f.mergedAt) - Date.parse(p.mergedAt)) / HOUR_MS)
    if (gaps.length) citing.push(Math.min(...gaps))
  }
  const fast = citing.filter((h) => h <= settings.fastFixHours).length

  const known = fixes.filter((f) => files.has(f.number))
  const touching = (globs) => known.filter((f) => files.get(f.number).some((p) => matchesAny(p, globs))).length
  const areas = new Map()
  for (const f of known) {
    for (const path of files.get(f.number)) {
      if (matchesAny(path, settings.testPaths)) continue
      const a = area(path, settings.hotspots.depth)
      areas.set(a, (areas.get(a) ?? 0) + 1)
    }
  }
  const hotspots = [...areas]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, settings.hotspots.top)
    .map(([path, touches]) => ({ path, touches }))

  const leads = []
  for (const p of merged) {
    const created = closingNumbers(p.body)
      .map((n) => issueCreated.get(n))
      .filter(Boolean)
      .map((iso) => Date.parse(iso))
    if (created.length) leads.push((Date.parse(p.mergedAt) - Math.min(...created)) / HOUR_MS)
  }

  let costPerPr = null
  if (cost && merged.length) {
    let total = 0
    let days = 0
    for (const [day, amount] of cost) {
      if (!inRange(`${day}T12:00:00Z`, range)) continue
      total += amount
      days++
    }
    if (days) costPerPr = total / merged.length
  }

  return {
    from: range.from,
    to: range.to,
    merged: merged.length,
    fixes: fixes.length,
    fixShare: merged.length ? fixes.length / merged.length : null,
    agentMerged: agent.merged.length,
    agentFixes: agent.fixes.length,
    agentFixShare: agent.merged.length ? agent.fixes.length / agent.merged.length : null,
    citing: citing.length,
    medianGapHours: median(citing),
    fastFixes: fast,
    fastFixesPer100: merged.length ? (fast * 100) / merged.length : null,
    reviewMentions: fixes.filter((f) => reviewRe.test(`${f.title}\n${f.body ?? ''}`)).length,
    filesKnown: known.length,
    withTests: touching(settings.testPaths),
    ui: touching(settings.uiPaths),
    hotspots,
    leadTimes: leads.length,
    medianLeadHours: median(leads),
    costPerPr,
  }
}

/** Percentage change from `before` to `after`, or null when either is missing. */
export function pctChange(before, after) {
  if (before == null || after == null || before === 0) return null
  return ((after - before) / before) * 100
}

/**
 * The success criteria of #987, judged on one week against the baseline.
 * `ok` is true, false, or null when there is not enough data.
 */
export function judge(week, baseline, { budgets }) {
  const both = (a, b) => a != null && b != null
  const costPct = pctChange(baseline.costPerPr, week.costPerPr)
  const leadDelta = both(week.medianLeadHours, baseline.medianLeadHours)
    ? week.medianLeadHours - baseline.medianLeadHours
    : null
  return [
    {
      name: 'Fix share of merged PRs is below the baseline',
      ok: both(week.fixShare, baseline.fixShare) ? week.fixShare < baseline.fixShare : null,
      value: `${share(week.fixes, week.merged, week.fixShare)}, baseline ${share(baseline.fixes, baseline.merged, baseline.fixShare)}`,
    },
    {
      name: `Fixes within ${budgets.fastFixHours} h, per 100 merged PRs, go down`,
      ok: both(week.fastFixesPer100, baseline.fastFixesPer100) ? week.fastFixesPer100 < baseline.fastFixesPer100 : null,
      value: `${num(week.fastFixesPer100)} (baseline ${num(baseline.fastFixesPer100)})`,
    },
    {
      name: `Model cost per merged PR rises by no more than ${budgets.costPct}%`,
      ok: costPct == null ? null : costPct <= budgets.costPct,
      value: costPct == null ? 'not measured (needs a local cost file)' : signedPct(costPct),
    },
    {
      name: `Median issue→merge lead time rises by no more than ${budgets.leadHours} h`,
      ok: leadDelta == null ? null : leadDelta <= budgets.leadHours,
      value: leadDelta == null ? 'not enough data' : `${num(week.medianLeadHours)} h (${signedHours(leadDelta)})`,
    },
  ]
}

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`)
const num = (x) => (x == null ? '–' : Number.isInteger(x) ? String(x) : x.toFixed(1))
const signedPct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`
const signedHours = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)} h`
const mark = (ok) => (ok == null ? '–' : ok ? 'yes' : 'no')

/**
 * Markdown for the job summary. Cost appears only as a percentage change:
 * absolute amounts never leave the machine that has the cost file.
 */
export function renderReport(week, baseline, settings) {
  const rows = [
    ['Merged PRs', week.merged, baseline.merged],
    ['Fixes', week.fixes, baseline.fixes],
    ['Fix share', pct(week.fixShare), pct(baseline.fixShare)],
    ['Fix share, agent PRs only (no releases)', share(week.agentFixes, week.agentMerged, week.agentFixShare), share(baseline.agentFixes, baseline.agentMerged, baseline.agentFixShare)],
    ['Fixes that cite an earlier PR', week.citing, baseline.citing],
    ['Median gap to the PR they fix', hours(week.medianGapHours), hours(baseline.medianGapHours)],
    [`Fixes within ${settings.fastFixHours} h`, week.fastFixes, baseline.fastFixes],
    [`Fixes within ${settings.fastFixHours} h per 100 merged`, num(week.fastFixesPer100), num(baseline.fastFixesPer100)],
    ['Fixes that mention a review', week.reviewMentions, baseline.reviewMentions],
    ['Fixes that change tests', week.withTests, baseline.withTests],
    ['Fixes that change UI files', week.ui, baseline.ui],
    ['Median issue→merge lead time', hours(week.medianLeadHours), hours(baseline.medianLeadHours)],
    ['PRs with a linked issue', week.leadTimes, baseline.leadTimes],
  ]
  const criteria = judge(week, baseline, {
    budgets: { fastFixHours: settings.fastFixHours, costPct: settings.budgets.costPct, leadHours: settings.budgets.leadHours },
  })
  const lines = [
    `# PR quality: ${week.from} to ${week.to}`,
    '',
    `${settings.scope === 'all' ? 'Merged PRs' : 'Merged agent PRs'}${settings.base ? ` into \`${settings.base}\`` : ''}, compared with the baseline (${baseline.from} to ${baseline.to}). Settings: \`contrib/pr-quality.json\`.`,
    '',
    '| Metric | This week | Baseline |',
    '|---|---|---|',
    ...rows.map(([name, a, b]) => `| ${name} | ${a} | ${b} |`),
    '',
    '## Success criteria',
    '',
    '| Criterion | Met | Value |',
    '|---|---|---|',
    ...criteria.map((c) => `| ${c.name} | ${mark(c.ok)} | ${c.value} |`),
    '',
    '## Where the fixes land',
    '',
    week.hotspots.length
      ? week.hotspots.map((h) => `- \`${h.path}\`: ${h.touches} file change(s)`).join('\n')
      : '- No fixes this week.',
    '',
  ]
  return lines.join('\n')
}

const share = (part, whole, x) => (x == null ? '–' : `${pct(x)} (${part}/${whole})`)
const hours = (h) => (h == null ? '–' : `${h.toFixed(1)} h`)
