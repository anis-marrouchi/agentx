import { repoOfChat, wallProjects, type WallProjectsConfig } from "@/daemon/wall-projects"

// --- Which project a run's spend counts toward (#1290) ---
//
// The same mapping the Wall uses (`dashboard.wall.projects`): the run's
// repo (from its forge chat), else its agent, else its agent's workspace
// folder. Null when no entry claims it; the run then counts only toward
// its agent and the fleet.

export interface BudgetProjectsSource {
  agents?: Record<string, { workspace?: string }>
  dashboard?: { wall?: WallProjectsConfig }
}

export type BudgetProjectResolver = (agentId: string, chatId?: string) => string | null

export function budgetProjectResolver(cfg: BudgetProjectsSource): BudgetProjectResolver {
  if (!cfg.dashboard?.wall?.projects?.length) return () => null
  // The rhythm is unused here; any number does.
  const projects = wallProjects(cfg.dashboard.wall, 24, (id) => cfg.agents?.[id]?.workspace ?? null)
  return (agentId, chatId) => projects.claim([agentId], repoOfChat(chatId))?.name ?? null
}

/** Spend per project from per-(agent, chat) rows, as the traces hold them. */
export function spendByProject(rows: Array<{ agentId: string; chatId: string | null; usd: number }>, resolve: BudgetProjectResolver): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const p = resolve(r.agentId, r.chatId ?? undefined)
    if (p && r.usd > 0) out[p] = (out[p] ?? 0) + r.usd
  }
  return out
}
