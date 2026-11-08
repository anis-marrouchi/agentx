// --- Self-improvement budget: daily dollar and card caps, in code (#1783) ---
//
// Every model call the self-improvement passes make goes through here: it
// is not started when it would take the last 24 hours past `improve.dailyUsd`,
// and its cost is written to `improve_spend` once it returns. A call whose
// cost the CLI did not report is booked at its estimate, so an unknown cost
// can never let the next call through for free. Same idea as the hand-off
// budget (#1756): a limit the code holds, not a guideline.

import type Database from "better-sqlite3"
import { existsSync, readFileSync } from "fs"
import { z } from "zod"
import { findConfigPath } from "@/daemon/config-mutator"
import { expandEnvVars, improveConfigSchema } from "@/daemon/config"

export type ImproveSettings = z.infer<typeof improveConfigSchema>
export type SpendStage = "merge" | "retro"

const DAY_MS = 86_400_000

/** What one call is booked at before it runs, and after it when the CLI
 *  reports no cost. Deliberately high: a merge on a small model costs cents;
 *  a retro on the reviewer model a few dollars. */
export const CALL_ESTIMATE_USD: Record<SpendStage, number> = { merge: 0.1, retro: 2 }

export function readImproveSettings(configPath?: string): ImproveSettings {
  const path = findConfigPath(configPath)
  let raw: any = {}
  if (existsSync(path)) {
    try { raw = expandEnvVars(JSON.parse(readFileSync(path, "utf-8"))) } catch { raw = {} }
  }
  const parsed = improveConfigSchema.safeParse(raw?.improve)
  return parsed.success ? parsed.data : improveConfigSchema.parse(undefined)
}

const ready = new WeakSet<Database.Database>()

function ensureTable(db: Database.Database): void {
  if (ready.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS improve_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    stage TEXT NOT NULL,
    usd REAL NOT NULL,
    ref TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_improve_spend_at ON improve_spend(at);`)
  ready.add(db)
}

export interface SpendToday { usd: number; calls: Partial<Record<SpendStage, number>> }

/** Dollars and calls booked in the last 24 hours. */
export function spentToday(db: Database.Database, now = Date.now()): SpendToday {
  let rows: Array<{ stage: SpendStage; n: number; usd: number }>
  try {
    // A read never creates the table: a preview writes nothing.
    rows = db.prepare("SELECT stage, COUNT(*) AS n, SUM(usd) AS usd FROM improve_spend WHERE at > ? GROUP BY stage")
      .all(now - DAY_MS) as typeof rows
  } catch {
    return { usd: 0, calls: {} } // nothing booked on this node yet
  }
  const calls: SpendToday["calls"] = {}
  let usd = 0
  for (const r of rows) { calls[r.stage] = r.n; usd += r.usd }
  return { usd: Math.round(usd * 10_000) / 10_000, calls }
}

/** Whether a call of this stage may start now. */
export function canSpend(
  db: Database.Database,
  settings: Pick<ImproveSettings, "enabled" | "dailyUsd">,
  stage: SpendStage,
  now = Date.now(),
): { ok: true } | { ok: false; why: string } {
  if (!settings.enabled) return { ok: false, why: "improve.enabled is off: no model calls" }
  const spent = spentToday(db, now)
  const estimate = CALL_ESTIMATE_USD[stage]
  if (spent.usd + estimate > settings.dailyUsd) {
    return { ok: false, why: `daily budget: $${spent.usd.toFixed(2)} spent in 24 hours, a ${stage} call is booked at $${estimate.toFixed(2)}, limit improve.dailyUsd $${settings.dailyUsd.toFixed(2)}` }
  }
  return { ok: true }
}

/** Book a call that ran. `usd` null: the CLI reported no cost, book the estimate. */
export function recordSpend(db: Database.Database, stage: SpendStage, usd: number | null, ref?: string | null, now = Date.now()): void {
  ensureTable(db)
  const cost = usd != null && Number.isFinite(usd) && usd >= 0 ? usd : CALL_ESTIMATE_USD[stage]
  db.prepare("INSERT INTO improve_spend (at, stage, usd, ref) VALUES (?, ?, ?, ?)").run(now, stage, cost, ref ?? null)
}
