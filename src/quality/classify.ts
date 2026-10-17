// --- Quality report: pure classifiers ---
//
// Everything here is a pure function over a PR record so the definitions in
// docs/guides/quality-report.md can be unit-tested with fixture lists and no
// network. src/quality/github.ts fills the records; src/quality/report.ts
// aggregates them.

export interface PrRecord {
  number: number
  title: string
  body: string
  /** ISO timestamps. */
  createdAt: string
  mergedAt: string
  headRefName: string
  labels: string[]
  /** Changed file paths (the first 100 GitHub returns). */
  files: string[]
  /** The subset of `files` this PR adds (GitHub `changeType: ADDED`). */
  addedFiles?: string[]
  /** Issues this PR closes (`closingIssuesReferences`). */
  closingIssues: Array<{ number: number; createdAt: string }>
  /** Commit SHAs on the PR, used to find its CI runs. */
  commits: string[]
}

const HOUR = 3_600_000

/** A release-please PR: its fixed title, its branch, or its labels. */
export function isReleasePr(pr: Pick<PrRecord, "title" | "headRefName" | "labels">): boolean {
  if (/^chore(\([^)]*\))?!?:\s*release\b/i.test(pr.title)) return true
  if (pr.headRefName.startsWith("release-please--")) return true
  return pr.labels.some((l) => l.startsWith("autorelease:"))
}

/** An agent PR: not a release PR, and an `agent:*` label or a `claude/` branch. */
export function isAgentPr(pr: Pick<PrRecord, "title" | "headRefName" | "labels">): boolean {
  if (isReleasePr(pr)) return false
  return pr.headRefName.startsWith("claude/") || pr.labels.some((l) => l.startsWith("agent:"))
}

/** Written in a Claude cloud session, whose model cost is billed outside AgentX. */
export function isExternalPr(pr: Pick<PrRecord, "body">): boolean {
  return /claude\.ai\/code\/session_/i.test(pr.body || "")
}

/** A conventional-commit title of type `fix`: `fix:`, `fix(scope):`, `fix!:`. */
export function isFix(title: string): boolean {
  return /^fix(\([^)]*\))?!?:/i.test(title.trim())
}

/** Every `#N` (and `/pull/N` link) cited in the title or body, without the PR's own number. */
export function citedNumbers(pr: Pick<PrRecord, "number" | "title" | "body">): number[] {
  const text = `${pr.title}\n${pr.body || ""}`
  const out = new Set<number>()
  for (const m of text.matchAll(/(?:^|[^\w&/])#(\d+)\b/g)) out.add(Number(m[1]))
  for (const m of text.matchAll(/\/pull\/(\d+)\b/g)) out.add(Number(m[1]))
  out.delete(pr.number)
  return [...out]
}

// Phrases that say the change answers review feedback. A bare `reviewed` or
// `review` in passing ("reviewed the logs") is not enough.
const REVIEW_FEEDBACK = [
  /\b(?:address(?:es|ed|ing)?|answer(?:s|ed|ing)?|per|after|from|following)\s+(?:\S+\s+){0,2}?reviews?\b/i,
  /\breviews?\s+(?:feedback|comments?|findings?|notes?|requests?|items?|threads?|fix(?:es)?|follow-?ups?|on\s+#\d+)\b/i,
  /\breviewers?\s+(?:asked|requested|flagged|found|noted|spotted|caught|suggested|wanted|pointed)\b/i,
]

/** A fix whose title or description says it answers review feedback ("address review", "reviewer asked"…). */
export function mentionsReview(pr: Pick<PrRecord, "title" | "body">): boolean {
  const text = `${pr.title}\n${pr.body || ""}`
  return REVIEW_FEEDBACK.some(re => re.test(text))
}

/** A test file: anything under `test/`, a `*.test.*` file, or a `__fixtures__/` folder. */
export function isTestFile(f: string): boolean {
  return f.startsWith("test/") || /\.test\.[cm]?[jt]sx?$/.test(f) || f.includes("__fixtures__/")
}

/** Adds a test file. Nearly every fix edits a test, so only a new one says the fix came with new coverage. */
export function addsTest(pr: Pick<PrRecord, "addedFiles">): boolean {
  return (pr.addedFiles || []).some(isTestFile)
}

/** Changes a screen: the dashboard (`src/daemon/ui/`, `src/web/`, boards), or a native app (`apps/`). */
export function touchesUi(files: string[]): boolean {
  return files.some((f) =>
    f.startsWith("src/daemon/ui/") || f.startsWith("src/web/") || f.startsWith("src/boards/") ||
    f === "src/daemon/board-dashboard.ts" || f.startsWith("apps/"))
}

export interface RegressionHit {
  /** The cited PR merged at most 24 h before this fix merged. */
  within24h: boolean
  /** The cited PR merged at most 72 h before this fix merged. Includes the 24 h case. */
  within72h: boolean
  cited: number[]
}

/**
 * A regression fix is a fix that cites a PR merged at most 72 h before the
 * fix merged. `mergedAtByNumber` holds every merged PR known to the report,
 * release PRs included, from 72 h before the window onward.
 */
export function regressionOf(pr: PrRecord, mergedAtByNumber: Map<number, string>): RegressionHit {
  const none = { within24h: false, within72h: false, cited: [] }
  if (!isFix(pr.title)) return none
  const fixAt = Date.parse(pr.mergedAt)
  let best = Infinity
  const cited: number[] = []
  for (const n of citedNumbers(pr)) {
    const at = mergedAtByNumber.get(n)
    if (!at) continue
    const gap = fixAt - Date.parse(at)
    if (gap < 0 || gap > 72 * HOUR) continue
    cited.push(n)
    best = Math.min(best, gap)
  }
  if (!cited.length) return none
  return { within24h: best <= 24 * HOUR, within72h: true, cited }
}

/** The top-level `src/<dir>` with the most changed files; `other` when nothing is under `src/`. */
export function areaOf(files: string[]): string {
  const counts = new Map<string, number>()
  for (const f of files) {
    const parts = f.split("/")
    if (parts[0] !== "src" || parts.length < 2) continue
    const dir = parts.length === 2 ? "src" : parts[1]
    counts.set(dir, (counts.get(dir) || 0) + 1)
  }
  let area = "other"
  let max = 0
  for (const [dir, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > max) { area = dir; max = n }
  }
  return area
}

/** Lead time in hours: closing issue created → merged, or PR opened → merged when no issue is linked. */
export function leadTimeOf(pr: PrRecord): { kind: "issue" | "pr"; hours: number } | null {
  const merged = Date.parse(pr.mergedAt)
  const issueTimes = pr.closingIssues.map((i) => Date.parse(i.createdAt)).filter((t) => Number.isFinite(t))
  const kind = issueTimes.length ? "issue" : "pr"
  const start = issueTimes.length ? Math.min(...issueTimes) : Date.parse(pr.createdAt)
  const hours = (merged - start) / HOUR
  if (!Number.isFinite(hours) || hours < 0) return null
  return { kind, hours }
}

/** Monday (UTC) of the week the timestamp falls in, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
  return monday.toISOString().slice(0, 10)
}

/** Nearest-rank percentile (p in 0..100). Null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}
