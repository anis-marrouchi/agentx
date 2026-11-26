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

import type { DaemonConfig } from "./config"
import { dashboardTokenForNode } from "./mesh-auth"

/** How long a Claude usage reading counts (claude-plan-usage.ts READING_MAX_AGE_MS). */
const READING_MAX_AGE_MS = 30 * 60_000

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

export interface HubEngineUsage {
  /** The agent tier it is for: "claude-code" or "codex-cli". */
  engine: string
  rows: HubUsageRow[]
  /** The newest of its rows' read times; null with no rows. */
  readAt: number | null
  /** "plan": Claude's usage endpoint; "runs": what runs reported; "session": Codex's last session file. */
  source: "plan" | "runs" | "session"
  plan?: string
}

export interface HubUsage {
  engines: HubEngineUsage[]
  /** Claude's windows with a percentage, as the bar read them before R28 (kept for old pages). */
  windows: Array<{ window: string; utilization: number; resetsAt?: number }>
  readAt: number | null
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
  // percentage only fills a window the reading does not have.
  for (const s of Array.isArray(plan?.provider) ? plan.provider : []) {
    const at = num(s?.seenAt)
    if (typeof s?.window !== "string" || !at) continue
    const u = num(s.utilization)
    const seen = claude.get(s.window)
    if (seen && (seen.at >= at || u === undefined)) continue
    claude.set(s.window, {
      window: s.window, at,
      ...(u !== undefined ? { utilization: u } : typeof s.status === "string" ? { status: s.status } : {}),
      ...(num(s.resetsAt) && { resetsAt: s.resetsAt }),
    })
  }
  const engines: HubEngineUsage[] = []
  const rows = [...claude.values()]
  if (rows.length) {
    engines.push({ engine: "claude-code", rows, readAt: Math.max(...rows.map((r) => r.at)), source: fromPlan ? "plan" : "runs" })
  }
  const codex = plan?.codex
  const codexAt = num(codex?.readAt)
  if (codexAt && Array.isArray(codex.windows)) {
    const cr: HubUsageRow[] = codex.windows
      .filter((w: any) => typeof w?.window === "string" && num(w.utilization) !== undefined)
      .map((w: any) => ({ window: w.window, utilization: w.utilization, ...(num(w.resetsAt) && { resetsAt: w.resetsAt }), at: codexAt }))
    if (cr.length) engines.push({ engine: "codex-cli", rows: cr, readAt: codexAt, source: "session", ...(typeof codex.plan === "string" && { plan: codex.plan }) })
  }
  const windows = rows.filter((r) => r.utilization !== undefined).map((r) => ({ window: r.window, utilization: r.utilization!, ...(r.resetsAt && { resetsAt: r.resetsAt }) }))
  return { engines, windows, readAt: rows.length ? Math.max(...rows.map((r) => r.at)) : null }
}

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
