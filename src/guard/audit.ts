import { resolve, join } from "path"
import { openDb } from "@/storage/sqlite"
import { newEventId } from "@/intent/ulid"
import type { GuardInput, Verdict } from "./types"
import type { GuardMode } from "./types"

// --- Guardrail audit (PRD R7) ---
//
// Every guard verdict is recorded in the `guardrail_decisions` table in the
// observability db (`.agentx/db.sqlite`). The row is written by the
// short-lived hook process, so we resolve the db against the daemon's install
// ROOT (not the agent workspace cwd) and set a busy_timeout so a concurrent
// daemon write doesn't lose the audit row.

export interface AuditInput {
  root: string
  input: GuardInput
  verdict: Verdict
  mode: GuardMode
  taskId?: string | null
  approver?: string | null
  ms?: number | null
}

const COMMAND_CAP = 4000

/** Write one guard decision. Best-effort and never throws — an audit failure
 *  must not change whether the command runs (the verdict is already decided).
 *  Returns the row id, or null when the db couldn't be opened. */
export function recordDecision(a: AuditInput): string | null {
  try {
    const dbPath = join(resolve(a.root), ".agentx", "db.sqlite")
    const db = openDb({ path: dbPath })
    if (!db) return null
    try {
      db.pragma("busy_timeout = 3000")
    } catch {
      /* pragma best-effort */
    }
    const id = newEventId()
    const cmd = a.input.command ? a.input.command.slice(0, COMMAND_CAP) : a.input.filePath ?? null
    db.prepare(
      `INSERT INTO guardrail_decisions
        (id, ts, agent_id, task_id, tool, command, resolved_target, matched_rule,
         verdict, effective_action, mode, severity, approver, ms)
       VALUES (@id, @ts, @agent_id, @task_id, @tool, @command, @resolved_target, @matched_rule,
         @verdict, @effective_action, @mode, @severity, @approver, @ms)`,
    ).run({
      id,
      ts: Date.now(),
      agent_id: a.input.agentId ?? null,
      task_id: a.taskId ?? null,
      tool: a.input.tool,
      command: cmd,
      resolved_target: a.verdict.resolvedTarget,
      matched_rule: a.verdict.ruleId,
      verdict: a.verdict.action,
      effective_action: a.verdict.effectiveAction,
      mode: a.mode,
      severity: a.verdict.severity,
      approver: a.approver ?? null,
      ms: a.ms ?? null,
    })
    return id
  } catch (e: any) {
    process.stderr.write(`[agentx-guard] audit write failed: ${e?.message}\n`)
    return null
  }
}

export interface DecisionRow {
  id: string
  ts: number
  agent_id: string | null
  task_id: string | null
  tool: string
  command: string | null
  resolved_target: string | null
  matched_rule: string | null
  verdict: string
  effective_action: string
  mode: string | null
  severity: string | null
  approver: string | null
  ms: number | null
}

export interface ListDecisionsFilters {
  root: string
  limit?: number
  verdict?: string
  agentId?: string
  taskId?: string
}

/** Read recent decisions (newest first) for `agentx guard log`. */
export function listDecisions(f: ListDecisionsFilters): DecisionRow[] {
  const dbPath = join(resolve(f.root), ".agentx", "db.sqlite")
  const db = openDb({ path: dbPath })
  if (!db) return []
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.verdict) {
    where.push("verdict = @verdict")
    params.verdict = f.verdict
  }
  if (f.agentId) {
    where.push("agent_id = @agentId")
    params.agentId = f.agentId
  }
  if (f.taskId) {
    where.push("task_id = @taskId")
    params.taskId = f.taskId
  }
  const sql =
    `SELECT * FROM guardrail_decisions` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ts DESC LIMIT @limit`
  params.limit = f.limit ?? 50
  return db.prepare(sql).all(params) as DecisionRow[]
}
