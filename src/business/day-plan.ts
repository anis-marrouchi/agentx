import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { resolve, dirname } from "path"

// --- Day / week / month plans for the business standup-tick ---
//
// A plan is a markdown file:
//   .agentx/plans/2026-05-04.md            — day  (highest priority)
//   .agentx/plans/2026-W18.md              — week (Mon-Sun ISO week)
//   .agentx/plans/2026-05.md               — month (yyyy-mm)
//
// fireStandup() loads the most-specific plan that exists. If none exists, the
// standup tick posts a "no plan today" notification to the main channel and
// dispatches no agent — the explicit anti-mechanical-burn rule.
//
// Files are plain markdown so operators can edit them on disk, in the admin
// panel, or via the CLI. We keep the bulleted "priorities" convention loose
// (any markdown is valid) but expose a parsePriorities() helper that the
// standup prompt uses to extract a clean list when the format is regular.

export type PlanTier = "day" | "week" | "month"

export interface ResolvedPlan {
  tier: PlanTier
  date: string          // the file slug (YYYY-MM-DD | YYYY-Wnn | YYYY-MM)
  path: string          // absolute path on disk
  content: string       // raw markdown
}

export class DayPlanStore {
  constructor(private plansDir: string, private cwd: string = process.cwd()) {}

  private absDir(): string {
    return resolve(this.cwd, this.plansDir)
  }

  private slug(tier: PlanTier, date: Date): string {
    if (tier === "day") return date.toISOString().slice(0, 10)
    if (tier === "month") return date.toISOString().slice(0, 7)
    // ISO week (Mon=1..Sun=7) — same convention git/most calendars use.
    const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    const dayNum = t.getUTCDay() || 7
    t.setUTCDate(t.getUTCDate() + 4 - dayNum)
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
    const weekNum = Math.ceil((((+t - +yearStart) / 86400000) + 1) / 7)
    return `${t.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`
  }

  private absPath(tier: PlanTier, date: Date): string {
    return resolve(this.absDir(), `${this.slug(tier, date)}.md`)
  }

  /** Load the most-specific plan that exists for `date` (day → week → month).
   *  Returns null if no plan is set at any tier. */
  resolve(date: Date = new Date()): ResolvedPlan | null {
    for (const tier of ["day", "week", "month"] as const) {
      const path = this.absPath(tier, date)
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8")
        if (content.trim()) {
          return { tier, date: this.slug(tier, date), path, content }
        }
      }
    }
    return null
  }

  /** Read a specific tier's plan (or null if not set). Used by the CLI's
   *  `plan show` and the admin form's pre-fill. */
  read(tier: PlanTier, date: Date = new Date()): ResolvedPlan | null {
    const path = this.absPath(tier, date)
    if (!existsSync(path)) return null
    const content = readFileSync(path, "utf-8")
    return { tier, date: this.slug(tier, date), path, content }
  }

  /** Write a plan at the given tier. Empty `content` removes the plan
   *  (same end-state as no file). Schema-validated by the caller. */
  write(tier: PlanTier, content: string, date: Date = new Date()): ResolvedPlan {
    const path = this.absPath(tier, date)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content.endsWith("\n") ? content : content + "\n")
    return { tier, date: this.slug(tier, date), path, content }
  }

  /** Recent plans across all tiers, newest first. Used by `plan list` and
   *  the admin form sidebar. */
  list(limit = 30): Array<{ tier: PlanTier; date: string; path: string }> {
    const dir = this.absDir()
    if (!existsSync(dir)) return []
    const out: Array<{ tier: PlanTier; date: string; path: string; sortKey: string }> = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const slug = name.slice(0, -3)
      let tier: PlanTier
      let sortKey: string
      if (/^\d{4}-\d{2}-\d{2}$/.test(slug)) { tier = "day"; sortKey = slug }
      else if (/^\d{4}-W\d{2}$/.test(slug)) { tier = "week"; sortKey = slug.replace("-W", "-") }
      else if (/^\d{4}-\d{2}$/.test(slug)) { tier = "month"; sortKey = slug }
      else continue
      out.push({ tier, date: slug, path: resolve(dir, name), sortKey })
    }
    out.sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    return out.slice(0, limit).map(({ tier, date, path }) => ({ tier, date, path }))
  }
}

/** Best-effort priorities extractor — pulls "- " / "* " / "1. " bullets out
 *  of the plan markdown. Used to build a structured prompt context, but not
 *  authoritative: the full markdown is also passed to the standup so any
 *  free-form notes the operator wrote are preserved. */
export function parsePriorities(content: string): string[] {
  const out: string[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    const m = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/)
    if (m) out.push(m[1].trim())
  }
  return out
}
