// How agents use `wiki query`, from the trace ledger (#1820). Reads the
// node's SQLite only; changes nothing.
//
//   pnpm exec tsx scripts/wiki-query-report.ts --path <node>/.agentx/db.sqlite   # last 7 days
//   pnpm exec tsx scripts/wiki-query-report.ts --since 30d --json
//   pnpm exec tsx scripts/wiki-query-report.ts --sample 30 --out ~/wiki-grading.json
//
// --sample writes past questions for a graded sample, ready for
// `agentx wiki score --questions <file>` once each `expect` is filled in.
// That file holds real questions: keep it out of the repository.

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import Database from "better-sqlite3"
import { gradingSample, summariseUsage, wikiCalls, type StepRow, type TaskRow } from "./wiki-query-usage-lib"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function sinceMs(spec: string): number {
  const m = spec.match(/^(\d+)d$/)
  if (m) return Date.now() - Number(m[1]) * 86_400_000
  const t = Date.parse(spec)
  if (Number.isNaN(t)) throw new Error(`--since takes 7d or an ISO date, not "${spec}"`)
  return t
}

export function readLedger(db: Database.Database, since: number): { tasks: TaskRow[]; steps: StepRow[] } {
  const tasks = db.prepare(`
    SELECT task_id, agent_id, started_at, COALESCE(final_session_id, resume_session_id) AS session
    FROM task_traces WHERE started_at >= ?
  `).all(since) as TaskRow[]
  // Steps only for turns that touched the wiki: the ledger is large.
  const steps = db.prepare(`
    SELECT s.task_id, s.seq, s.name, s.action, s.status, s.input_summary, s.output_summary
    FROM task_trace_steps s
    WHERE s.task_id IN (
      SELECT DISTINCT s2.task_id FROM task_trace_steps s2 JOIN task_traces t ON t.task_id = s2.task_id
      WHERE t.started_at >= ? AND s2.name = 'tool_use' AND (
        s2.action LIKE '%agentx_wiki_query' OR s2.action LIKE '%agentx_lookup' OR s2.action LIKE '%agentx_wiki_patch'
        OR (s2.action = 'Bash' AND s2.input_summary LIKE '%wiki query%')
      )
    )
    ORDER BY s.task_id, s.seq
  `).all(since) as StepRow[]
  return { tasks, steps }
}

function main(): void {
  const path = resolve(process.cwd(), arg("path") ?? ".agentx/db.sqlite")
  const since = sinceMs(arg("since") ?? "7d")
  const db = new Database(path, { readonly: true, fileMustExist: true })
  const { tasks, steps } = readLedger(db, since)
  const calls = wikiCalls(tasks, steps)
  const report = summariseUsage(tasks, calls)

  const sample = arg("sample")
  if (sample) {
    const out = arg("out")
    if (!out) throw new Error("--sample needs --out <file> (outside the repository)")
    writeFileSync(out, JSON.stringify(gradingSample(calls, Number(sample) || 30), null, 2))
    console.error(`wrote ${out}`)
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ since: new Date(since).toISOString(), ...report }, null, 2))
    return
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-")
  const queries = report.calls.tool + report.calls.cli
  console.log(`since ${new Date(since).toISOString()}`)
  console.log(`turns ${report.turns} · with a wiki query ${report.turnsWithQuery} (${pct(report.turnsWithQuery, report.turns)})`)
  console.log(`sessions ${report.sessions} · with a wiki query ${report.sessionsWithQuery} (${pct(report.sessionsWithQuery, report.sessions)})`)
  console.log(`calls: tool ${report.calls.tool} · cli ${report.calls.cli} · lookup ${report.calls.lookup} · patch ${report.calls.patch}`)
  console.log(`queries failed ${report.failed}/${queries - report.unpaired} (${pct(report.failed, queries - report.unpaired)}) · no result found ${report.unpaired} · median result ${report.resultCharsP50} chars`)
  console.log(`outcomes: ${Object.entries(report.outcomes).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
  console.log(`after an answer: ${Object.entries(report.nextAfterAnswer).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
  console.log("\nagent                     turns  asked  queries  failed")
  for (const a of report.byAgent) console.log(`${a.agent.padEnd(24)} ${String(a.turns).padStart(6)} ${String(a.turnsWithQuery).padStart(6)} ${String(a.queries).padStart(8)} ${String(a.failed).padStart(7)}`)
  console.log("\nday          turns  asked  queries")
  for (const d of report.byDay) console.log(`${d.day}  ${String(d.turns).padStart(6)} ${String(d.turnsWithQuery).padStart(6)} ${String(d.queries).padStart(8)}`)
}

if (process.argv[1] && /wiki-query-report\.ts$/.test(process.argv[1])) main()
