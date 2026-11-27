import { applyConfigMutation, type MutationResult } from "./config-mutator"
import type { WallProjectEntry } from "./wall-projects"

// --- Add a project from the Hub's Projects page (#2454) ---
//
// A project on the Projects page is an entry of `dashboard.wall.projects`
// (wall-projects.ts): a name and the repos and agents whose work is its
// work. The page's Add dialog writes one here. agentx.json stays the only
// copy: the change goes through applyConfigMutation (schema check, write,
// daemon reload), as budgets do (budget-settings.ts).

export interface WallProjectAdd {
  name: string
  repos: string[]
  agents: string[]
}

const REPO = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/
const list = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))] : []

/** Read the Add dialog's body. A problem in words, or the entry to add. */
export function wallProjectAdd(body: Record<string, unknown>): { problem: string } | { entry: WallProjectAdd } {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return { problem: "Give the project a name." }
  if (name.length > 80) return { problem: "Keep the name under 80 characters." }
  const repos = list(body.repos), agents = list(body.agents)
  const bad = repos.find((r) => !REPO.test(r))
  if (bad) return { problem: `"${bad}" is not a repo: write it as group/project.` }
  if (!repos.length && !agents.length) return { problem: "Name a repo or an agent, so the project has work in it." }
  return { entry: { name, repos, agents } }
}

export async function addWallProject(entry: WallProjectAdd, opts: { configPath?: string; reload?: boolean } = {}): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const dash = (cfg.dashboard ??= {})
    const wall = (dash.wall ??= {})
    const projects: WallProjectEntry[] = Array.isArray(wall.projects) ? wall.projects : (wall.projects = [])
    if (projects.some((p) => p?.name?.toLowerCase() === entry.name.toLowerCase())) throw new Error(`a project named "${entry.name}" already exists`)
    const add: WallProjectEntry = { name: entry.name }
    if (entry.repos.length) add.repos = entry.repos
    if (entry.agents.length) add.agents = entry.agents
    projects.push(add)
  }, { configPath: opts.configPath, reload: opts.reload })
}
