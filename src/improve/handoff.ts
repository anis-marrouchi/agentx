// --- Hand the worst recurring problem to the retro: stage 3 (#1783) ---
//
// The nightly pass ranks the day's recurring problems (rank.ts). The worst
// one or two become the input of a retro (src/retro): the problem's signal
// rows plus one representative run. The retro proposes fixes on one
// decision card; the owner picks; the agent that owns the area builds it as
// a PR. Nothing here applies a fix.
//
// Every limit holds in code: no call while `improve.enabled` is off, at
// most `improve.maxCardsPerDay` cards from this pass in any 24 hours, the
// retro's own daily limit (all retro cards count), one open card per
// problem and the 30-day rule on turned-down fixes (the card's signature is
// `improve:<group key>`), and each retro call booked against
// `improve.dailyUsd` before the next may start.

import type Database from "better-sqlite3"
import { listCards } from "@/approvals/cards"
import type { ApprovalSettings } from "@/approvals/sweep"
import { earlierRetros, isRetroRun, prepareRetro, raiseRetroCard } from "@/retro/retro"
import { retroCardsToday } from "@/retro/sweep"
import { getTrace } from "@/storage/traces"
import { canSpend, recordSpend, type ImproveSettings } from "./budget"
import { SIGNAL_MEANING } from "./signals"
import { groupKey, normalizeDetail, type SignalGroup } from "./rank"

const DAY_MS = 86_400_000
/** Signal rows shown to the reviewer per problem. */
const ROWS_SHOWN = 12

export const PROBLEM_PREFIX = "improve:"

export function problemSignature(key: string): string {
  return `${PROBLEM_PREFIX}${key}`
}

/** Cards this pass raised in the last 24 hours. */
export function improveCardsToday(root: string, now = Date.now()): number {
  return listCards(root).filter((c) =>
    c.origin?.kind === "retro" && c.origin.signature.startsWith(PROBLEM_PREFIX) && Date.parse(c.created_at) > now - DAY_MS,
  ).length
}

/** The run behind a signal's reference: the run itself, the latest run of
 *  a request, or the latest run of a hand-off. Runs of the group's agent
 *  first; never a run still going, never a retro's own run. */
export function representativeRun(db: Database.Database, root: string, refs: string[], agentId: string | null): string | null {
  const candidates: Array<{ taskId: string; agentId: string; startedAt: number }> = []
  const add = (rows: unknown) => { for (const r of rows as Array<{ task_id: string; agent_id: string; started_at: number }>) candidates.push({ taskId: r.task_id, agentId: r.agent_id, startedAt: r.started_at }) }
  for (const ref of refs) {
    try {
      add(db.prepare("SELECT task_id, agent_id, started_at FROM task_traces WHERE task_id = ? AND status != 'in-flight'").all(ref))
      if (ref.startsWith("req-")) {
        add(db.prepare(
          `SELECT t.task_id, t.agent_id, t.started_at FROM request_links l JOIN task_traces t ON t.task_id = l.ref
           WHERE l.request_id = ? AND t.status != 'in-flight' ORDER BY t.started_at DESC LIMIT 5`,
        ).all(ref))
      }
      if (ref.startsWith("dlg-")) {
        add(db.prepare(
          "SELECT task_id, agent_id, started_at FROM task_traces WHERE channel = 'a2a' AND chat_id LIKE ? AND status != 'in-flight' ORDER BY started_at DESC LIMIT 5",
        ).all(`%:${ref}`))
      }
    } catch {
      // a table this node does not have: try the next reference
    }
    const mine = candidates.filter((c) => !agentId || c.agentId === agentId)
    const pick = (mine.length ? mine : candidates).sort((a, b) => b.startedAt - a.startedAt)
      .find((c) => { const t = getTrace(db, c.taskId)?.task; return !!t && !isRetroRun(root, t) })
    if (pick) return pick.taskId
  }
  return null
}

/** What the reviewer reads about the problem: bounded, rows newest first. */
export function problemSummary(db: Database.Database, g: SignalGroup, since: number): unknown {
  // Rows of this group and of any group merged into it.
  const members = new Set(g.members)
  let rows: Array<{ at: number; agentId: string | null; ref: string | null; detail: string | null }> = []
  try {
    rows = (db.prepare(
      "SELECT at, agent_id AS agentId, ref, detail FROM improve_signals WHERE at >= ? AND kind = ? AND agent_id IS ? ORDER BY at DESC LIMIT 500",
    ).all(since, g.kind, g.agentId) as typeof rows)
      .filter((r) => members.has(groupKey(g.kind, g.agentId, normalizeDetail(g.kind, r.detail))))
  } catch {
    rows = []
  }
  return {
    kind: g.kind,
    meaning: SIGNAL_MEANING[g.kind],
    agent: g.agentId,
    pattern: g.pattern || null,
    rows: g.rows,
    separateRefs: g.refs,
    signals: rows.slice(0, ROWS_SHOWN).map((r) => ({ at: new Date(r.at).toISOString(), ref: r.ref, detail: (r.detail ?? "").slice(0, 300) })),
  }
}

export type HandoffOutcome =
  | { key: string; result: "raised"; cardId: string; taskId: string; usd: number | null }
  | { key: string; result: "would-try"; taskId: string }
  | { key: string; result: "skipped"; why: string }

export interface HandoffOptions {
  root: string
  /** Writable: retro calls are booked in it. */
  db: Database.Database
  groups: SignalGroup[]
  since: number
  settings: ImproveSettings
  approvals: ApprovalSettings
  /** The retro reviewer: RETRO_PROMPT + input → reply and cost. */
  propose: (input: string) => Promise<{ text: string; usd: number | null }>
  /** All retro cards allowed in any 24 hours (the sweep's --max). */
  retroMax: number
  commit?: boolean
  /** Stage 4's note for a problem whose picked fix did not hold. */
  noteFor?: (g: SignalGroup) => string | undefined
  now?: number
}

/** Hand the worst groups to the retro, within every limit. */
export async function handWorstToRetro(opts: HandoffOptions): Promise<{ room: number; outcomes: HandoffOutcome[] }> {
  const now = opts.now ?? Date.now()
  const room = Math.max(0, Math.min(
    opts.settings.maxCardsPerDay - improveCardsToday(opts.root, now),
    opts.retroMax - retroCardsToday(opts.root, now),
  ))
  const outcomes: HandoffOutcome[] = []
  if (opts.commit && opts.approvals.forwardTo) return { room, outcomes: [{ key: "-", result: "skipped", why: `approvals.forwardTo is set (${opts.approvals.forwardTo}): retro cards stay on the machine that raises them` }] }

  let raised = 0
  let attempts = 0
  for (const g of opts.groups) {
    if (raised >= room || attempts >= room * 2) break
    const signature = problemSignature(g.key)
    const open = earlierRetros(opts.root, signature, now).open
    if (open) { outcomes.push({ key: g.key, result: "skipped", why: `card:${open.id} already asks about this problem` }); continue }
    const taskId = representativeRun(opts.db, opts.root, g.sampleRefs, g.agentId)
    if (!taskId) { outcomes.push({ key: g.key, result: "skipped", why: "no finished run found for its references" }); continue }
    if (!opts.commit) { outcomes.push({ key: g.key, result: "would-try", taskId }); raised++; continue }
    const gate = canSpend(opts.db, opts.settings, "retro", now)
    if (!gate.ok) { outcomes.push({ key: g.key, result: "skipped", why: gate.why }); break }

    attempts++
    let usd: number | null = null
    let called = false
    const r = await prepareRetro({
      root: opts.root, db: opts.db, taskId, now,
      problem: { signature, summary: problemSummary(opts.db, g, opts.since), note: opts.noteFor?.(g) },
      propose: async (input) => { called = true; const res = await opts.propose(input); usd = res.usd; return res.text },
    })
    // A call that was made is booked even when its answer is unusable.
    if (called) recordSpend(opts.db, "retro", usd, signature, now)
    if (!r.ok) { outcomes.push({ key: g.key, result: "skipped", why: r.error }); continue }
    const card = raiseRetroCard(opts.root, r.card, opts.approvals)
    if (!card.ok) { outcomes.push({ key: g.key, result: "skipped", why: card.error }); continue }
    outcomes.push({ key: g.key, result: "raised", cardId: card.card.id, taskId, usd })
    raised++
  }
  return { room, outcomes }
}
