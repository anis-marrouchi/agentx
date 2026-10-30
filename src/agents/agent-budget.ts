// --- Monthly money budget per agent, project and fleet (#1162, #1290) ---
//
// An owner can say "this agent may spend at most $40 a month", cap a
// project (the Wall's `dashboard.wall.projects`) and optionally cap the
// whole fleet. Spend is the recorded cost of each run: Claude Code's own
// `total_cost_usd` when the runtime reports it, otherwise the token count
// priced at the model's list price. The month is the calendar month in UTC.
//
//   - Under the warn line (warnRatio × cap, default 0.8): nothing happens.
//   - At the warn line: one owner notice per scope per month.
//   - At the cap: new runs in that scope are refused with a clear reason
//     until the cap is raised or the month turns.
//
// A run belongs to the project the Wall puts it in: its repo, else its
// agent, else its agent's workspace (budget-projects.ts resolves it).
//
// The spend lives in memory, seeded at boot from the month's traces
// (task_traces.cost_usd), so it survives a restart and matches the trace
// sum the dashboard shows. Like claude-code-quota.ts this module holds the
// state and makes the decisions; the daemon feeds it runs and sends the
// notices.
//
//   setAgentBudgets(cfg)               — apply config (boot and on save)
//   setBudgetProjectResolver(fn)       — how a run maps to a project
//   seedMonthSpend(byAgent, now, byProject) — boot: spend already on record
//   recordAgentSpend(id, usd, now, project) — after each run; returns notices
//   preflightBudgetGate(id, now, project)   — before each run; abort when over a cap
//   getBudgetView()                    — spend vs cap for the dashboard

import { HUB_NAME } from "@/daemon/ui/hub-name"

export interface MonthlyBudget {
  /** Most this scope may spend in one calendar month (UTC), in USD. Unset or 0 = no cap. */
  monthlyUsd?: number
  /** Warn the owner when spend reaches warnRatio × monthlyUsd (default 0.8). */
  warnRatio?: number
}

export interface BudgetConfig {
  /** Per-agent budgets, keyed by agent id. */
  agents?: Record<string, MonthlyBudget | undefined>
  /** Per-project budgets, keyed by the Wall project's name. */
  projects?: Record<string, MonthlyBudget | undefined>
  /** Cap on the whole fleet's spend. Reaching it pauses every agent. */
  fleet?: MonthlyBudget
}

export interface BudgetNotice {
  kind: "warn" | "cap"
  /** "fleet" for the fleet total, "project:<name>" for a project; otherwise the agent id. */
  scope: string
  month: string
  spentUsd: number
  capUsd: number
  title: string
  message: string
}

export interface BudgetGateAbort {
  abort: true
  reason: "agent_budget" | "project_budget" | "fleet_budget"
  message: string
}

export interface BudgetRow {
  agentId: string
  spentUsd: number
  capUsd?: number
  warnRatio: number
  /** spent / cap when a cap is set. */
  ratio?: number
  state: "ok" | "warn" | "paused" | "uncapped"
  /** Runs this month with no price (local models): the cap does not see them. */
  unpricedRuns?: number
}

export interface BudgetProjectRow extends Omit<BudgetRow, "agentId" | "unpricedRuns"> {
  name: string
}

export interface BudgetView {
  month: string
  agents: BudgetRow[]
  projects: BudgetProjectRow[]
  fleet: { spentUsd: number; capUsd?: number; warnRatio: number; ratio?: number; state: BudgetRow["state"]; unpricedRuns?: number }
}

const DEFAULT_WARN_RATIO = 0.8
export const FLEET_SCOPE = "fleet"
const projectScope = (name: string): string => `project:${name}`

let config: BudgetConfig = {}
let month = ""
const spend = new Map<string, number>()
const projectSpend = new Map<string, number>()
/** `${scope}:${kind}:${cap}` already told this month. Keyed by cap so raising it can warn again. */
const told = new Set<string>()
let resolveProject: (agentId: string, chatId?: string) => string | null = () => null

/** "2026-10" for any instant in October 2026, UTC. */
export function monthKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7)
}

/** Start of the UTC month that holds `now`, in ms. */
export function monthStart(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** A new month starts from zero. */
function roll(now: number): void {
  const m = monthKey(now)
  if (m === month) return
  month = m
  spend.clear()
  projectSpend.clear()
  told.clear()
}

function capOf(b: MonthlyBudget | undefined): number | undefined {
  return typeof b?.monthlyUsd === "number" && b.monthlyUsd > 0 ? b.monthlyUsd : undefined
}

function warnRatioOf(b: MonthlyBudget | undefined): number {
  const r = b?.warnRatio
  return typeof r === "number" && r > 0 && r <= 1 ? r : DEFAULT_WARN_RATIO
}

function fleetSpent(): number {
  let total = 0
  for (const v of spend.values()) total += v
  return total
}

function usd(n: number): string {
  return `$${n < 1 ? n.toFixed(4).replace(/0{1,2}$/, "") : n.toFixed(2)}`
}

export function setAgentBudgets(next: BudgetConfig | undefined): void {
  config = next ?? {}
}

export function getAgentBudgetConfig(): BudgetConfig { return config }

/** How a run maps to a project: (agent, chat) → project name, or null. */
export function setBudgetProjectResolver(fn: ((agentId: string, chatId?: string) => string | null) | undefined): void {
  resolveProject = fn ?? (() => null)
}

/** The project a run of `agentId` in `chatId` counts toward, or null. */
export function budgetProjectOf(agentId: string, chatId?: string): string | null {
  return resolveProject(agentId, chatId)
}

/** Tests and reload: forget the month's spend and notices. */
export function clearAgentSpend(): void {
  spend.clear()
  projectSpend.clear()
  told.clear()
  month = ""
}

/** The lines `spent` has already crossed for a scope, as notice keys. */
function crossed(scope: string, spent: number, b: MonthlyBudget | undefined): Array<{ kind: "warn" | "cap"; key: string; cap: number }> {
  const cap = capOf(b)
  if (!cap) return []
  const out: Array<{ kind: "warn" | "cap"; key: string; cap: number }> = []
  if (spent >= cap) out.push({ kind: "cap", key: `${scope}:cap:${cap}`, cap })
  else if (spent >= cap * warnRatioOf(b)) out.push({ kind: "warn", key: `${scope}:warn:${cap}`, cap })
  return out
}

function positive(by: Record<string, number>, into: Map<string, number>): void {
  into.clear()
  for (const [k, v] of Object.entries(by)) if (Number.isFinite(v) && v > 0) into.set(k, v)
}

/**
 * Boot: the spend already on record this month, per agent and per project.
 * Lines it has already crossed count as told, so a restart does not repeat
 * a notice.
 */
export function seedMonthSpend(byAgent: Record<string, number>, now: number = Date.now(), byProject: Record<string, number> = {}): void {
  roll(now)
  positive(byAgent, spend)
  positive(byProject, projectSpend)
  const markTold = (scope: string, value: number, b: MonthlyBudget | undefined) => {
    for (const c of crossed(scope, value, b)) {
      told.add(c.key)
      if (c.kind === "cap") told.add(`${scope}:warn:${c.cap}`)
    }
  }
  for (const [id, v] of spend) markTold(id, v, config.agents?.[id])
  for (const [name, v] of projectSpend) markTold(projectScope(name), v, config.projects?.[name])
  markTold(FLEET_SCOPE, fleetSpent(), config.fleet)
}

export function getAgentSpend(agentId: string, now: number = Date.now()): number {
  roll(now)
  return spend.get(agentId) ?? 0
}

/** Where the owner raises a scope's cap. */
function whereToRaise(scope: string): string {
  if (scope === FLEET_SCOPE) return `the fleet cap on the ${HUB_NAME}'s Cost page or budget.monthlyUsd in agentx.json`
  if (scope.startsWith("project:")) return `the cap of project ${scope.slice(8)} on the ${HUB_NAME}'s Cost page or its budget.monthlyUsd under dashboard.wall.projects in agentx.json`
  return `the cap on the ${HUB_NAME}'s Cost page or agents.${scope}.budget.monthlyUsd in agentx.json`
}

function notice(kind: "warn" | "cap", scope: string, spent: number, cap: number, b: MonthlyBudget | undefined): BudgetNotice {
  const who = scope === FLEET_SCOPE ? "The fleet" : scope.startsWith("project:") ? `Project ${scope.slice(8)}` : `Agent ${scope}`
  const where = whereToRaise(scope)
  if (kind === "warn") {
    return {
      kind, scope, month, spentUsd: spent, capUsd: cap,
      title: `${who} is near its monthly budget`,
      message:
        `${who} has spent ${usd(spent)} of its ${usd(cap)} budget for ${month} ` +
        `(${Math.round((spent / cap) * 100)}%, warning at ${Math.round(warnRatioOf(b) * 100)}%). ` +
        `At ${usd(cap)} new runs stop until the month ends or you raise ${where}.`,
    }
  }
  const paused = scope === FLEET_SCOPE ? "Every agent is" : scope.startsWith("project:") ? "Its work is" : "It is"
  return {
    kind, scope, month, spentUsd: spent, capUsd: cap,
    title: `${who} reached its monthly budget`,
    message:
      `${who} has spent ${usd(spent)} of its ${usd(cap)} budget for ${month}. ` +
      `${paused} paused: new runs are refused until the month ends ` +
      `or you raise ${where} (applies on save).`,
  }
}

/**
 * Add one run's cost to its agent's and project's month. Returns the
 * notices this run crossed into, each at most once per scope, cap and
 * month. A warning that was never sent is dropped when the same run also
 * reaches the cap.
 */
export function recordAgentSpend(agentId: string, costUsd: number | undefined, now: number = Date.now(), project?: string | null): BudgetNotice[] {
  roll(now)
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd <= 0) return []
  const spent = (spend.get(agentId) ?? 0) + costUsd
  spend.set(agentId, spent)
  const out: BudgetNotice[] = []
  const check = (scope: string, value: number, b: MonthlyBudget | undefined) => {
    for (const c of crossed(scope, value, b)) {
      if (told.has(c.key)) continue
      told.add(c.key)
      if (c.kind === "cap") told.add(`${scope}:warn:${c.cap}`)
      out.push(notice(c.kind, scope, value, c.cap, b))
    }
  }
  check(agentId, spent, config.agents?.[agentId])
  if (project) {
    const p = (projectSpend.get(project) ?? 0) + costUsd
    projectSpend.set(project, p)
    check(projectScope(project), p, config.projects?.[project])
  }
  check(FLEET_SCOPE, fleetSpent(), config.fleet)
  return out
}

/**
 * Null when the agent may run; an abort with the reason when a cap is
 * reached. `project` is the run's project (budgetProjectOf), if any.
 */
export function preflightBudgetGate(agentId: string, now: number = Date.now(), project?: string | null): BudgetGateAbort | null {
  roll(now)
  const agentCap = capOf(config.agents?.[agentId])
  const spent = spend.get(agentId) ?? 0
  if (agentCap && spent >= agentCap) {
    return {
      abort: true,
      reason: "agent_budget",
      message:
        `Monthly budget reached: agent ${agentId} has spent ${usd(spent)} of its ${usd(agentCap)} budget for ${month}. ` +
        `New runs are paused until the month ends. To resume now, raise ${whereToRaise(agentId)} (applies on save).`,
    }
  }
  const projectCap = project ? capOf(config.projects?.[project]) : undefined
  const pSpent = project ? projectSpend.get(project) ?? 0 : 0
  if (project && projectCap && pSpent >= projectCap) {
    return {
      abort: true,
      reason: "project_budget",
      message:
        `Monthly project budget reached: project ${project} has spent ${usd(pSpent)} of its ${usd(projectCap)} budget for ${month}. ` +
        `New runs for it are paused until the month ends. To resume now, raise ${whereToRaise(projectScope(project))} (applies on save).`,
    }
  }
  const fleetCap = capOf(config.fleet)
  const total = fleetSpent()
  if (fleetCap && total >= fleetCap) {
    return {
      abort: true,
      reason: "fleet_budget",
      message:
        `Monthly fleet budget reached: all agents together have spent ${usd(total)} of the ${usd(fleetCap)} budget for ${month}. ` +
        `New runs are paused until the month ends. To resume now, raise ${whereToRaise(FLEET_SCOPE)} (applies on save).`,
    }
  }
  return null
}

function stateOf(spent: number, b: MonthlyBudget | undefined): BudgetRow["state"] {
  const cap = capOf(b)
  if (!cap) return "uncapped"
  if (spent >= cap) return "paused"
  if (spent >= cap * warnRatioOf(b)) return "warn"
  return "ok"
}

function row(spentUsd: number, b: MonthlyBudget | undefined) {
  const capUsd = capOf(b)
  return {
    spentUsd, capUsd, warnRatio: warnRatioOf(b),
    ...(capUsd ? { ratio: spentUsd / capUsd } : {}),
    state: stateOf(spentUsd, b),
  }
}

const byUse = <T extends { ratio?: number; spentUsd: number }>(key: (r: T) => string) =>
  (a: T, b: T) => (b.ratio ?? -1) - (a.ratio ?? -1) || b.spentUsd - a.spentUsd || key(a).localeCompare(key(b))

/**
 * Spend vs cap for every agent with a budget, spend or unpriced runs this
 * month, and every configured project. Pure over its inputs, so the
 * dashboard can build the same view from the traces without the daemon's
 * memory.
 */
export function buildBudgetView(
  cfg: BudgetConfig,
  byAgent: Record<string, number>,
  forMonth: string,
  byProject: Record<string, number> = {},
  unpriced: Record<string, number> = {},
): BudgetView {
  const ids = new Set<string>([
    ...Object.keys(byAgent),
    ...Object.keys(unpriced).filter((id) => unpriced[id] > 0),
    ...Object.entries(cfg.agents ?? {}).filter(([, b]) => capOf(b)).map(([id]) => id),
  ])
  const agents: BudgetRow[] = [...ids].map((agentId) => ({
    agentId,
    ...row(byAgent[agentId] ?? 0, cfg.agents?.[agentId]),
    ...(unpriced[agentId] > 0 ? { unpricedRuns: unpriced[agentId] } : {}),
  })).sort(byUse((r) => r.agentId))
  const projects: BudgetProjectRow[] = Object.keys(cfg.projects ?? {})
    .map((name) => ({ name, ...row(byProject[name] ?? 0, cfg.projects?.[name]) }))
    .sort(byUse((r) => r.name))
  const total = Object.values(byAgent).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  const unpricedTotal = Object.values(unpriced).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  return {
    month: forMonth,
    agents,
    projects,
    fleet: { ...row(total, cfg.fleet), ...(unpricedTotal ? { unpricedRuns: unpricedTotal } : {}) },
  }
}

export function getBudgetView(now: number = Date.now()): BudgetView {
  roll(now)
  return buildBudgetView(config, Object.fromEntries(spend), month, Object.fromEntries(projectSpend))
}

/**
 * Budget config as agentx.json holds it: `agents.<id>.budget`, a `budget`
 * on each `dashboard.wall.projects` entry, and top-level `budget`. Every
 * named project is listed (budget or not), so the dashboard can offer it.
 */
export function budgetConfigFrom(cfg: {
  agents?: Record<string, { budget?: MonthlyBudget }>
  budget?: MonthlyBudget
  dashboard?: { wall?: { projects?: Array<{ name: string; budget?: MonthlyBudget }> } }
}): BudgetConfig {
  const agents: Record<string, MonthlyBudget> = {}
  for (const [id, def] of Object.entries(cfg.agents ?? {})) {
    if (def?.budget) agents[id] = def.budget
  }
  const projects: Record<string, MonthlyBudget | undefined> = {}
  for (const p of cfg.dashboard?.wall?.projects ?? []) {
    if (!(p.name in projects)) projects[p.name] = p.budget
  }
  return { agents, projects, fleet: cfg.budget }
}
