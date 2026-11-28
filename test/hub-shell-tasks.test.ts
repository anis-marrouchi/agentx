// Tasks in the React simple shell (#2226 S4): the columns from the request
// states, the List and the Kanban drawn for sample tasks, the switch and
// where it is kept, the empty and error states, and an opened task.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout } from "../src/hub/layout"
import { SHELL_MAIN } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import {
  TASKS_VIEW_KEY, TASK_LANES, forgeLane, forgePosts, forgeUnread, mergeTasks, readTasksView, saveTasksView, shellPane, shortAgo, taskLane, taskPosts, taskProjects, taskStateLabel, taskTone, tasksByLane, tasksOfProject,
  type TaskPost,
} from "../src/hub/tasks"
import { OPEN_STATES, CLOSED_STATES } from "../src/requests/store"
import { TaskBoard, TaskList, TaskThread, TasksBody, TasksProjectFilter, TasksViewSwitch, taskHref } from "../src/hub/pages/ShellTasks"
import { SimpleShell, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { TooltipProvider } from "../src/hub/ui"

const now = Date.now()
const sample: TaskPost[] = [
  { id: "r1", state: "in_progress", headline: "Fix the login page", owner: "coder", project: "agentx", updatedAt: now - 5 * 60_000 },
  { id: "r2", state: "waiting_owner", headline: "Pick a logo", owner: "designer", project: null, updatedAt: now - 3 * 3_600_000 },
  { id: "r3", state: "done", headline: "Ship 0.277", owner: "release", project: "agentx", updatedAt: now - 2 * 86_400_000 },
  { id: "r4", state: "dropped", headline: "Old idea", owner: "pm", project: null, updatedAt: now - 3 * 86_400_000 },
]
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))

describe("tasks as data", () => {
  it("columns: To do, the store's open states in order, then Closed", () => {
    expect(TASK_LANES.map((l) => l.id)).toEqual(["todo", ...OPEN_STATES, "closed"])
  })
  it("every closed state goes to Closed", () => {
    for (const s of CLOSED_STATES) expect(taskLane(s)).toBe("closed")
    for (const s of OPEN_STATES) expect(taskLane(s)).toBe(s)
  })
  it("groups posts by column, every column kept", () => {
    const g = tasksByLane(sample)
    expect(g.map((x) => [x.lane.id, x.posts.map((p) => p.id)])).toEqual([
      ["todo", []], ["in_progress", ["r1"]], ["waiting_owner", ["r2"]], ["waiting_other", []], ["needs_attention", []], ["closed", ["r3", "r4"]],
    ])
  })
  it("reads the Wall reply, newest move first, drops rows without an id", () => {
    const posts = taskPosts({ posts: [sample[2], { ...sample[0] }, { id: "" } as TaskPost] })
    expect(posts.map((p) => p.id)).toEqual(["r1", "r3"])
    expect(taskPosts(null)).toEqual([])
    expect(taskPosts({})).toEqual([])
  })
  it("a closed task that was not done reads grey, done reads ok", () => {
    expect(taskTone("done")).toBe("ok")
    expect(taskTone("dropped")).toBe("idle")
    expect(taskTone("needs_attention")).toBe("err")
  })
  it("states in words", () => {
    // Not "Waiting on you": that is the side menu's own page (#2324 review, C4).
    expect(taskStateLabel("waiting_owner")).toBe("In review")
    expect(taskStateLabel("dropped")).toBe("Dropped")
  })
  it("short time ago", () => {
    expect(shortAgo(now - 10_000, now)).toBe("now")
    expect(shortAgo(now - 5 * 60_000, now)).toBe("5m")
    expect(shortAgo(now - 3 * 3_600_000, now)).toBe("3h")
    expect(shortAgo(now - 2 * 86_400_000, now)).toBe("2d")
  })
})

describe("the centre from the hash", () => {
  it("chat by default, tasks with pane=tasks, a task with open=", () => {
    expect(shellPane(parseHash("#page=home"))).toEqual({ pane: "chat", open: null, project: null })
    expect(shellPane(parseHash("#page=home&pane=tasks"))).toEqual({ pane: "tasks", open: null, project: null })
    expect(shellPane(parseHash("#page=home&pane=tasks&open=r1"))).toEqual({ pane: "tasks", open: "r1", project: null })
    expect(shellPane(parseHash("#page=home&open=r1"))).toEqual({ pane: "chat", open: null, project: null })
  })
  it("the Tasks menu item opens the pane in the shell, not the old Hub", () => {
    expect(SHELL_MAIN.find((i) => i.id === "tasks")?.href).toBe("#page=home&pane=tasks")
  })
})

describe("List or Kanban, remembered", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } }
  it("List until Kanban is picked, then Kanban", () => {
    const s = mem()
    expect(readTasksView(s)).toBe("list")
    saveTasksView("kanban", s)
    expect(s.m.get(TASKS_VIEW_KEY)).toBe("kanban")
    expect(readTasksView(s)).toBe("kanban")
    saveTasksView("list", s)
    expect(readTasksView(s)).toBe("list")
  })
  it("no storage, or a storage that throws: List, no error", () => {
    expect(readTasksView(null)).toBe("list")
    const bad = { getItem: () => { throw new Error("x") }, setItem: () => { throw new Error("x") } }
    expect(readTasksView(bad)).toBe("list")
    expect(() => saveTasksView("kanban", bad)).not.toThrow()
  })
  it("the switch marks the view in use", () => {
    const out = html(createElement(TasksViewSwitch, { view: "kanban", onView: () => {} }))
    expect(out).toMatch(/aria-pressed="false"[^>]*data-tasks-view="list"/)
    expect(out).toMatch(/aria-pressed="true"[^>]*data-tasks-view="kanban"/)
  })
})

describe("List and Kanban for sample tasks", () => {
  it("List: one row per task under its column, empty columns left out", () => {
    const out = html(createElement(TaskList, { posts: sample }))
    expect(out).toContain('data-tasks="list"')
    // Closed starts folded (orca-design C22): its rows draw when it opens.
    for (const id of ["r1", "r2"]) expect(out).toContain(`data-task="${id}"`)
    expect(out).not.toContain('data-task="r3"')
    expect(out).toContain('data-lane="in_progress"')
    expect(out).toMatch(/data-state="closed"[^>]*data-lane="closed"|data-lane="closed"[^>]*data-state="closed"/)
    expect(out).toContain('data-slot="collapsible-trigger"')
    expect(out).not.toContain('data-lane="waiting_other"')
    expect(out).toContain('href="#page=home&amp;pane=tasks&amp;open=r1"')
    expect(out).toContain("@coder")
  })
  it("Kanban: every column, a card per task, Empty where none", () => {
    const out = html(createElement(TaskBoard, { posts: sample }))
    expect(out).toContain('data-tasks="kanban"')
    for (const l of TASK_LANES) expect(out).toContain(`data-lane="${l.id}"`)
    for (const p of sample) expect(out).toContain(`data-task="${p.id}"`)
    expect(out.match(/>Empty</g)?.length).toBe(3)
    expect(out).toContain("Dropped") // a closed task that is not done says how it closed
  })
  it("the body follows the view", () => {
    expect(html(createElement(TasksBody, { view: "list", posts: sample }))).toContain('data-tasks="list"')
    expect(html(createElement(TasksBody, { view: "kanban", posts: sample }))).toContain('data-tasks="kanban"')
  })
  it("empty: says so, with a way back to the chat", () => {
    const out = html(createElement(TasksBody, { view: "kanban", posts: [] }))
    expect(out).toContain("No tasks")
    expect(out).toContain('href="#page=home"')
    expect(out).not.toContain('data-tasks="kanban"')
  })
  it("error: the reason and Try again", () => {
    const out = html(createElement(TasksBody, { view: "list", error: "unauthorized" }))
    expect(out).toContain("Could not read the tasks")
    expect(out).toContain('role="alert"')
    expect(out).toContain("unauthorized")
    expect(out).toContain("Try again")
  })
  it("loading: placeholders, no list yet", () => {
    const out = html(createElement(TasksBody, { view: "list" }))
    expect(out).toContain("animate-pulse")
    expect(out).not.toContain('data-tasks="list"')
  })
})

describe("an opened task", () => {
  it("its state, its timeline and a link to the full record", () => {
    const out = html(createElement(TaskThread, {
      post: sample[0],
      events: [{ at: now - 60_000, kind: "asked", who: "anis", text: "Fix the login page" }, { at: now, kind: "run", who: "coder", text: "Opened PR #12", status: "ok" }],
    }))
    expect(out).toContain('data-tasks="open"')
    expect(out).toContain("In progress")
    expect(out).toContain('data-event="run"')
    expect(out).toContain("Opened PR #12")
    // Full record opens its Task page (#2101 T3).
    expect(out).toContain('href="#page=task&amp;id=r1"')
  })
  it("an error reading it is said inline", () => {
    const out = html(createElement(TaskThread, { post: sample[0], error: "Could not read this task: down" }))
    expect(out).toContain('role="alert"')
  })
})

describe("the shell with Tasks open", () => {
  const draw = (p: Partial<SimpleShellProps> = {}) => html(createElement(SimpleShell, {
    view: resolveHubLayout({ layout: "simple" }), owner: true, agents: [{ id: "ada", name: "Ada" }], agent: "ada", ...p,
  }))
  it("the centre is Tasks, the menu marks Tasks and has the switch at its foot", () => {
    const out = draw({ pane: "tasks", tasksView: "kanban", onTasksView: () => {} })
    expect(out).toContain('data-shell="tasks"')
    expect(out).not.toContain('data-shell="chat"')
    expect(out).toMatch(/aria-current="page"[^>]*>[\s\S]*?Tasks</)
    expect(out).toContain('data-shell="tasks-switch"')
    expect(out).not.toMatch(/data-shell-agent="ada" aria-pressed="true"/)
  })
  it("the chat: no switch, Tasks not marked", () => {
    const out = draw()
    expect(out).toContain('data-shell="chat"')
    expect(out).not.toContain('data-shell="tasks-switch"')
    expect(out).not.toContain('aria-current="page"')
  })
})

describe("the project filter (#2226 S5)", () => {
  it("lists the projects the tasks name, sorted, once each", () => {
    expect(taskProjects(sample)).toEqual(["agentx"])
    expect(taskProjects([...sample, { ...sample[0], id: "r5", project: "docs" }])).toEqual(["agentx", "docs"])
  })
  it("keeps one project's tasks, or all of them", () => {
    expect(tasksOfProject(sample, "agentx").map((p) => p.id)).toEqual(["r1", "r3"])
    expect(tasksOfProject(sample, null)).toBe(sample)
  })
  it("the project is read from the hash, for Tasks only", () => {
    expect(shellPane(parseHash("#page=home&pane=tasks&project=agentx"))).toEqual({ pane: "tasks", open: null, project: "agentx" })
    expect(shellPane(parseHash("#page=home&pane=automations&project=agentx")).project).toBeNull()
  })
  it("the body shows the project's tasks, and a task's link keeps the project", () => {
    const out = html(createElement(TasksBody, { view: "list", posts: sample, project: "agentx" }))
    expect(out).toContain('data-task="r1"')
    expect(out).not.toContain('data-task="r2"')
    expect(out).toContain('href="#page=home&amp;pane=tasks&amp;project=agentx&amp;open=r1"')
  })
  it("a project with no task: says so, with a way back to all", () => {
    const out = html(createElement(TasksBody, { view: "kanban", posts: sample, project: "shop" }))
    expect(out).toContain("No tasks in shop")
    expect(out).toContain("All projects")
  })
  it("the filter offers every project, and the one picked", () => {
    const out = html(createElement(TasksProjectFilter, { projects: ["agentx", "docs"], project: "gone" }))
    // The S4 Select: the picked project shows on its trigger; the list draws when it opens.
    expect(out).toContain('data-shell="tasks-project"')
    expect(out).toContain('role="combobox"')
    expect(out).toContain(">gone<")
    expect(html(createElement(TasksProjectFilter, { projects: ["agentx"], project: null }))).toContain(">All projects<")
    expect(taskHref("r1", "agentx")).toBe("#page=home&pane=tasks&project=agentx&open=r1")
  })
  it("on a phone the switch is icons only, still named for screen readers", () => {
    const out = html(createElement(TasksViewSwitch, { view: "list", onView: () => {}, compact: true }))
    expect(out).toContain('aria-label="List"')
    expect(out).toContain('aria-label="Kanban"')
    expect(out).not.toContain(">List<")
  })
})

// Forge issues and PRs in Tasks (#2226: "Tasks lists issues and open PRs from
// GitHub and GitLab"), and a failed poll that keeps the board (#2324 C3).
describe("forge issues and PRs", () => {
  const ft = (over: Record<string, unknown> = {}) => ({
    id: "github:acme/shop#7", forge: "github" as const, kind: "issue" as const, project: "acme/shop", number: 7,
    title: "Cart total is wrong", url: "https://github.example/acme/shop/issues/7", author: "sam", assignees: [] as string[],
    labels: [] as string[], updatedAt: now - 60_000, ...over,
  })
  it("the column: To do, assigned, draft, sent back, in review, a GitLab Status:: label", () => {
    expect(forgeLane(ft())).toBe("todo")
    expect(forgeLane(ft({ assignees: ["coder"] }))).toBe("in_progress")
    expect(forgeLane(ft({ kind: "pr", draft: true }))).toBe("in_progress")
    expect(forgeLane(ft({ kind: "pr", review: "changes_requested" }))).toBe("in_progress")
    expect(forgeLane(ft({ kind: "pr", review: "review_required" }))).toBe("waiting_owner")
    expect(forgeLane(ft({ kind: "pr" }))).toBe("waiting_owner")
    expect(forgeLane(ft({ labels: ["Status::Review"] }))).toBe("waiting_owner")
    expect(forgeLane(ft({ labels: ["bug", "Status::On Hold"] }))).toBe("waiting_other")
    expect(forgeLane(ft({ kind: "pr", labels: ["Status::Doing"] }))).toBe("in_progress")
  })
  it("as posts: who has it (else who opened it), its repo, its ref and link", () => {
    const posts = forgePosts({ items: [ft(), ft({ id: "gitlab:grp/app!4", forge: "gitlab", kind: "pr", project: "grp/app", number: 4, url: "https://gitlab.example/grp/app/-/merge_requests/4", assignees: ["dev"] })], unread: [] })
    expect(posts[0]).toMatchObject({ id: "github:acme/shop#7", state: "todo", owner: "sam", project: "acme/shop", forge: { kind: "issue", ref: "#7" } })
    expect(posts[1]).toMatchObject({ owner: "dev", state: "waiting_owner", forge: { kind: "pr", ref: "!4" } })
    expect(forgePosts(null)).toEqual([])
  })
  it("a request whose home is the issue stands for it; the rest are merged, newest first", () => {
    const forge = forgePosts({ items: [ft(), ft({ id: "github:acme/shop#8", number: 8, url: "https://github.example/acme/shop/issues/8", updatedAt: now })], unread: [] })
    const req: TaskPost = { ...sample[0], home: { kind: "github-issue", link: "https://github.example/acme/shop/issues/7" } }
    expect(mergeTasks([req], forge).map((p) => p.id)).toEqual(["github:acme/shop#8", "r1"])
  })
  it("projects not read are named; one still being read is not", () => {
    expect(forgeUnread({ items: [], unread: [{ forge: "gitlab", project: "grp/app", why: "HTTP 401" }, { forge: "github", project: "acme/shop", why: "still being read", late: true }] })).toBe("Not read: grp/app (HTTP 401)")
    expect(forgeUnread({ items: [], unread: [] })).toBeNull()
  })
  it("an issue or PR opens on its forge, in a new tab, with its kind", () => {
    const out = html(createElement(TaskList, { posts: forgePosts({ items: [ft(), ft({ id: "github:acme/shop#9", kind: "pr", number: 9, url: "https://github.example/acme/shop/pull/9" })], unread: [] }) }))
    expect(out).toContain('href="https://github.example/acme/shop/issues/7" target="_blank" rel="noreferrer"')
    expect(out).toContain('data-task-kind="issue"')
    expect(out).toContain('data-task-kind="pr"')
    expect(out).toContain("acme/shop#7")
    expect(out).toContain('data-lane="todo"')
    const board = html(createElement(TaskBoard, { posts: forgePosts({ items: [ft()], unread: [] }) }))
    expect(board).toContain('href="https://github.example/acme/shop/issues/7"')
  })
})

describe("a failed refresh keeps the tasks (#2324 C3)", () => {
  it("with tasks shown: they stay, the reason is one line above with Try again", () => {
    const out = html(createElement(TasksBody, { view: "kanban", posts: sample, error: "requests: HTTP 502" }))
    expect(out).toContain('data-tasks="kanban"')
    expect(out).toContain('data-tasks="notice"')
    expect(out).toMatch(/role="alert"[^>]*>[\s\S]*Could not refresh: requests: HTTP 502/)
    expect(out).toContain("Try again")
    expect(out).not.toContain("Could not read the tasks")
  })
  it("with nothing read yet: the error fills the pane", () => {
    const out = html(createElement(TasksBody, { view: "kanban", error: "HTTP 502" }))
    expect(out).toContain("Could not read the tasks")
    expect(out).not.toContain('data-tasks="kanban"')
  })
  it("projects not read are said quietly, the tasks stay", () => {
    const out = html(createElement(TasksBody, { view: "list", posts: sample, notice: "Not read: grp/app (HTTP 401)" }))
    expect(out).toContain('role="status"')
    expect(out).toContain("Not read: grp/app (HTTP 401)")
    expect(out).toContain('data-tasks="list"')
    expect(out).not.toContain('role="alert"')
  })
  it("no notice line when all is well", () => {
    expect(html(createElement(TasksBody, { view: "list", posts: sample }))).not.toContain('data-tasks="notice"')
  })
})
