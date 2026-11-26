// --- The shell's Tasks, as data (#2226 S4) ---
//
// Tasks in the simple shell are the posts the old Hub's feed lists: one per
// request, read from the same reply (`GET /api/admin/wall?peer=fleet`, see
// src/daemon/wall-api.ts). Nothing new on the server. The columns are the
// request states the store keeps (src/requests/store.ts): the four open
// states, then the closed ones of the last days together.
//
// Plain data and pure functions, so the tests check them without a browser.

/** Where the list is read: every node's posts, quick (what is cached now). */
export const TASKS_URL = "/api/admin/wall?peer=fleet&days=7&quick=1"
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
}

export interface TasksReply { posts?: TaskPost[]; pending?: boolean }

export interface TaskEvent { at: number; kind: string; who: string | null; text: string; status?: string | null }
export interface TaskThreadReply { post?: TaskPost; events?: TaskEvent[] }

export type TaskLaneId = "in_progress" | "waiting_owner" | "waiting_other" | "needs_attention" | "closed"
export type TaskTone = "work" | "warn" | "idle" | "err" | "ok"

export interface TaskLane { id: TaskLaneId; label: string; tone: TaskTone }

/** The columns, in the store's order of open states, closed last. */
export const TASK_LANES: readonly TaskLane[] = [
  { id: "in_progress", label: "In progress", tone: "work" },
  { id: "waiting_owner", label: "Waiting on you", tone: "warn" },
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

export type ShellPane = "chat" | "tasks" | "automations" | "waiting"
const PANES: readonly ShellPane[] = ["tasks", "automations", "waiting"]

/** What the centre shows for this hash: `#page=home&pane=tasks&open=<id>`,
 *  `&pane=tasks&project=<name>`, `&pane=automations`, `&pane=waiting&open=<key>`. */
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
