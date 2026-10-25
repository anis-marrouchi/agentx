// --- Monthly money budget per agent (#1162) ---
//
// An owner can say "this agent may spend at most $40 a month", cap a
// project (a named group of agents, #1285), and optionally cap the whole
// fleet. Spend is the recorded cost of each run:
// Claude Code's own `total_cost_usd` when the runtime reports it, otherwise
// the token count priced at the model's rate. The month is the calendar
// month in UTC.
//
//   - Under the warn line (warnRatio × cap, default 0.8): nothing happens.
//   - At the warn line: one owner notice per agent per month.
//   - At the cap: new runs for that agent (every agent of the project, or
//     every agent for the fleet) are refused with a clear reason until the
//     cap is raised or the month turns.
//
// A project's spend is the sum of its agents' spend. An agent may belong to
// several projects; reaching any one of their caps pauses it.
//
// The spend lives in memory, seeded at boot from the month's traces
// (task_traces.cost_usd), so it survives a restart and matches the trace
// sum the dashboard shows. Like claude-code-quota.ts this module holds the
// state and makes the decisions; the daemon feeds it runs and sends the
// notices.
//
//   setAgentBudgets(cfg)          — apply config (boot and on save)
//   seedMonthSpend(spend)         — boot: spend already on record this month
//   recordAgentSpend(id, usd)     — after each run; returns notices to send
//   preflightBudgetGate(id)       — before each run; abort when over a cap
//   getBudgetView()               — spend vs cap for the dashboard

export interface MonthlyBudget {
  /** Most this scope may spend in one calendar month (UTC), in USD. Unset or 0 = no cap. */
  monthlyUsd?: number
  /** Warn the owner when spend reaches warnRatio × monthlyUsd (default 0.8). */
  warnRatio?: number
}

export interface ProjectBudget extends MonthlyBudget {
  /** Agents whose runs count toward this project's cap, resolved from its
   *  `agents` list and `team`. */
  agents: string[]
}

export interface BudgetConfig {
  /** Per-agent budgets, keyed by agent id. */
  agents?: Record<string, MonthlyBudget | undefined>
  /** Per-project budgets, keyed by project name. Reaching one pauses its agents. */
  projects?: Record<string, ProjectBudget | undefined>
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
}

export interface ProjectBudgetRow {
  project: string
  agents: string[]
  spentUsd: number
  capUsd: number
  warnRatio: number
  ratio: number
  state: BudgetRow["state"]
}

export interface BudgetView {
  month: string
  agents: BudgetRow[]
  /** Projects with a cap, fullest first. */
  projects: ProjectBudgetRow[]
  fleet: { spentUsd: number; capUsd?: number; warnRatio: number; ratio?: number; state: BudgetRow["state"] }
}

const DEFAULT_WARN_RATIO = 0.8
export const FLEET_SCOPE = "fleet"
const PROJECT_PREFIX = "project:"

let config: BudgetConfig = {}
let month = ""
const spend = new Map<string, number>()
/** `${scope}:${kind}:${cap}` already told this month. Keyed by cap so raising it can warn again. */
const told = new Set<string>()

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

/** Sum of the given agents' spend in `byAgent`. */
function sumOf(agents: string[], byAgent: (id: string) => number): number {
  let total = 0
  for (const id of new Set(agents)) total += byAgent(id)
  return total
}

/** The capped projects `agentId` belongs to. */
function projectsOf(cfg: BudgetConfig, agentId: string): Array<[string, ProjectBudget]> {
  const out: Array<[string, ProjectBudget]> = []
  for (const [name, p] of Object.entries(cfg.projects ?? {})) {
    if (p && capOf(p) && p.agents.includes(agentId)) out.push([name, p])
  }
  return out
}

function projectSpent(p: ProjectBudget): number {
  return sumOf(p.agents, (id) => spend.get(id) ?? 0)
}

function usd(n: number): string {
  return `$${n < 1 ? n.toFixed(4).replace(/0{1,2}$/, "") : n.toFixed(2)}`
}

export function setAgentBudgets(next: BudgetConfig | undefined): void {
  config = next ?? {}
}

export function getAgentBudgetConfig(): BudgetConfig { return config }

/** Tests and reload: forget the month's spend and notices. */
export function clearAgentSpend(): void {
  spend.clear()
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

/**
 * Boot: the spend already on record this month, per agent. Lines it has
 * already crossed count as told, so a restart does not repeat a notice.
 */
export function seedMonthSpend(byAgent: Record<string, number>, now: number = Date.now()): void {
  roll(now)
  spend.clear()
  for (const [id, v] of Object.entries(byAgent)) {
    if (Number.isFinite(v) && v > 0) spend.set(id, v)
  }
  for (const [id, v] of spend) {
    for (const c of crossed(id, v, config.agents?.[id])) {
      told.add(c.key)
      if (c.kind === "cap") told.add(`${id}:warn:${c.cap}`)
    }
  }
  for (const [name, p] of Object.entries(config.projects ?? {})) {
    if (!p) continue
    const scope = PROJECT_PREFIX + name
    for (const c of crossed(scope, projectSpent(p), p)) {
      told.add(c.key)
      if (c.kind === "cap") told.add(`${scope}:warn:${c.cap}`)
    }
  }
  const total = fleetSpent()
  for (const c of crossed(FLEET_SCOPE, total, config.fleet)) {
    told.add(c.key)
    if (c.kind === "cap") told.add(`${FLEET_SCOPE}:warn:${c.cap}`)
  }
}

export function getAgentSpend(agentId: string, now: number = Date.now()): number {
  roll(now)
  return spend.get(agentId) ?? 0
}

/** How a notice names the scope, the setting to raise, and who is paused. */
function describe(scope: string): { who: string; where: string; paused: string } {
  if (scope === FLEET_SCOPE) return { who: "The fleet", where: "budget.monthlyUsd", paused: "Every agent" }
  if (scope.startsWith(PROJECT_PREFIX)) {
    const name = scope.slice(PROJECT_PREFIX.length)
    return { who: `Project ${name}`, where: `budget.projects.${name}.monthlyUsd`, paused: "Every agent of the project" }
  }
  return { who: `Agent ${scope}`, where: `agents.${scope}.budget.monthlyUsd`, paused: "It" }
}

function notice(kind: "warn" | "cap", scope: string, spent: number, cap: number, b: MonthlyBudget | undefined): BudgetNotice {
  const { who, where, paused } = describe(scope)
  if (kind === "warn") {
    return {
      kind, scope, month, spentUsd: spent, capUsd: cap,
      title: `${who} is near its monthly budget`,
      message:
        `${who} has spent ${usd(spent)} of its ${usd(cap)} budget for ${month} ` +
        `(${Math.round((spent / cap) * 100)}%, warning at ${Math.round(warnRatioOf(b) * 100)}%). ` +
        `At ${usd(cap)} new runs stop until the month ends or you raise ${where} in agentx.json.`,
    }
  }
  return {
    kind, scope, month, spentUsd: spent, capUsd: cap,
    title: `${who} reached its monthly budget`,
    message:
      `${who} has spent ${usd(spent)} of its ${usd(cap)} budget for ${month}. ` +
      `${paused} is paused: new runs are refused until the month ends ` +
      `or you raise ${where} in agentx.json (applies on save).`,
  }
}

/**
 * Add one run's cost to the agent's month. Returns the notices this run
 * crossed into, each at most once per scope, cap and month. A warning that
 * was never sent is dropped when the same run also reaches the cap.
 */
export function recordAgentSpend(agentId: string, costUsd: number | undefined, now: number = Date.now()): BudgetNotice[] {
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
  for (const [name, p] of projectsOf(config, agentId)) check(PROJECT_PREFIX + name, projectSpent(p), p)
  check(FLEET_SCOPE, fleetSpent(), config.fleet)
  return out
}

/** Null when the agent may run; an abort with the reason when a cap is reached. */
export function preflightBudgetGate(agentId: string, now: number = Date.now()): BudgetGateAbort | null {
  roll(now)
  const agentBudget = config.agents?.[agentId]
  const agentCap = capOf(agentBudget)
  const spent = spend.get(agentId) ?? 0
  if (agentCap && spent >= agentCap) {
    return {
      abort: true,
      reason: "agent_budget",
      message:
        `Monthly budget reached: agent ${agentId} has spent ${usd(spent)} of its ${usd(agentCap)} budget for ${month}. ` +
        `New runs are paused until the month ends. To resume now, raise agents.${agentId}.budget.monthlyUsd in agentx.json (applies on save).`,
    }
  }
  for (const [name, p] of projectsOf(config, agentId)) {
    const cap = capOf(p)!
    const projectTotal = projectSpent(p)
    if (projectTotal < cap) continue
    return {
      abort: true,
      reason: "project_budget",
      message:
        `Monthly project budget reached: the agents of project ${name} have spent ${usd(projectTotal)} of its ${usd(cap)} budget for ${month}. ` +
        `New runs for agent ${agentId} are paused until the month ends. To resume now, raise budget.projects.${name}.monthlyUsd in agentx.json (applies on save).`,
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
        `New runs are paused until the month ends. To resume now, raise budget.monthlyUsd in agentx.json (applies on save).`,
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

/**
 * Spend vs cap for every agent with a budget or spend this month. Pure over
 * its inputs, so the dashboard can build the same view from the traces
 * without the daemon's memory.
 */
export function buildBudgetView(cfg: BudgetConfig, byAgent: Record<string, number>, forMonth: string): BudgetView {
  const ids = new Set<string>([...Object.keys(byAgent), ...Object.entries(cfg.agents ?? {}).filter(([, b]) => capOf(b)).map(([id]) => id)])
  const agents: BudgetRow[] = [...ids].map((agentId) => {
    const b = cfg.agents?.[agentId]
    const spentUsd = byAgent[agentId] ?? 0
    const capUsd = capOf(b)
    return {
      agentId, spentUsd, capUsd, warnRatio: warnRatioOf(b),
      ...(capUsd ? { ratio: spentUsd / capUsd } : {}),
      state: stateOf(spentUsd, b),
    }
  }).sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || b.spentUsd - a.spentUsd || a.agentId.localeCompare(b.agentId))
  const projects: ProjectBudgetRow[] = []
  for (const [project, p] of Object.entries(cfg.projects ?? {})) {
    const capUsd = p ? capOf(p) : undefined
    if (!p || !capUsd) continue
    const spentUsd = sumOf(p.agents, (id) => (byAgent[id] > 0 ? byAgent[id] : 0))
    projects.push({
      project, agents: [...new Set(p.agents)].sort(), spentUsd, capUsd, warnRatio: warnRatioOf(p),
      ratio: spentUsd / capUsd, state: stateOf(spentUsd, p),
    })
  }
  projects.sort((a, b) => b.ratio - a.ratio || a.project.localeCompare(b.project))
  const total = Object.values(byAgent).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  const fleetCap = capOf(cfg.fleet)
  return {
    month: forMonth,
    agents,
    projects,
    fleet: {
      spentUsd: total, capUsd: fleetCap, warnRatio: warnRatioOf(cfg.fleet),
      ...(fleetCap ? { ratio: total / fleetCap } : {}),
      state: stateOf(total, cfg.fleet),
    },
  }
}

export function getBudgetView(now: number = Date.now()): BudgetView {
  roll(now)
  return buildBudgetView(config, Object.fromEntries(spend), month)
}

/** A project budget as agentx.json holds it, before its members are resolved. */
export interface ProjectBudgetConfig extends MonthlyBudget {
  /** Agent ids that belong to the project. */
  agents?: string[]
  /** Every agent installed with this team (`agents.<id>.team`) belongs too. */
  team?: string
}

/**
 * Budget config as agentx.json holds it: `agents.<id>.budget`, top-level
 * `budget`, and `budget.projects.<name>`. A project's members are its
 * `agents` plus every agent whose `team` matches its `team`.
 */
export function budgetConfigFrom(cfg: {
  agents?: Record<string, { budget?: MonthlyBudget; team?: string }>
  budget?: MonthlyBudget & { projects?: Record<string, ProjectBudgetConfig> }
}): BudgetConfig {
  const agents: Record<string, MonthlyBudget> = {}
  for (const [id, def] of Object.entries(cfg.agents ?? {})) {
    if (def?.budget) agents[id] = def.budget
  }
  const { projects: rawProjects, ...fleet } = cfg.budget ?? {}
  const out: BudgetConfig = { agents, fleet: cfg.budget ? fleet : undefined }
  if (rawProjects && Object.keys(rawProjects).length) {
    out.projects = {}
    for (const [name, p] of Object.entries(rawProjects)) {
      const members = new Set(p.agents ?? [])
      if (p.team) {
        for (const [id, def] of Object.entries(cfg.agents ?? {})) if (def?.team === p.team) members.add(id)
      }
      out.projects[name] = { monthlyUsd: p.monthlyUsd, warnRatio: p.warnRatio, agents: [...members].sort() }
    }
  }
  return out
}
