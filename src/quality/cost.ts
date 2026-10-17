import { existsSync } from "fs"
import { createRequire } from "module"
import { resolve } from "path"
import { TokenTracker } from "@/daemon/token-tracker"
import type { PrRecord } from "./classify"

// --- Quality report: model cost per PR ---
//
// Reads AgentX task traces (.agentx/db.sqlite, read-only) and charges each
// task to the PRs it BUILT. A task built a PR when one of its tool calls
//   - pushed the PR's head branch (`git push … <branch>`, a GitHub push or
//     file-write tool naming the branch), or
//   - opened the PR (`gh pr create` / a create-PR tool) and the result of
//     that call shows the PR's URL.
// A task that only mentions a PR, or replies on it, is not charged. A task
// that built several PRs is split evenly between them, so nothing is
// counted twice.
//
// PRs made in a Claude cloud session are billed outside AgentX. When such a
// PR has no AgentX match it is counted as `external`, not as unattributed.

export interface TaskCost {
  /** Inputs of the task's push and create-PR tool calls. */
  buildInputs: string[]
  /** PR numbers seen in the results of its create-PR calls. */
  openedPrs: number[]
  usd: number
}

/** Tool calls that build a PR: push a branch, write to one, or open the PR. */
export const BUILD_CALL_RE = /git\s+push|gh\s+pr\s+create|create_pull_request|push_files|create_or_update_file|"head"\s*:/i
const CREATE_CALL_RE = /gh\s+pr\s+create|create_pull_request/i

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The branch appears as a whole name: not as part of a longer branch. */
export function mentionsBranch(text: string, branch: string): boolean {
  if (!branch) return false
  return new RegExp(`(?<![\\w./-])${escapeRe(branch)}(?![\\w./-])`).test(text)
}

export function matchCosts(prs: PrRecord[], tasks: TaskCost[]): Map<number, number> {
  const numbers = new Set(prs.map((p) => p.number))
  const out = new Map<number, number>()
  for (const t of tasks) {
    const hits = new Set<number>(t.openedPrs.filter((n) => numbers.has(n)))
    // `main` and other shared branches never identify one PR.
    for (const pr of prs) {
      if (hits.has(pr.number) || pr.headRefName === "main" || pr.headRefName === "master") continue
      if (t.buildInputs.some((s) => mentionsBranch(s, pr.headRefName))) hits.add(pr.number)
    }
    if (!hits.size) continue
    const share = t.usd / hits.size
    for (const n of hits) out.set(n, (out.get(n) || 0) + share)
  }
  return out
}

/**
 * Costs of tasks with at least one build call, started between two epoch-ms
 * bounds. Null when there is no store, or SQLite cannot be opened here.
 */
export function readTaskCosts(dbPath: string, repo: string, fromMs: number, toMs: number): TaskCost[] | null {
  const path = resolve(process.cwd(), dbPath)
  if (!existsSync(path)) return null
  let db: any
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3")
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const cols = new Set((db.prepare("PRAGMA table_info(task_traces)").all() as Array<{ name: string }>).map((c) => c.name))
    if (!cols.size) return null
    const opt = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`)
    // Build calls first: the step ledger is far larger than the trace table.
    const calls = db.prepare(`
      SELECT s.task_id, s.seq, s.action, s.input_summary
      FROM task_trace_steps s JOIN task_traces t ON t.task_id = s.task_id
      WHERE t.started_at >= ? AND t.started_at <= ? AND s.name = 'tool_use'
        AND (s.input_summary LIKE '%push%' OR s.input_summary LIKE '%pr create%'
          OR s.input_summary LIKE '%"head"%' OR s.action LIKE '%pull_request%'
          OR s.action LIKE '%push_files%' OR s.action LIKE '%create_or_update_file%')
    `).all(fromMs, toMs) as Array<{ task_id: string; seq: number; action: string | null; input_summary: string | null }>
    const byTask = new Map<string, TaskCost>()
    const results = db.prepare(`
      SELECT output_summary FROM task_trace_steps
      WHERE task_id = ? AND seq > ? AND seq <= ? AND name = 'tool_result'
    `)
    const prUrl = new RegExp(`github\\.com/${escapeRe(repo)}/pull/(\\d+)`, "g")
    for (const c of calls) {
      // The tool name carries MCP calls (create_pull_request, push_files).
      const input = `${c.action || ""} ${c.input_summary || ""}`
      if (!BUILD_CALL_RE.test(input)) continue
      const t = byTask.get(c.task_id) || { buildInputs: [], openedPrs: [], usd: 0 }
      t.buildInputs.push(input)
      if (CREATE_CALL_RE.test(input)) {
        // The result rows right after the call; parallel calls can interleave.
        for (const r of results.all(c.task_id, c.seq, c.seq + 3) as Array<{ output_summary: string | null }>) {
          for (const m of (r.output_summary || "").matchAll(prUrl)) t.openedPrs.push(Number(m[1]))
        }
      }
      byTask.set(c.task_id, t)
    }
    if (!byTask.size) return []

    const traces = db.prepare(`
      SELECT task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
             ${opt("tier2_input_tokens")}, ${opt("tier2_output_tokens")},
             ${opt("tier2_cache_read_tokens")}, ${opt("tier2_cache_create_tokens")}
      FROM task_traces WHERE started_at >= ? AND started_at <= ?
    `).all(fromMs, toMs) as any[]
    for (const r of traces) {
      const t = byTask.get(r.task_id)
      if (!t) continue
      t.usd = TokenTracker.calculateCost({
        inputTokens: r.input_tokens || 0,
        outputTokens: r.output_tokens || 0,
        cacheReadTokens: r.cache_read_tokens || 0,
        cacheCreateTokens: r.cache_create_tokens || 0,
        tier2InputTokens: r.tier2_input_tokens || 0,
        tier2OutputTokens: r.tier2_output_tokens || 0,
        tier2CacheReadTokens: r.tier2_cache_read_tokens || 0,
        tier2CacheCreateTokens: r.tier2_cache_create_tokens || 0,
      } as any, r.model || undefined)
    }
    return [...byTask.values()]
  } catch {
    // An old store without the step ledger: no attribution, not a crash.
    return null
  } finally {
    db.close()
  }
}
