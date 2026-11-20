// --- Prove a picked fix held: stage 4 of self-improvement (#1783) ---
//
// A fix picked on a self-improvement card (stage 3) is checked against the
// problem it was for: that problem's signal rows in the 7 days after the
// pick, against the 7 days before. No model call. A fix whose count did not
// go down is not raised as a card of its own: the note goes on the next
// card about the same problem, so the owner sees it with the new choices.
//
// The pick is the cut. The fix reaches the agents some time after it (a PR
// to build, review, merge and deploy), so a slow ship makes "after" look
// worse, never better: a fix reported as held did lower the count.

import type Database from "better-sqlite3"
import { listCards, type DecisionCard } from "@/approvals/cards"
import { RETRO_NONE } from "@/approvals/origin"
import { groupSignals, rowsOfGroups } from "./rank"
import { PROBLEM_PREFIX } from "./handoff"
import { COST_KIND_SET, jobTypesOfTraces, ownerReopens, reopensWithin, tokensPerRun } from "./cost"

export const HELD_WINDOW_DAYS = 7
const DAY_MS = 86_400_000

export interface HeldCheck {
  cardId: string
  /** The problem's group key. */
  key: string
  agentId: string
  choice: string
  pickedAt: number
  /** Group keys counted: the problem and any merged into it that day. */
  members: string[]
  before: number
  after: number
  /** `waiting` until the 7 days after the pick are over. */
  verdict: "held" | "not-held" | "waiting"
  /** Days left while waiting. */
  daysLeft?: number
  /** Set for a cost problem (#1995): the verdict comes from these two
   *  numbers, not from the row counts. */
  cost?: CostHeld
}

export interface CostHeld {
  /** Job types found from the problem's runs before the pick. */
  jobTypes: number
  tokensBefore: number
  tokensAfter: number
  runsBefore: number
  runsAfter: number
  reopensBefore: number
  reopensAfter: number
  /** Which of the two numbers failed; empty when the fix held. */
  failed: Array<"tokens" | "reopens">
}

/** Picked fixes on self-improvement cards: decided yes, a fix chosen. */
export function pickedFixes(root: string): DecisionCard[] {
  return listCards(root).filter((c) =>
    c.origin?.kind === "retro" && c.origin.signature.startsWith(PROBLEM_PREFIX)
    && c.status === "decided" && c.verdict === "yes" && !!c.choice && c.choice !== RETRO_NONE && !!c.decided_at,
  )
}

/** The group keys the problem stood for when its card was raised. */
function membersOf(db: Database.Database, key: string, before: number): string[] {
  try {
    const row = db.prepare("SELECT members FROM improve_groups WHERE key = ? AND at <= ? ORDER BY at DESC LIMIT 1").get(key, before) as { members: string } | undefined
    const list = row ? JSON.parse(row.members) as string[] : []
    return list.length ? list : [key]
  } catch {
    return [key]
  }
}

function rowsIn(db: Database.Database, members: Set<string>, from: number, to: number): number {
  return groupSignals(db, from, to).filter((g) => members.has(g.key)).reduce((n, g) => n + g.rows, 0)
}

/** A cost problem's two numbers (#1995): median tokens per run of its job
 *  types, leaving out the runs the problem flagged (they were picked for
 *  being costly, which would bias "before" upwards),
 *  and the owner's reopens for its agent, before and after the pick. */
function costCheck(db: Database.Database, agentId: string, refs: string[], pickedAt: number, end: number, span: number): CostHeld {
  const jobTypes = jobTypesOfTraces(db, refs)
  const flagged = new Set(refs)
  const tb = tokensPerRun(db, jobTypes, pickedAt - span, pickedAt, flagged)
  const ta = tokensPerRun(db, jobTypes, pickedAt, end, flagged)
  const reopensBefore = ownerReopens(db, agentId, pickedAt - span, pickedAt)
  const reopensAfter = ownerReopens(db, agentId, pickedAt, end)
  const failed: CostHeld["failed"] = []
  // No run after the pick shows no saving: it does not count as one.
  if (!(tb.runs > 0 && ta.runs > 0 && ta.perRun < tb.perRun)) failed.push("tokens")
  if (!reopensWithin(reopensBefore, reopensAfter)) failed.push("reopens")
  return { jobTypes: jobTypes.length, tokensBefore: tb.perRun, tokensAfter: ta.perRun, runsBefore: tb.runs, runsAfter: ta.runs, reopensBefore, reopensAfter, failed }
}

/** Before and after for every picked fix. Newest pick first. A fix on a
 *  cost problem holds only when tokens per run went down AND the owner's
 *  reopens did not go up; a failure problem's when its rows went down. */
export function checkHeld(db: Database.Database, root: string, now = Date.now()): HeldCheck[] {
  const span = HELD_WINDOW_DAYS * DAY_MS
  return pickedFixes(root).map((c) => {
    const origin = c.origin as { signature: string }
    const key = origin.signature.slice(PROBLEM_PREFIX.length)
    const pickedAt = Date.parse(c.decided_at!)
    const members = membersOf(db, key, Date.parse(c.created_at))
    const set = new Set(members)
    const before = rowsIn(db, set, pickedAt - span, pickedAt)
    const end = Math.min(now, pickedAt + span)
    const after = rowsIn(db, set, pickedAt, end)
    const base = { cardId: c.id, key, agentId: c.raised_by, choice: c.choice!, pickedAt, members, before, after }
    if (now < pickedAt + span) return { ...base, verdict: "waiting" as const, daysLeft: Math.ceil((pickedAt + span - now) / DAY_MS) }
    // The runs come from every signal row of the problem before the pick,
    // not from the five refs the ranking saved as a sample (C1).
    const rows = rowsOfGroups(db, set, pickedAt - span, pickedAt)
    if (rows.some((r) => COST_KIND_SET.has(r.kind))) {
      const refs = rows.map((r) => r.ref).filter((r): r is string => !!r)
      const cost = costCheck(db, c.raised_by, refs, pickedAt, end, span)
      return { ...base, cost, verdict: cost.failed.length ? "not-held" as const : "held" as const }
    }
    return { ...base, verdict: after < before ? "held" as const : "not-held" as const }
  }).sort((a, b) => b.pickedAt - a.pickedAt)
}

/** "200k before, 100k after; owner reopens 1 before, 3 after" */
export function costLine(c: CostHeld): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`
  return `tokens per run ${k(c.tokensBefore)} before, ${k(c.tokensAfter)} after; owner reopens ${c.reopensBefore} before, ${c.reopensAfter} after`
}

/** The note for the next card about a problem whose latest picked fix did
 *  not lower its count. Undefined when there is none. A problem matches by
 *  any of its group keys, so a merge on another night still finds it. */
export function notHeldNote(checks: HeldCheck[], keys: string[]): string | undefined {
  const mine = new Set(keys)
  const last = checks.find((h) => h.verdict !== "waiting" && h.members.some((k) => mine.has(k)))
  if (!last || last.verdict !== "not-held") return undefined
  const day = new Date(last.pickedAt).toISOString().slice(0, 10)
  const head = `The fix picked on card:${last.cardId} (${day}, "${last.choice.slice(0, 60)}") did not lower this: `
  if (last.cost) {
    const why = last.cost.failed.map((f) => (f === "tokens" ? "tokens per run did not go down" : "reopens went up")).join(" and ")
    return `${head}${costLine(last.cost)} (${why}).`
  }
  return `${head}${last.before} in the ${HELD_WINDOW_DAYS} days before, ${last.after} in the ${HELD_WINDOW_DAYS} after.`
}
