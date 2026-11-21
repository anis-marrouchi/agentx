import type Database from "better-sqlite3"
import { listCards, readCard, type DecisionCard } from "@/approvals/cards"
import type { MovementReader } from "@/requests/checkers/issue-movement"
import { ownerChangedSince } from "./change-ledger"
import { applyGoalAnswer, type GoalAnswerDeps } from "./goal-answer"
import { raiseGoalCard, RECOMMEND_WAIT_MS } from "./goal-card"
import { cronRunWindows, daysStill, lastMovementAt, NO_MOVEMENT_DAYS, type MovementCache } from "./goal-movement"
import { addNote, dropNote, jobGoalState, readCronGoalState, updateJobGoalState, type ChangeOwed, type GoalCheckState, type JobGoalState } from "./goal-state"

// --- A schedule's goal check, at each fire and on the minute tick (#863) ---
//
// Before a job with a goal runs its brief, the daemon asks:
//   1. Is a decided answer on its goal card not applied yet? Apply it now
//      (the fallback of the decided-card notice loop).
//   2. Was it answered drop? Then it is retired and never runs.
//   3. Does its owner owe a change the operator asked for? Hold until the
//      owner's ledger row; after 7 days, one Wall line and one owner wake.
//   4. Is it on goal check? Hold. Raise the card when it is due (the
//      owner's recommendation came, 2 h passed, or a refusal is retried).
//   5. Otherwise, on the operator's node only, and not within 30 days of
//      the operator's last keep or change: is its goal record done or
//      dropped, or has the record's issue not moved for 30 days? Then put
//      it on goal check and wake the owner ONCE for its recommendation.
//
// A failed forge read never counts as "no movement": the job runs, with
// one Wall line. Paused jobs never fire, so they are not evaluated.

export const KEEP_DAYS = 30
export const CHANGE_OWED_ESCALATE_DAYS = 7
const DAY_MS = 86_400_000

export interface GoalRecordView {
  state: string
  check: { kind: string; provider?: "github" | "gitlab"; ref?: string } | null
  createdAt: number
}

export interface GoalCheckDeps {
  root: string
  configPath?: string
  /** Where run records live (.agentx/cron/runs). */
  runsDir: string
  now: () => number
  log: (msg: string) => void
  /** The goal record by id; null when this node has none. */
  goal: (id: string) => GoalRecordView | null
  movement?: MovementReader
  /** Recent good reads, so a job that runs often does not call the tracker each time. */
  movementCache?: MovementCache
  /** Null on the operator's node; else the name of the operator's node. */
  operatorNode: () => string | null
  /** A turn on the owner agent. Resolves when that run ends. */
  wake: (agentId: string, text: string, chatId: string) => Promise<void>
  ledger?: () => Database.Database | null
}

export interface GoalJob { id: string; agent: string; goal?: string }

export type FireGate =
  | { hold: null; kept: boolean }
  | { hold: string; retired?: boolean }

const iso = (ms: number) => new Date(ms).toISOString()
const day = (s: string | undefined) => (s ? s.slice(0, 10) : "?")

function answerDeps(deps: GoalCheckDeps): GoalAnswerDeps {
  return { root: deps.root, configPath: deps.configPath, now: deps.now, log: deps.log, ledger: deps.ledger }
}

/** Change a job's state, logging a failed write. False when it failed. */
function update(deps: GoalCheckDeps, jobId: string, fn: (s: JobGoalState) => void): boolean {
  try {
    updateJobGoalState(deps.root, jobId, fn)
    return true
  } catch (e: any) {
    deps.log(`[cron-goal] "${jobId}": state not written: ${e?.message ?? e}`)
    return false
  }
}

/** The card of this goal check: by its saved id, else one with its origin
 *  raised since the check began (the id write may have failed). */
export function findGoalCard(root: string, jobId: string, g: GoalCheckState): DecisionCard | undefined {
  if (g.cardId) return readCard(root, g.cardId) ?? undefined
  return listCards(root).find((c) => c.origin?.kind === "cron-goal" && c.origin.jobId === jobId && c.origin.goalId === g.goalId && c.created_at >= g.since)
}

export function recommendText(job: GoalJob, g: GoalCheckState): string {
  const what = g.reason === "closed" ? "is closed (done or dropped)" : `has not moved for ${g.days ?? NO_MOVEMENT_DAYS} days`
  return [
    `[Goal check] Your schedule "${job.id}" is on goal check: its goal ${g.goalId} ${what}. It does not run until the operator answers a Keep / Change / Drop card.`,
    `Give your recommendation now, once: agentx_schedule {action:"recommend", id:"${job.id}", choice:"keep"|"change"|"drop", why:"<one line>"}.`,
    "The card goes to the operator when this turn ends, with your recommendation or with none. Do nothing else for this job now.",
  ].join("\n")
}

function changeOwedText(job: GoalJob, owed: ChangeOwed): string {
  return [
    `[Goal check] The operator answered change on your schedule "${job.id}" (card ${owed.cardId}) on ${day(owed.since)}${owed.note ? `: "${owed.note}"` : ""}. The change is still not made after ${CHANGE_OWED_ESCALATE_DAYS} days.`,
    `The job does not run until you make it: agentx_schedule {action:"change", id:"${job.id}", reason, and prompt, when, goal or value}, or {action:"retire", id:"${job.id}", reason}.`,
  ].join("\n")
}

/** Raise the card once the owner's turn ends, whatever its outcome. */
function wakeForRecommendation(job: GoalJob, g: GoalCheckState, deps: GoalCheckDeps): void {
  void deps.wake(job.agent, recommendText(job, g), `cron-goal:${job.id}`)
    .catch((e: any) => deps.log(`[cron-goal] "${job.id}": owner wake failed: ${e?.message ?? e}; the card goes up 2 h after the ask`))
    .then(() => { raiseGoalCard(deps.root, job, { now: deps.now(), log: deps.log }) })
    .catch((e: any) => deps.log(`[cron-goal] "${job.id}": card raise failed: ${e?.message ?? e}`))
}

/** Whether the owner wrote a row that pays off the change it owes. */
function changePaid(job: GoalJob, owed: ChangeOwed, deps: GoalCheckDeps): boolean {
  try {
    const db = deps.ledger?.()
    return !!db && ownerChangedSince(db, job.id, job.agent, Date.parse(owed.since))
  } catch (e: any) {
    deps.log(`[cron-goal] "${job.id}": change log not read: ${e?.message ?? e}`)
    return false
  }
}

/** The changeOwed rule: null once paid (cleared), else why the job holds. */
function changeOwedGate(job: GoalJob, owed: ChangeOwed, deps: GoalCheckDeps, now: number): string | null {
  if (changePaid(job, owed, deps)) {
    update(deps, job.id, (s) => { delete s.changeOwed })
    deps.log(`[cron-goal] "${job.id}": change made by ${job.agent}; runs again`)
    return null
  }
  if (!owed.escalatedAt && now - Date.parse(owed.since) >= CHANGE_OWED_ESCALATE_DAYS * DAY_MS) {
    const at = iso(now)
    const wrote = update(deps, job.id, (s) => {
      if (!s.changeOwed) return
      s.changeOwed.escalatedAt = at
      addNote(s, "change-owed-late", `change owed by ${job.agent} on ${job.id} for ${CHANGE_OWED_ESCALATE_DAYS}+ days`, at)
    })
    // Only once the escalation is recorded: never a second wake.
    if (wrote) {
      void deps.wake(job.agent, changeOwedText(job, owed), `cron-goal:${job.id}`)
        .catch((e: any) => deps.log(`[cron-goal] "${job.id}": owner wake failed: ${e?.message ?? e}`))
    }
  }
  return `change owed by ${job.agent} since ${day(owed.since)}`
}

/** Why a job on goal check holds; raises its card when that is due. */
function holdOnGoalCheck(job: GoalJob, g: GoalCheckState, deps: GoalCheckDeps, now: number): FireGate {
  if (g.cardId) return { hold: `on goal check: waiting on the operator since ${day(g.since)} (card ${g.cardId})` }
  if (!g.askedAt) {
    // Never asked (state from before askedAt): ask now, once.
    const at = iso(now)
    if (update(deps, job.id, (s) => { if (s.goalCheck) s.goalCheck.askedAt = at })) wakeForRecommendation(job, { ...g, askedAt: at }, deps)
  } else if (g.refused || g.recommend || now - Date.parse(g.askedAt) >= RECOMMEND_WAIT_MS) {
    // A refused raise is retried here, at the next fire, with no new wake.
    raiseGoalCard(deps.root, job, { now, log: deps.log })
  }
  return { hold: `on goal check since ${day(g.since)}: waiting for the owner's recommendation` }
}

/** The goal check's finding on a job not held: a reason, or null to run. */
async function evaluateGoal(job: GoalJob & { goal: string }, s: JobGoalState, deps: GoalCheckDeps, now: number): Promise<Pick<GoalCheckState, "reason" | "days"> | null> {
  let rec: GoalRecordView | null = null
  try { rec = deps.goal(job.goal) } catch (e: any) { deps.log(`[cron-goal] goal ${job.goal} not read: ${e?.message ?? e}`) }
  if (!rec) return null
  if (rec.state === "done" || rec.state === "dropped") return { reason: "closed" }
  const check = rec.check
  if (check?.kind !== "issue" || !check.provider || !check.ref) {
    update(deps, job.id, (st) => { addNote(st, "no-issue", `goal ${job.goal} has no issue to watch`, iso(now)) })
    return null
  }
  if (!deps.movement) return null
  const windows = cronRunWindows(deps.runsDir, job.id, now - (NO_MOVEMENT_DAYS + 1) * DAY_MS, deps.log)
  const kept = s.goalKeptAt ? Date.parse(s.goalKeptAt) : null
  const createdAt = rec.createdAt
  const still = (times: number[]) => daysStill(now, [lastMovementAt(times, windows), kept, createdAt])
  // A recent read that says "moving" lets the job run with no tracker call;
  // a hold is only ever decided on a fresh read (#2065).
  const key = `${check.provider}:${check.ref}`
  const cached = deps.movementCache?.get(key, now)
  if (cached && still(cached) < NO_MOVEMENT_DAYS) return null
  const read = await deps.movement(check.provider, check.ref)
  if (!read.ok) {
    update(deps, job.id, (st) => { addNote(st, "read-failed", `goal check could not read ${job.goal}: ${read.error}`, iso(now)) })
    return null
  }
  deps.movementCache?.set(key, now, read.times)
  if (s.notes?.["read-failed"] || s.notes?.["no-issue"]) update(deps, job.id, (st) => { dropNote(st, "read-failed"); dropNote(st, "no-issue") })
  const days = still(read.times)
  return days >= NO_MOVEMENT_DAYS ? { reason: "no-movement", days } : null
}

/** The goal check at a fire: hold the run (and why), or let it run. `kept`:
 *  the operator kept the job within 30 days, so a closed goal does not
 *  skip it either. */
export async function goalCheckAtFire(job: GoalJob, deps: GoalCheckDeps): Promise<FireGate> {
  const now = deps.now()
  let s = jobGoalState(deps.root, job.id, deps.log)
  if (s.goalCheck) {
    const card = findGoalCard(deps.root, job.id, s.goalCheck)
    if (card?.status === "decided") {
      await applyGoalAnswer(card, answerDeps(deps))
      s = jobGoalState(deps.root, job.id, deps.log)
    }
  }
  const g = s.goalCheck
  if (g?.reason === "drop-answered") return { hold: `the operator answered drop on ${day(g.droppedAt)}: retired`, retired: true }
  if (s.changeOwed) {
    const held = changeOwedGate(job, s.changeOwed, deps, now)
    if (held) return { hold: held }
  }
  if (g) return holdOnGoalCheck(job, g, deps, now)
  if (!job.goal) return { hold: null, kept: false }
  const away = deps.operatorNode()
  if (away) {
    update(deps, job.id, (st) => { addNote(st, "other-node", `goal check runs on ${away} only`, iso(now)) })
    return { hold: null, kept: false }
  }
  if (s.goalKeptAt && now - Date.parse(s.goalKeptAt) < KEEP_DAYS * DAY_MS) return { hold: null, kept: true }
  const found = await evaluateGoal({ ...job, goal: job.goal }, s, deps, now)
  if (!found) return { hold: null, kept: false }
  const at = iso(now)
  const check: GoalCheckState = { goalId: job.goal, since: at, reason: found.reason, ...(found.days !== undefined ? { days: found.days } : {}), askedAt: at }
  // askedAt goes in the same write as the check: the owner is woken once.
  if (!update(deps, job.id, (st) => { st.goalCheck = check })) return { hold: "goal check state not written; checked again at the next fire" }
  deps.log(`[cron-goal] "${job.id}": on goal check (${found.reason === "closed" ? `goal ${job.goal} closed` : `no movement for ${found.days} days`}); asking ${job.agent}`)
  wakeForRecommendation(job, check, deps)
  return { hold: `on goal check since ${day(at)}: waiting for the owner's recommendation` }
}

/** The daemon's minute tick: a card 2 h after the ask (the owner's run may
 *  never start), and the changeOwed rule for jobs that seldom fire. */
export function goalCheckTick(jobs: GoalJob[], deps: GoalCheckDeps): void {
  let all: Record<string, JobGoalState>
  try { all = readCronGoalState(deps.root).jobs } catch (e: any) { deps.log(`[cron-goal] state file unreadable: ${e?.message ?? e}`); return }
  const now = deps.now()
  for (const job of jobs) {
    const s = all[job.id]
    if (!s) continue
    const g = s.goalCheck
    if (g && !g.cardId && g.reason !== "drop-answered" && g.askedAt && !g.refused && now - Date.parse(g.askedAt) >= RECOMMEND_WAIT_MS) {
      raiseGoalCard(deps.root, job, { now, log: deps.log })
    }
    if (s.changeOwed) changeOwedGate(job, s.changeOwed, deps, now)
  }
}
