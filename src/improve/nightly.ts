// --- The nightly self-improvement pass (#1783) ---
//
// Runs inside the nightly `agentx retro sweep` (and by hand as
// `agentx improve rank`). Stage 2: rank the day's recurring failure groups,
// with at most one small-model merge call a day, and with `commit` save the
// ranking. Stage 3 (sweep only): hand the worst to the retro. Stage 4
// (sweep only): a problem whose picked fix did not lower its count says so
// on its next card. Rules (sweep only, #1996): one fix rule per agent in its
// memory, at most 3. Model calls only when `improve.enabled`, within
// `improve.dailyUsd`.

import type Database from "better-sqlite3"
import { readImproveSettings, spentToday, type ImproveSettings } from "./budget"
import { MERGE_PROMPT, rankSignals, saveRanking, type RankResult } from "./rank"
import { checkHeld, notHeldNote, type HeldCheck } from "./held"
import { handWorstToRetro, type HandoffOutcome } from "./handoff"
import { ruleRetiredNote, ruleStage, type RuleStageResult } from "./rules"
import type { ApprovalSettings } from "@/approvals/sweep"
import type { AgentMemory } from "@/agents/agent-memory"

export interface ImprovePassOptions {
  /** Writable: the ranking and the spend are saved in it. */
  db: Database.Database
  since: number
  commit?: boolean
  settings?: ImproveSettings
  /** The small-model call: prompt + input → reply and cost. Not called
   *  without `commit`, or while `improve.enabled` is off. */
  call?: (input: string, model: string, systemPrompt: string) => Promise<{ text: string; usd: number | null }>
  /** Stage 3: hand the worst problems to the retro. Unset: rank only. */
  retro?: {
    root: string
    approvals: ApprovalSettings
    /** The retro reviewer: RETRO_PROMPT + input → reply and cost. */
    propose: (input: string) => Promise<{ text: string; usd: number | null }>
    /** All retro cards allowed in any 24 hours (the sweep's --max). */
    retroMax: number
  }
  /** One fix rule per agent, at most 3 (#1996): the agents' memory the
   *  rules are written to. Unset: no rule stage. */
  rules?: { memory: AgentMemory }
  now?: number
}

export interface ImprovePassResult extends RankResult {
  settings: ImproveSettings
  /** The day the ranking was saved under; unset in a preview. */
  savedDay?: string
  handoff?: { room: number; outcomes: HandoffOutcome[]; why?: string }
  /** Stage 4: before and after for each picked fix (sweep only). */
  held?: HeldCheck[]
  /** The rule stage (#1996), when the pass was given the agents' memory. */
  rules?: RuleStageResult
  spent: { usd: number }
}

export async function improvePass(opts: ImprovePassOptions): Promise<ImprovePassResult> {
  const now = opts.now ?? Date.now()
  const settings = opts.settings ?? readImproveSettings()
  const call = opts.call
  const mayMerge = !!(opts.commit && call && settings.enabled && settings.mergeModel)
  const r = await rankSignals(opts.db, {
    since: opts.since,
    minRefs: settings.minRefs,
    now,
    settings,
    merge: mayMerge ? (input) => call!(input, settings.mergeModel, MERGE_PROMPT) : undefined,
  })
  if (!mayMerge) {
    r.merge = { ran: false, why: !opts.commit ? "preview" : !settings.enabled ? "improve.enabled is off" : "no merge model" }
  }
  const savedDay = opts.commit ? saveRanking(opts.db, r.groups, now) : undefined

  // The rule stage (#1996): judge each agent's rules, then write one for
  // its worst group no rule covers. Before the retro, so a rule retired
  // tonight shows on tonight's card about the same problem.
  const rules = opts.rules
    ? await ruleStage({ db: opts.db, memory: opts.rules.memory, groups: r.groups, settings, call, commit: opts.commit, now })
    : undefined

  // Stage 3: the worst problems go to the retro. A preview says which it
  // would hand over; a commit asks the reviewer only when improve.enabled.
  // Stage 4: a problem whose picked fix did not lower its count says so on
  // its next card. No model call.
  let handoff: ImprovePassResult["handoff"]
  let held: HeldCheck[] | undefined
  if (opts.retro) {
    held = checkHeld(opts.db, opts.retro.root, now)
    const checks = held
    if (opts.commit && !settings.enabled) handoff = { room: 0, outcomes: [], why: "improve.enabled is off" }
    else {
      handoff = await handWorstToRetro({
        root: opts.retro.root, db: opts.db, groups: r.groups, since: opts.since, settings,
        approvals: opts.retro.approvals, propose: opts.retro.propose, retroMax: opts.retro.retroMax,
        commit: opts.commit, now,
        noteFor: (g) => [notHeldNote(checks, g.members), ruleRetiredNote(opts.db, g.members)].filter(Boolean).join(" ") || undefined,
      })
    }
  }
  return { ...r, settings, savedDay, handoff, held, rules, spent: { usd: spentToday(opts.db, now).usd } }
}
