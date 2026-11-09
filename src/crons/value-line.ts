// --- Value line on a recurring job (#1183) ---
//
// Why a cron runs and the number that proves it, set by the operator as
// `crons.<id>.value`. Optional: a job without one reads "no value line" on
// the Wall and on Settings › Schedules, so the gap is visible. `metric` is
// shown as written; `number` (#1826) optionally names a tracked number
// (src/numbers) that measures it, so its readings can be shown beside it.

import { z } from "zod"
import { NUMBER_ID_MAX } from "@/numbers/model"

/** Longest `why` or `metric`, in characters. */
export const CRON_VALUE_MAX = 200

export const cronValueSchema = z.object({
  why: z.string().trim().min(1).max(CRON_VALUE_MAX),
  metric: z.string().trim().min(1).max(CRON_VALUE_MAX),
  /** The id of the tracked number that measures it (#1826). */
  number: z.string().trim().min(1).max(NUMBER_ID_MAX).regex(/^[a-z0-9][\w.:-]*$/i, "number must be a number id: letters, digits, dashes, dots or colons").optional(),
})

export type CronValue = z.infer<typeof cronValueSchema>

/** A value line read from another node or the raw config file: kept only
 *  when both parts are non-empty text, trimmed and capped. */
export function cronValueOf(raw: unknown): CronValue | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { why, metric, number } = raw as Record<string, unknown>
  if (typeof why !== "string" || typeof metric !== "string" || !why.trim() || !metric.trim()) return undefined
  const id = typeof number === "string" ? number.trim() : ""
  return {
    why: why.trim().slice(0, CRON_VALUE_MAX), metric: metric.trim().slice(0, CRON_VALUE_MAX),
    ...(id && id.length <= NUMBER_ID_MAX && /^[a-z0-9][\w.:-]*$/i.test(id) ? { number: id } : {}),
  }
}
