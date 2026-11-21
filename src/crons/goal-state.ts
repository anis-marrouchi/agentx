import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { basename, dirname, resolve } from "path"
import { findConfigPath } from "@/daemon/config-mutator"

// --- Per-job goal-check state (#863) ---
//
// What the daemon keeps about a schedule's goal check, out of agentx.json
// so a write here never reloads the daemon: whether the job is held on a
// goal check (and the card that asks the operator), a change the operator
// asked for that the owner still owes, when the operator last said keep,
// the owner's own last verdict, and the one-time lines the Wall shows.
//
// agentx.json keeps only config plus `enabled`, `endedAt` and
// `approvedSchedule`. One JSON file, written whole and atomically, read by
// the daemon, the CLI and the agent tool (separate processes).

export type GoalCheckReason = "closed" | "no-movement" | "drop-answered"
export type GoalChoice = "keep" | "change" | "drop"
export const GOAL_CHOICES: readonly GoalChoice[] = ["keep", "change", "drop"]

export interface GoalCheckState {
  /** The goal record the check is about. */
  goalId: string
  /** ISO time the job went on goal check. */
  since: string
  reason: GoalCheckReason
  /** Days without movement, for "no-movement". */
  days?: number
  /** The card that asks the operator keep / change / drop. */
  cardId?: string
  /** ISO time the owner was woken for its recommendation (once). */
  askedAt?: string
  /** The owner's recommendation, from agentx_schedule recommend. */
  recommend?: { choice: GoalChoice; why: string; at: string }
  /** The last refused card raise: retried at the next fire, no new wake. */
  refused?: { error: string; at: string }
  /** ISO time the operator answered drop (reason "drop-answered"). */
  droppedAt?: string
}

export interface ChangeOwed {
  /** The answer time: a ledger row from the owner after it clears this. */
  since: string
  cardId: string
  note?: string
  /** Set once the 7-day escalation (Wall line + owner wake) went out. */
  escalatedAt?: string
}

export interface JobGoalState {
  goalCheck?: GoalCheckState
  changeOwed?: ChangeOwed
  /** ISO time of the operator's last keep or change answer. */
  goalKeptAt?: string
  /** One line the owner wrote about the job (agentx_schedule verdict). */
  lastVerdict?: { text: string; at: string; by: string }
  /** One-time Wall lines, by key. */
  notes?: Record<string, { text: string; at: string }>
}

export interface CronGoalStateFile {
  jobs: Record<string, JobGoalState>
}

/** The node's root (where `.agentx/` lives) for a config path. */
export function rootOfConfig(configPath?: string): string {
  const path = findConfigPath(configPath)
  const dir = dirname(path)
  return basename(dir) === ".agentx" ? dirname(dir) : dir
}

export function cronGoalStatePath(root: string): string {
  return resolve(root, ".agentx", "state", "cron-goal.json")
}

export function readCronGoalState(root: string): CronGoalStateFile {
  const path = cronGoalStatePath(root)
  if (!existsSync(path)) return { jobs: {} }
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  return { jobs: raw && typeof raw.jobs === "object" && raw.jobs ? raw.jobs : {} }
}

/** One job's state; empty when the file has none (or cannot be read). */
export function jobGoalState(root: string, jobId: string, log?: (msg: string) => void): JobGoalState {
  try {
    return readCronGoalState(root).jobs[jobId] ?? {}
  } catch (e: any) {
    log?.(`[cron-goal] state file unreadable: ${e?.message ?? e}`)
    return {}
  }
}

/** Change one job's state and write the file whole. An empty state is
 *  dropped. Throws when the file cannot be read or written. */
export function updateJobGoalState(root: string, jobId: string, fn: (s: JobGoalState) => JobGoalState | void): JobGoalState {
  const file = readCronGoalState(root)
  const cur: JobGoalState = structuredClone(file.jobs[jobId] ?? {})
  const next = fn(cur) ?? cur
  const empty = Object.values(next).every((v) => v === undefined || (typeof v === "object" && v !== null && Object.keys(v).length === 0))
  if (empty) delete file.jobs[jobId]
  else file.jobs[jobId] = next
  const path = cronGoalStatePath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n")
  renameSync(tmp, path)
  return next
}

/** Set a one-time Wall line. False when it was already there. */
export function addNote(s: JobGoalState, key: string, text: string, at: string): boolean {
  if (s.notes?.[key]?.text === text) return false
  s.notes = { ...(s.notes ?? {}), [key]: { text, at } }
  return true
}

export function dropNote(s: JobGoalState, key: string): void {
  if (!s.notes?.[key]) return
  const { [key]: _gone, ...rest } = s.notes
  s.notes = Object.keys(rest).length ? rest : undefined
}

const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "?")

/** The Wall lines for one job: its goal-check state, then its notes. */
export function goalWallLines(s: JobGoalState, owner: string): string[] {
  const lines: string[] = []
  const g = s.goalCheck
  if (g?.reason === "drop-answered") lines.push(`drop answered ${day(g.droppedAt)}; retired`)
  else if (g?.cardId) lines.push(`on goal check: waiting on the operator since ${day(g.since)} (card ${g.cardId})`)
  else if (g) lines.push(`on goal check since ${day(g.since)}: goal ${g.goalId} ${g.reason === "closed" ? "closed" : `no movement for ${g.days ?? "30+"} days`}`)
  if (s.changeOwed) lines.push(`change owed by ${owner} since ${day(s.changeOwed.since)}`)
  for (const n of Object.values(s.notes ?? {})) lines.push(n.text)
  return lines
}
