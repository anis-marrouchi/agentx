// Weekly PR quality report (#987): how many merged agent PRs are fixes of
// earlier ones, how fast those fixes follow, and where they land, compared
// with the baseline week in contrib/pr-quality.json.
//
// Needs GITHUB_TOKEN (read access). Prints Markdown; appends it to
// $GITHUB_STEP_SUMMARY too when that is set.
// Usage: node scripts/pr-quality.mjs [--repo owner/name] [--to YYYY-MM-DD] [--config file]
//          [--json out.json] [--cost-file spend.json]
// --to is the last day of the report week (default: yesterday, UTC).
// --cost-file is a local { "YYYY-MM-DD": spend } map; only the percentage
// change per merged PR is printed, never the amounts.
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { closingNumbers, counted, isEnabled, renderReport, summarise, weekEnding, windowRange } from './pr-quality-lib.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const args = process.argv.slice(2)
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)
const repo = opt('repo') ?? 'anis-marrouchi/agentx'
const token = process.env.GITHUB_TOKEN

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return res.json()
}

async function all(path) {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) return out
  }
}

const settings = JSON.parse(await readFile(opt('config') ?? 'contrib/pr-quality.json', 'utf8'))
if (!isEnabled(settings)) {
  const off = 'The PR quality report is switched off (enabled: false in contrib/pr-quality.json).'
  console.log(off)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${off}\n`)
  process.exit(0)
}

const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)
const week = windowRange(weekEnding(opt('to') ?? yesterday, settings.windowDays))
const baseline = windowRange(settings.baseline)
// Reach back one more week so a fix can find the PR it cites.
const since = Math.min(week.start, baseline.start) - 7 * DAY_MS

// Most recently updated first: once a page ends before `since`, no later page
// holds a PR merged after it.
const prs = []
for (let page = 1; ; page++) {
  const base = settings.base ? `&base=${settings.base}` : ''
  const batch = await gh(`/repos/${repo}/pulls?state=closed${base}&sort=updated&direction=desc&per_page=100&page=${page}`)
  for (const p of batch) {
    if (!p.merged_at) continue
    prs.push({
      number: p.number,
      title: p.title,
      body: p.body ?? '',
      labels: (p.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      head: p.head?.ref ?? '',
      base: p.base?.ref ?? '',
      mergedAt: p.merged_at,
    })
  }
  if (batch.length < 100 || Date.parse(batch.at(-1).updated_at) < since) break
}

// Files only for the fixes; issue dates only for issues a counted PR closes.
const windows = [week, baseline].map((r) => counted(prs, r, settings))
const files = new Map()
for (const n of new Set(windows.flatMap((w) => w.fixes.map((p) => p.number)))) {
  files.set(n, (await all(`/repos/${repo}/pulls/${n}/files`)).map((f) => f.filename))
}
const issueCreated = new Map()
for (const n of new Set(windows.flatMap((w) => w.merged.flatMap((p) => closingNumbers(p.body))))) {
  const issue = await gh(`/repos/${repo}/issues/${n}`).catch(() => null)
  if (issue && !issue.pull_request) issueCreated.set(n, issue.created_at)
}

const costFile = opt('cost-file')
const cost = costFile ? new Map(Object.entries(JSON.parse(await readFile(costFile, 'utf8')))) : undefined

const weekStats = summarise(prs, week, settings, { files, issueCreated, cost })
const baseStats = summarise(prs, baseline, settings, { files, issueCreated, cost })
const markdown = renderReport(weekStats, baseStats, settings)
console.log(markdown)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
if (opt('json')) {
  // Cost leaves this machine only as a percentage change: drop the amounts.
  const strip = ({ costPerPr, ...rest }) => rest
  await writeFile(opt('json'), `${JSON.stringify({ week: strip(weekStats), baseline: strip(baseStats) }, null, 2)}\n`)
}
