import chalk from "chalk"
import type { GroupStats, LessonImpact } from "@/storage/lesson-impact"

// Rendering for `agentx trace lessons` (#98). Kept apart from trace.ts so the
// report's layout can be tested without a database or a terminal.

function fmtTokens(n: number | null): string {
  if (n == null) return "—"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—"
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`
}

function fmtTurns(n: number | null): string {
  return n == null ? "—" : Number.isInteger(n) ? `${n}` : n.toFixed(1)
}

/** "-26%" when after is lower than before, "+12%" when higher, "" when either is unknown. */
export function change(before: number | null, after: number | null): string {
  if (before == null || after == null || before === 0) return ""
  const pct = Math.round(((after - before) / before) * 100)
  return pct === 0 ? " (=)" : ` (${pct > 0 ? "+" : ""}${pct}%)`
}

function statsLine(label: string, s: GroupStats, base?: GroupStats): string {
  const ok = `${Math.round(s.successRate * 100)}%`
  const okChange = base ? ` (${s.successRate >= base.successRate ? "+" : ""}${Math.round((s.successRate - base.successRate) * 100)} pts)` : ""
  return [
    `    ${label.padEnd(6)} n=${String(s.n).padEnd(4)}`,
    `success ${ok}${okChange}`,
    `tokens ${fmtTokens(s.medianTokens)}${base ? change(base.medianTokens, s.medianTokens) : ""}`,
    `turns ${fmtTurns(s.medianTurns)}${base ? change(base.medianTurns, s.medianTurns) : ""}`,
    `time ${fmtDuration(s.medianDurationMs)}${base ? change(base.medianDurationMs, s.medianDurationMs) : ""}`,
  ].join("  ")
}

export function renderLessonImpact(rows: LessonImpact[], opts: { minSamples: number }): string[] {
  if (rows.length === 0) {
    return [
      chalk.dim(`  No lesson has at least ${opts.minSamples} recorded task(s) before and after it yet.`),
      chalk.dim("  Tasks record which lessons they used from this version on; repeated tasks need time to build up."),
    ]
  }
  const out: string[] = []
  let heading = ""
  for (const r of rows) {
    const h = `${r.agentId}  ${r.cluster}`
    if (h !== heading) {
      if (heading) out.push("")
      out.push(`${chalk.bold(r.agentId)}  ${chalk.cyan(r.cluster)}`)
      heading = h
    }
    out.push(`  ${chalk.yellow(r.lesson)}  ${chalk.dim(`first used ${new Date(r.addedAt).toISOString().slice(0, 10)}`)}`)
    out.push(chalk.dim(statsLine("before", r.before)))
    out.push(statsLine("after", r.after, r.before))
  }
  out.push("")
  out.push(chalk.dim("  Medians per task. Small samples are noisy: treat a change as a hint until n grows."))
  return out
}
