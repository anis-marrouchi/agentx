// --- The nightly self-improvement pass (#1783) ---
//
// Runs inside the nightly `agentx retro sweep` (and by hand as
// `agentx improve rank`). Stage 2: rank the day's recurring failure groups,
// with at most one small-model merge call a day, and with `commit` save the
// ranking. Model calls only when `improve.enabled`, within `improve.dailyUsd`.

import type Database from "better-sqlite3"
import { readImproveSettings, spentToday, type ImproveSettings } from "./budget"
import { MERGE_PROMPT, rankSignals, saveRanking, type RankResult } from "./rank"

export interface ImprovePassOptions {
  /** Writable: the ranking and the spend are saved in it. */
  db: Database.Database
  since: number
  commit?: boolean
  settings?: ImproveSettings
  /** The small-model call: prompt + input → reply and cost. Not called
   *  without `commit`, or while `improve.enabled` is off. */
  call?: (input: string, model: string, systemPrompt: string) => Promise<{ text: string; usd: number | null }>
  now?: number
}

export interface ImprovePassResult extends RankResult {
  settings: ImproveSettings
  /** The day the ranking was saved under; unset in a preview. */
  savedDay?: string
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
  return { ...r, settings, savedDay, spent: { usd: spentToday(opts.db, now).usd } }
}
