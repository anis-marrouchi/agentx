import type Database from "better-sqlite3"
import type { DecisionCard } from "@/approvals/cards"
import { cronGoalChoice } from "@/approvals/origin"
import { ownerChangedSince, recordCronChange } from "./change-ledger"
import { addNote, dropNote, jobGoalState, updateJobGoalState } from "./goal-state"
import { endJobInConfig } from "./retired"
import { HUB_NAME } from "@/daemon/ui/hub-name"

// --- The operator's answer on a schedule's goal card, applied (#863) ---
//
// Applied when the card is decided, from the approvals sweep's
// decided-card loop, and again at the job's next fire as the fallback: a
// write that failed the first time is done then. Idempotent: an answer
// already applied changes nothing. Only an answer counts (status
// "decided"); these cards never expire.
//
//   keep   → goal check cleared, goalKeptAt = the answer time (30 days
//            with no goal check).
//   change → the same, plus changeOwed: the job does not run until the
//            owner writes a brief, time, goal or value change, or retires.
//   drop   → the daemon retires the job itself (enabled: false, endedAt,
//            a ledger row). It never runs again.
//   no     → keep.

export interface GoalAnswerDeps {
  root: string
  configPath?: string
  now?: () => number
  log: (msg: string) => void
  ledger?: () => Database.Database | null
}

export type GoalAnswerOutcome = "applied" | "skip" | "failed"

export async function applyGoalAnswer(card: DecisionCard, deps: GoalAnswerDeps): Promise<GoalAnswerOutcome> {
  if (card.status !== "decided" || card.origin?.kind !== "cron-goal") return "skip"
  const { jobId, goalId } = card.origin
  const g = jobGoalState(deps.root, jobId, deps.log).goalCheck
  // Nothing held, another goal, or another card: already applied or not ours.
  if (!g || g.goalId !== goalId || (g.cardId && g.cardId !== card.id)) return "skip"
  const choice = cronGoalChoice(card)
  const at = card.decided_at ?? new Date(deps.now?.() ?? Date.now()).toISOString()
  const owner = card.raised_by
  try {
    if (choice === "drop") return await applyDrop(card, at, deps)
    let owedPaid = false
    if (choice === "change") {
      // The owner may have acted on the notice before this write.
      try {
        const db = deps.ledger?.()
        owedPaid = !!db && ownerChangedSince(db, jobId, owner, Date.parse(at))
      } catch (e: any) {
        deps.log(`[cron-goal] "${jobId}": change log not read: ${e?.message ?? e}`)
      }
    }
    updateJobGoalState(deps.root, jobId, (s) => {
      delete s.goalCheck
      s.goalKeptAt = at
      dropNote(s, "card-refused")
      if (choice === "change" && !owedPaid) s.changeOwed = { since: at, cardId: card.id, ...(card.note ? { note: card.note } : {}) }
    })
    deps.log(`[cron-goal] "${jobId}": operator answered ${choice} on ${card.id}`)
    return "applied"
  } catch (e: any) {
    deps.log(`[cron-goal] "${jobId}": answer on ${card.id} not applied, retried at the next fire: ${e?.message ?? e}`)
    return "failed"
  }
}

async function applyDrop(card: DecisionCard, at: string, deps: GoalAnswerDeps): Promise<GoalAnswerOutcome> {
  const { jobId } = card.origin as { jobId: string }
  updateJobGoalState(deps.root, jobId, (s) => {
    if (!s.goalCheck) return
    if (s.goalCheck.reason !== "drop-answered") {
      s.goalCheck.reason = "drop-answered"
      s.goalCheck.droppedAt = at
    }
    s.goalCheck.cardId = card.id
    delete s.changeOwed
  })
  const ended = await endJobInConfig(jobId, at, { configPath: deps.configPath, root: deps.root })
  if (!ended.ok) {
    deps.log(`[cron-goal] "${jobId}": drop answered, but not written to agentx.json: ${ended.error}; retried at the next fire`)
    try {
      updateJobGoalState(deps.root, jobId, (s) => { addNote(s, "drop-write", `drop answered, not yet written to agentx.json: ${ended.error}`, new Date().toISOString()) })
    } catch (e: any) {
      deps.log(`[cron-goal] "${jobId}": ${HUB_NAME} line not written: ${e?.message ?? e}`)
    }
    return "failed"
  }
  updateJobGoalState(deps.root, jobId, (s) => { dropNote(s, "drop-write") })
  if (ended.changed) {
    try {
      const db = deps.ledger?.()
      if (db) recordCronChange(db, { job: jobId, field: "retire", old: "on", new: "retired", by: "operator", reason: `drop answered on card ${card.id}`, at: Date.parse(at) })
    } catch (e: any) {
      deps.log(`[cron-goal] "${jobId}": change log row not written: ${e?.message ?? e}`)
    }
    deps.log(`[cron-goal] "${jobId}": operator answered drop on ${card.id}; retired`)
  }
  return "applied"
}
