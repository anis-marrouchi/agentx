// --- The shell's Projects, as data (#2454) ---
//
// A project is an entry of `dashboard.wall.projects` (src/daemon/wall-projects.ts):
// a name and the repos and agents whose work is its work. The list is the
// one the old Hub's Projects view drew: the `projects` rows of the same
// Wall read Tasks uses (TASKS_URL), so both panes share one request. A
// project with work but no entry is listed by its repo; work no project
// claims is "Other". The Add dialog writes a new entry (PROJECT_ADD_URL).
//
// Plain data and pure functions, so the tests check them without a browser.
import { buildHash } from "./router"

/** Adds a project (wall-project-settings.ts), under the owner's guard. */
export const PROJECT_ADD_URL = "/api/admin/wall/project"

/** One project's open work (WallProjectRow in wall-projects.ts). */
export interface ProjectRow { project: string | null; open: number; inProgress: number; blocked: number; stalled: number }
export interface ProjectsReply { projects?: ProjectRow[]; pending?: boolean }

export type ProjectState = "stalled" | "blocked" | "moving" | "quiet"

/** One word for a project, worst first, as the old Projects cards said it. */
export function projectState(r: ProjectRow): ProjectState {
  return r.stalled ? "stalled" : r.blocked ? "blocked" : r.open ? "moving" : "quiet"
}

/** The project's tasks: the Tasks pane with its filter set. */
export const projectTasksHref = (name: string) => buildHash({ page: "home", pane: "tasks", project: name })

/** The Add dialog's text fields in a body: repos and agents are comma or
 *  space separated. A sentence when something is missing. */
export function projectAddBody(f: { name: string; repos: string; agents: string }): { problem: string; field: string } | { body: { name: string; repos: string[]; agents: string[] } } {
  const split = (s: string) => [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))]
  const name = f.name.trim()
  if (!name) return { field: "name", problem: "Give the project a name." }
  const repos = split(f.repos), agents = split(f.agents).map((a) => a.replace(/^@/, ""))
  const bad = repos.find((r) => !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(r))
  if (bad) return { field: "repos", problem: `"${bad}" is not a repo: write it as group/project.` }
  if (!repos.length && !agents.length) return { field: "repos", problem: "Name a repo or an agent, so the project has work in it." }
  return { body: { name, repos, agents } }
}
