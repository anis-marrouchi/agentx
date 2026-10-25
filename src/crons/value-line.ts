// --- Value line on a recurring job (#1183) ---
//
// Why a cron runs and the number that proves it, set by the operator as
// `crons.<id>.value`. Optional: a job without one reads "no value line" on
// the Wall and on Settings › Schedules, so the gap is visible. Nothing
// measures or checks the number; it is shown as written.

import { z } from "zod"

/** Longest `why` or `metric`, in characters. */
export const CRON_VALUE_MAX = 200

export const cronValueSchema = z.object({
  why: z.string().trim().min(1).max(CRON_VALUE_MAX),
  metric: z.string().trim().min(1).max(CRON_VALUE_MAX),
})

export type CronValue = z.infer<typeof cronValueSchema>

/** A value line read from another node or the raw config file: kept only
 *  when both parts are non-empty text, trimmed and capped. */
export function cronValueOf(raw: unknown): CronValue | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { why, metric } = raw as Record<string, unknown>
  if (typeof why !== "string" || typeof metric !== "string" || !why.trim() || !metric.trim()) return undefined
  return { why: why.trim().slice(0, CRON_VALUE_MAX), metric: metric.trim().slice(0, CRON_VALUE_MAX) }
}
