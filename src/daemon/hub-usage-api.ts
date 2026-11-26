// --- The Hub status bar's plan usage (#2101 R5, R28b, R28g) ---
//
// GET /api/admin/hub/usage is served by the dashboard process (`agentx board
// serve`). The plan readers live in the daemon: the Claude usage reader
// (agents/claude-plan-usage.ts) and the runs' rate_limit_event
// (agents/claude-code-quota.ts) only ever fill the daemon's memory, so the
// dashboard used to answer from its own empty copy and the bar never had a
// number (R28g cause 1). Now the dashboard asks the daemon's /usage/plan, the
// one reader on the node, and shapes its answer per engine here.
//
// Each window keeps the time it was read. A window a run reported without a
// percentage (Claude's rate_limit_event has a status and a reset time only)
// is kept with its status, so the bar can say "allowed · resets 09:00"
// without a bar (R28g cause 3). Only percentages, statuses and times leave
// here, never a credential.

import type Database from "better-sqlite3"
import { spendByAgentSince, unpricedRunsByAgentSince } from "@/storage/traces"
import type { DaemonConfig } from "./config"
import { dashboardTokenForNode } from "./mesh-auth"

/** How long a Claude usage reading counts (claude-plan-usage.ts READING_MAX_AGE_MS). */
const READING_MAX_AGE_MS = 30 * 60_000
/** How long a run's status with no reset time counts (claude-code-quota.ts REJECTED_FALLBACK_HOLD_MS). */
const STATUS_MAX_AGE_MS = 15 * 60_000

export interface HubUsageRow {
  window: string
  /** 0..1 share used, when known. */
  utilization?: number
  resetsAt?: number
  /** "allowed" | "allowed_warning" | "rejected", from a run, when there is no percentage. */
  status?: string
  /** When this window was read (ms). */
  at: number
}

/** One CLI account's usage (#2101 R28d). */
export interface HubAccountUsage {
  name: string
  /** New runs use it: its rows are the engine's own. */
  active: boolean
  rows: HubUsageRow[]
  readAt: number | null
  source: "plan" | "runs" | "session"
  plan?: string
  /** Its login is gone: it needs a sign-in before it can be read. */
  signedOut?: true
}

export interface HubEngineUsage {
  /** The agent tier it is for: "claude-code" or "codex-cli". */
  engine: string
  rows: HubUsageRow[]
  /** The newest of its rows' read times; null with no rows. */
  readAt: number | null
  /** "plan": Claude's usage endpoint; "runs": what runs reported; "session": Codex's last session file. */
  source: "plan" | "runs" | "session"
  plan?: string
  /** Every account of this engine, when the owner added more than the default one (R28d). */
  accounts?: HubAccountUsage[]
}

/** Today's recorded run cost on this machine, for the API engines (#2101 R28e). */
export interface HubSpend {
  /** 00:00 UTC today (ms), as the Cost page's days. */
  since: number
  /** Agent id → USD its runs cost since then. */
  byAgent: Record<string, number>
  /** Agent id → runs with tokens but no price (local models). */
  unpriced: Record<string, number>
  /** The agents this machine runs: spend for any other is kept on its own machine. */
  agentIds: string[]
}

export interface HubUsage {
  engines: HubEngineUsage[]
  /** Claude's windows with a percentage, as the bar read them before R28 (kept for old pages). */
  windows: Array<{ window: string; utilization: number; resetsAt?: number }>
  readAt: number | null
  spend?: HubSpend | null
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** The engines' usage from a daemon /usage/plan reply. */
export function hubUsageFromPlan(plan: any, now: number = Date.now()): HubUsage {
  const claude = new Map<string, HubUsageRow>()
  let fromPlan = false
  const reading = plan?.reader?.reading
  const readAt = num(reading?.readAt)
  if (readAt && now - readAt <= READING_MAX_AGE_MS) {
    for (const w of Array.isArray(reading.windows) ? reading.windows : []) {
      const u = num(w?.utilization)
      if (typeof w?.window !== "string" || u === undefined) continue
      claude.set(w.window, { window: w.window, utilization: u, ...(num(w.resetsAt) && { resetsAt: w.resetsAt }), at: readAt })
      fromPlan = true
    }
  }
  // What runs reported: newer than the reading wins; a status with no
  // percentage only fills a window the reading does not have, except "limit
  // reached", which says more than an older percentage does. A status with
  // no reset time counts as long as the dispatch gate trusts it.
  for (const s of Array.isArray(plan?.provider) ? plan.provider : []) {
    const at = num(s?.seenAt)
    if (typeof s?.window !== "string" || !at) continue
    const u = num(s.utilization)
    if (u === undefined && !num(s.resetsAt) && now - at > STATUS_MAX_AGE_MS) continue
    const seen = claude.get(s.window)
    if (seen && (seen.at >= at || (u === undefined && s.status !== "rejected"))) continue
    claude.set(s.window, {
      window: s.window, at,
      ...(u !== undefined ? { utilization: u } : typeof s.status === "string" ? { status: s.status } : {}),
      ...(num(s.resetsAt) && { resetsAt: s.resetsAt }),
    })
  }
  const engines: HubEngineUsage[] = []
  const rows = [...claude.values()]
  const claudeAccounts = plan?.accounts?.claude
  if (rows.length || Array.isArray(claudeAccounts)) {
    engines.push(withAccounts({ engine: "claude-code", rows, readAt: rows.length ? Math.max(...rows.map((r) => r.at)) : null, source: fromPlan || !rows.length ? "plan" : "runs" }, claudeAccounts, READING_MAX_AGE_MS, now))
  }
  const codex = plan?.codex
  const codexAt = num(codex?.readAt)
  const cr = codexAt ? readingRows(codex.windows, codexAt) : []
  const codexAccounts = plan?.accounts?.codex
  if (cr.length || Array.isArray(codexAccounts)) {
    engines.push(withAccounts({ engine: "codex-cli", rows: cr, readAt: cr.length ? codexAt! : null, source: "session", ...(cr.length > 0 && typeof codex.plan === "string" && { plan: codex.plan }) }, codexAccounts, Infinity, now))
  }
  const windows = rows.filter((r) => r.utilization !== undefined).map((r) => ({ window: r.window, utilization: r.utilization!, ...(r.resetsAt && { resetsAt: r.resetsAt }) }))
  return { engines, windows, readAt: rows.length ? Math.max(...rows.map((r) => r.at)) : null }
}

/** A reading's windows that have a percentage, as rows read at `at`. */
function readingRows(windows: unknown, at: number): HubUsageRow[] {
  return (Array.isArray(windows) ? windows : [])
    .filter((w: any) => typeof w?.window === "string" && num(w.utilization) !== undefined)
    .map((w: any) => ({ window: w.window, utilization: w.utilization, ...(num(w.resetsAt) && { resetsAt: w.resetsAt }), at }))
}

/**
 * R28d: the engine's accounts, from the daemon's per-account readings
 * (agents/plan-usage-accounts.ts). The account in use takes the engine's own
 * rows; another's reading older than `maxAge` counts for nothing.
 */
function withAccounts(e: HubEngineUsage, list: unknown, maxAge: number, now: number): HubEngineUsage {
  if (!Array.isArray(list)) return e
  const accounts: HubAccountUsage[] = []
  for (const a of list) {
    if (typeof a?.name !== "string") continue
    if (a.active === true) {
      accounts.push({ name: a.name, active: true, rows: e.rows, readAt: e.readAt, source: e.source, ...(e.plan && { plan: e.plan }) })
      continue
    }
    const at = num(a.readAt)
    const rows = at && now - at <= maxAge ? readingRows(a.windows, at) : []
    accounts.push({
      name: a.name, active: false, rows, readAt: rows.length ? at! : null, source: e.source === "session" ? "session" : "plan",
      ...(rows.length > 0 && typeof a.plan === "string" && { plan: a.plan }),
      ...((a.error === "signed-out" || a.error === "no-login") && { signedOut: true as const }),
    })
  }
  return accounts.length ? { ...e, accounts } : e
}

/** How long today's spend sums are kept: the bar polls every minute from every tab. */
export const HUB_SPEND_TTL_MS = 60_000
let spendSums: { since: number; at: number; byAgent: Record<string, number>; unpriced: Record<string, number> } | null = null

/**
 * R28e: today's recorded run cost per agent on this machine, the same
 * task_traces.cost_usd the Cost page and the budgets sum (no second store).
 * Runs with no price (local models) are counted, not priced.
 */
export function hubSpendToday(db: Database.Database, agentIds: string[], now: number = Date.now()): HubSpend {
  const d = new Date(now)
  const since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (!spendSums || spendSums.since !== since || now - spendSums.at >= HUB_SPEND_TTL_MS) {
    spendSums = { since, at: now, byAgent: spendByAgentSince(db, since), unpriced: unpricedRunsByAgentSince(db, since) }
  }
  return { since, byAgent: spendSums.byAgent, unpriced: spendSums.unpriced, agentIds: [...agentIds].sort() }
}

/** For tests. */
export function resetHubSpendCache(): void { spendSums = null }

/**
 * Asks the daemon for its plan readings. /usage/plan sits behind the mesh
 * guard, which takes MESH_TOKEN (or loopback), not the dashboard token, so
 * MESH_TOKEN goes first.
 */
export async function fetchHubUsage(config: Pick<DaemonConfig, "dashboard">, fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = process.env, now: number = Date.now()): Promise<HubUsage> {
  const base = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const token = env.MESH_TOKEN || dashboardTokenForNode(config.dashboard as any, base, env)
  const r = await fetchImpl(base + "/usage/plan", { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`daemon usage read answered ${r.status}`)
  return hubUsageFromPlan(await r.json(), now)
}
