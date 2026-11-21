// Start size per agent, from the trace ledger (#2002, checklist item 3).
// Reads the node's SQLite only; changes nothing. Run it before a start-context
// change and again after its deploy, with the same window length.
//
//   pnpm exec tsx scripts/start-size.ts --path <node>/.agentx/db.sqlite              # last 7 days
//   pnpm exec tsx scripts/start-size.ts --path <db> --since 2026-11-20T00:00Z --until 2026-11-22T00:00Z
//   pnpm exec tsx scripts/start-size.ts --path <db> --json
//
// start_tokens is the first main call's input + cache read + cache write of a
// fresh start (#2009); resumed turns have none.

import { resolve } from "node:path"
import Database from "better-sqlite3"
import { startSizes, startSizeTable, type StartRow } from "./start-size-lib"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function timeOf(spec: string | undefined, fallback: number): number {
  if (!spec) return fallback
  const m = spec.match(/^(\d+)d$/)
  if (m) return Date.now() - Number(m[1]) * 86_400_000
  const t = Date.parse(spec)
  if (Number.isNaN(t)) throw new Error(`takes 7d or an ISO date, not "${spec}"`)
  return t
}

const path = resolve(arg("path") ?? ".agentx/db.sqlite")
const since = timeOf(arg("since") ?? "7d", 0)
const until = timeOf(arg("until"), Date.now())
const db = new Database(path, { readonly: true, fileMustExist: true })
const rows = db.prepare(`
  SELECT agent_id, start_tokens FROM task_traces
  WHERE start_tokens IS NOT NULL AND started_at >= ? AND started_at < ?
`).all(since, until) as StartRow[]
db.close()

const sizes = startSizes(rows)
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ since: new Date(since).toISOString(), until: new Date(until).toISOString(), sizes }, null, 2))
} else {
  console.log(`Start size per agent, tokens, ${new Date(since).toISOString()} to ${new Date(until).toISOString()}\n`)
  console.log(sizes.length ? startSizeTable(sizes) : "No starts with a size in this window.")
}
