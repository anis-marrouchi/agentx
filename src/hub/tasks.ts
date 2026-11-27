// --- The shell's Tasks, as data (#2226 S4) ---
//
// Tasks in the simple shell are two lists in one:
// - the open issues and open pull/merge requests of the GitHub repos and
//   GitLab projects this node works on (`GET /api/admin/hub/tasks`, see
//   src/daemon/hub-forge-tasks.ts);
// - the requests given to the agents, as the old Hub's feed lists them
//   (`GET /api/admin/wall?peer=fleet`, see src/daemon/wall-api.ts).
// A request whose home is one of those issues or PRs stands for it (it has
// the timeline). The columns are the request states the store keeps
// (src/requests/store.ts), with To do first for issues nobody has picked up.
//
// Plain data and pure functions, so the tests check them without a browser.
import type { ForgeTask, ForgeTasksReply } from "../daemon/hub-forge-tasks"

/** Where the list is read: every node's posts, quick (what is cached now). */
export const TASKS_URL = "/api/admin/wall?peer=fleet&days=7&quick=1"
/** The forges' open issues and PRs (cached a minute on the server). */
export const FORGE_TASKS_URL = "/api/admin/hub/tasks"
/** One post and its timeline; a peer's post is asked of that peer. */
export const taskThreadUrl = (id: string) => "/api/admin/wall/thread?id=" + encodeURIComponent(id)

/** The part of a Wall post the shell draws (WallPost in wall-api.ts). */
export interface TaskPost {
  id: string
  state: string
  headline: string
  owner: string
  project: string | null
  updatedAt: number
  home?: { kind: string; link: string } | null
  /** Set on posts read across the mesh: the node that keeps it. */
  node?: { name?: string; peer?: string } | null
  /** Set on a forge issue or PR: it opens on the forge, not in the shell. */
  forge?: { kind: "issue" | "pr"; ref: string; url: string } | null
}

export interface TasksReply { posts?: TaskPost[]; pending?: boolean }

export interface TaskEvent { at: number; kind: string; who: string | null; text: string; status?: string | null }
export interface TaskThreadReply { post?: TaskPost; events?: TaskEvent[] }

export type TaskLaneId = "todo" | "in_progress" | "waiting_owner" | "waiting_other" | "needs_attention" | "closed"
export type TaskTone = "work" | "warn" | "idle" | "err" | "ok"

export interface TaskLane { id: TaskLaneId; label: string; tone: TaskTone }

/** The columns: To do (forge issues nobody has picked up), the store's
 *  open states in its order, closed last. `waiting_owner` reads "In review":
 *  the work waits for your answer, approval or review ("Waiting on you" is
 *  the side menu's own page). */
export const TASK_LANES: readonly TaskLane[] = [
  { id: "todo", label: "To do", tone: "idle" },
  { id: "in_progress", label: "In progress", tone: "work" },
  { id: "waiting_owner", label: "In review", tone: "warn" },
  { id: "waiting_other", label: "Waiting on others", tone: "idle" },
  { id: "needs_attention", label: "Needs attention", tone: "err" },
  { id: "closed", label: "Closed", tone: "ok" },
]

/** The column a state goes in: done, declined and dropped are Closed. */
export function taskLane(state: string): TaskLaneId {
  return TASK_LANES.some((l) => l.id === state && l.id !== "closed") ? state as TaskLaneId : "closed"
}

/** The dot's tone for a state: its column's, but grey for a closed task
 *  that was not done (declined, dropped). */
export function taskTone(state: string): TaskTone {
  const id = taskLane(state)
  return id === "closed" && state !== "done" ? "idle" : TASK_LANES.find((l) => l.id === id)!.tone
}

/** The state in words, as the old Hub writes it ("waiting owner" → lane label). */
export function taskStateLabel(state: string): string {
  const lane = TASK_LANES.find((l) => l.id === state)
  return lane ? lane.label : state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ")
}

/** The posts of a reply, newest move first; rows without an id are dropped. */
export function taskPosts(reply: TasksReply | null | undefined): TaskPost[] {
  const list = Array.isArray(reply?.posts) ? reply!.posts : []
  return list.filter((p) => p && p.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** The column of a forge issue or PR. A GitLab board's `Status::` label
 *  says it first; else a draft PR, or one sent back with changes asked,
 *  is in progress, any other open PR is in review, an issue someone is
 *  assigned to is in progress, and one nobody has is to do. */
export function forgeLane(t: Pick<ForgeTask, "kind" | "assignees" | "labels" | "draft" | "review">): TaskLaneId {
  const status = t.labels.map((l) => /^status::\s*(.+)$/i.exec(l)?.[1]?.toLowerCase()).find(Boolean)
  if (status === "doing" || status === "in progress") return "in_progress"
  if (status === "review") return "waiting_owner"
  if (status === "on hold") return "waiting_other"
  if (t.kind === "pr") return t.draft || t.review === "changes_requested" ? "in_progress" : "waiting_owner"
  return t.assignees.length ? "in_progress" : "todo"
}

/** The forge reply as posts: who has it (else who opened it), its
 *  repository as the project, its link. */
export function forgePosts(reply: ForgeTasksReply | null | undefined): TaskPost[] {
  const list = Array.isArray(reply?.items) ? reply!.items : []
  return list.filter((t) => t && t.id && t.url).map((t) => ({
    id: t.id, state: forgeLane(t), headline: t.title, owner: t.assignees[0] ?? t.author ?? "",
    project: t.project, updatedAt: t.updatedAt,
    forge: { kind: t.kind, ref: (t.forge === "gitlab" && t.kind === "pr" ? "!" : "#") + t.number, url: t.url },
  }))
}

/** Requests and forge items in one list, newest move first. A forge item a
 *  request points at (its home) is left out: the request stands for it. */
export function mergeTasks(requests: TaskPost[], forge: TaskPost[]): TaskPost[] {
  const homes = new Set(requests.map((p) => p.home?.link).filter(Boolean))
  return [...requests, ...forge.filter((p) => !homes.has(p.forge?.url))].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** The projects the forges could not be read for, in words (one still
 *  being read is not a failure: the pane asks again in a moment). */
export function forgeUnread(reply: ForgeTasksReply | null | undefined): string | null {
  const list = (Array.isArray(reply?.unread) ? reply!.unread : []).filter((u) => !u.late)
  return list.length ? "Not read: " + list.map((u) => `${u.project} (${u.why})`).join(", ") : null
}

/** Each column with its posts, every column kept (an empty one says so). */
export function tasksByLane(posts: TaskPost[]): { lane: TaskLane; posts: TaskPost[] }[] {
  return TASK_LANES.map((lane) => ({ lane, posts: posts.filter((p) => taskLane(p.state) === lane.id) }))
}

// --- List or Kanban, remembered in this browser ---

export type TasksView = "list" | "kanban"
export const TASKS_VIEW_KEY = "agentx.hub.tasksView"

type Store = Pick<Storage, "getItem" | "setItem">
const browserStore = (): Store | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage } catch { return null }
}

export function readTasksView(store: Store | null = browserStore()): TasksView {
  try { return store?.getItem(TASKS_VIEW_KEY) === "kanban" ? "kanban" : "list" } catch { return "list" }
}

export function saveTasksView(view: TasksView, store: Store | null = browserStore()): void {
  try { store?.setItem(TASKS_VIEW_KEY, view) } catch { /* private mode: the choice lasts this visit */ }
}

// --- The shell's centre ---

export type ShellPane = "chat" | "tasks" | "automations" | "waiting" | "projects" | "activity"
const PANES: readonly ShellPane[] = ["tasks", "automations", "waiting", "projects", "activity"]

/** What the centre shows for this hash: `#page=home&pane=tasks&open=<id>`,
 *  `&pane=tasks&project=<name>`, `&pane=automations`, `&pane=waiting&open=<key>`,
 *  `&pane=projects` (#2454). */
export function shellPane(params: URLSearchParams): { pane: ShellPane; open: string | null; project: string | null } {
  const want = params.get("pane") as ShellPane | null
  const pane: ShellPane = want && PANES.includes(want) ? want : "chat"
  const opens = pane === "tasks" || pane === "waiting"
  return { pane, open: opens ? params.get("open") || null : null, project: pane === "tasks" ? params.get("project") || null : null }
}

// --- The project filter (#2226: "for the selected project") ---

/** The projects the tasks name, by name; tasks without one are left out. */
export function taskProjects(posts: TaskPost[]): string[] {
  return [...new Set(posts.map((p) => p.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b))
}

/** The tasks of one project, or all of them when none is picked. */
export function tasksOfProject(posts: TaskPost[], project: string | null): TaskPost[] {
  return project ? posts.filter((p) => p.project === project) : posts
}

/** "5m", "3h", "2d": how long ago, short. */
export function shortAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}
