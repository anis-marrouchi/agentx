import { applyConfigMutation, type MutationResult } from "./config-mutator"

// --- Monthly budgets: set and raise them from the dashboard (#1290) ---
//
// The Cost page's budget card writes here. agentx.json stays the only
// copy: the change goes through applyConfigMutation (schema check, write,
// daemon reload), and the reload applies it to the gate, releasing work
// held for a scope whose cap was raised.

export interface BudgetPatch {
  scope: "agent" | "project" | "fleet"
  /** Agent id or project name; unused for the fleet. */
  id?: string
  /** USD per month. null or 0 removes the cap. */
  monthlyUsd: number | null
  /** Share of the cap at which the owner is warned. Unset keeps it. */
  warnRatio?: number
}

/** Check a patch from the dashboard. Null when it is fine, else the problem. */
export function budgetPatchProblem(body: Record<string, unknown>): string | null {
  if (body.scope !== "agent" && body.scope !== "project" && body.scope !== "fleet") return "scope is agent, project or fleet"
  if (body.scope !== "fleet" && (typeof body.id !== "string" || !body.id.trim())) return `a ${body.scope} budget needs its ${body.scope === "agent" ? "agent id" : "project name"}`
  const usd = body.monthlyUsd
  if (usd !== null && !(typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && usd <= 1_000_000)) return "monthlyUsd is a number of dollars from 0 to 1000000, or null for no cap"
  const r = body.warnRatio
  if (r !== undefined && !(typeof r === "number" && r > 0 && r <= 1)) return "warnRatio is a share above 0 and up to 1, such as 0.8"
  return null
}

function apply(target: Record<string, any>, patch: BudgetPatch): void {
  const budget = { ...(target.budget ?? {}) }
  if (patch.monthlyUsd === null || patch.monthlyUsd === 0) delete budget.monthlyUsd
  else budget.monthlyUsd = patch.monthlyUsd
  if (patch.warnRatio !== undefined) budget.warnRatio = patch.warnRatio
  if (budget.monthlyUsd === undefined) delete target.budget
  else target.budget = budget
}

export async function updateBudget(patch: BudgetPatch, opts: { configPath?: string; reload?: boolean } = {}): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    if (patch.scope === "fleet") return apply(cfg, patch)
    if (patch.scope === "agent") {
      const agent = cfg.agents?.[patch.id!]
      if (!agent) throw new Error(`no agent "${patch.id}" in agentx.json`)
      return apply(agent, patch)
    }
    const project = (cfg.dashboard?.wall?.projects ?? []).find((p: any) => p?.name === patch.id)
    if (!project) throw new Error(`no project "${patch.id}" under dashboard.wall.projects`)
    apply(project, patch)
  }, { configPath: opts.configPath, reload: opts.reload })
}
