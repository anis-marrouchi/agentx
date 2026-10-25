import { z } from "zod"

/** Monthly money budget (#1162): most this scope may spend in one
 *  calendar month (UTC). Spend is the recorded cost of each run. At
 *  warnRatio × monthlyUsd the owner gets one notice; at the cap new runs
 *  are refused until the month ends or the cap is raised. Applies on save.
 *  Used on agents, on Wall projects (#1290) and on the fleet. */
export const monthlyBudgetSchema = z.object({
  /** USD per calendar month. 0 or unset = no cap. */
  monthlyUsd: z.number().min(0).max(1_000_000).optional(),
  /** Share of the cap at which the owner is warned (default 0.8). */
  warnRatio: z.number().gt(0).max(1).default(0.8),
})
