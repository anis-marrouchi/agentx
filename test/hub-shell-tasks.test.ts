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
  TASKS_VIEW_KEY, TASK_LANES, readTasksView, saveTasksView, shellPane, shortAgo, taskLane, taskPosts, taskStateLabel, taskTone, tasksByLane,
  type TaskPost,
} from "../src/hub/tasks"
import { OPEN_STATES, CLOSED_STATES } from "../src/requests/store"
import { TaskBoard, TaskList, TaskThread, TasksBody, TasksViewSwitch } from "../src/hub/pages/ShellTasks"
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
  it("columns are the store's open states, in order, then Closed", () => {
    expect(TASK_LANES.map((l) => l.id)).toEqual([...OPEN_STATES, "closed"])
  })
  it("every closed state goes to Closed", () => {
    for (const s of CLOSED_STATES) expect(taskLane(s)).toBe("closed")
    for (const s of OPEN_STATES) expect(taskLane(s)).toBe(s)
  })
  it("groups posts by column, every column kept", () => {
    const g = tasksByLane(sample)
    expect(g.map((x) => [x.lane.id, x.posts.map((p) => p.id)])).toEqual([
      ["in_progress", ["r1"]], ["waiting_owner", ["r2"]], ["waiting_other", []], ["needs_attention", []], ["closed", ["r3", "r4"]],
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
    expect(taskStateLabel("waiting_owner")).toBe("Waiting on you")
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
    expect(shellPane(parseHash("#page=home"))).toEqual({ pane: "chat", open: null })
    expect(shellPane(parseHash("#page=home&pane=tasks"))).toEqual({ pane: "tasks", open: null })
    expect(shellPane(parseHash("#page=home&pane=tasks&open=r1"))).toEqual({ pane: "tasks", open: "r1" })
    expect(shellPane(parseHash("#page=home&open=r1"))).toEqual({ pane: "chat", open: null })
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
    for (const p of sample) expect(out).toContain(`data-task="${p.id}"`)
    expect(out).toContain('data-lane="in_progress"')
    expect(out).toContain('data-lane="closed"')
    expect(out).not.toContain('data-lane="waiting_other"')
    expect(out).toContain('href="#page=home&amp;pane=tasks&amp;open=r1"')
    expect(out).toContain("@coder")
  })
  it("Kanban: every column, a card per task, Empty where none", () => {
    const out = html(createElement(TaskBoard, { posts: sample }))
    expect(out).toContain('data-tasks="kanban"')
    for (const l of TASK_LANES) expect(out).toContain(`data-lane="${l.id}"`)
    for (const p of sample) expect(out).toContain(`data-task="${p.id}"`)
    expect(out.match(/>Empty</g)?.length).toBe(2)
    expect(out).toContain("Dropped") // a closed task that is not done says how it closed
  })
  it("the body follows the view", () => {
    expect(html(createElement(TasksBody, { view: "list", posts: sample }))).toContain('data-tasks="list"')
    expect(html(createElement(TasksBody, { view: "kanban", posts: sample }))).toContain('data-tasks="kanban"')
  })
  it("empty: says so, with a way back to the chat", () => {
    const out = html(createElement(TasksBody, { view: "kanban", posts: [] }))
    expect(out).toContain("No tasks in the last 7 days")
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
    expect(out).toContain('href="#post=r1"')
  })
  it("an error reading it is said inline", () => {
    const out = html(createElement(TaskThread, { post: sample[0], error: "Could not read this task: down" }))
    expect(out).toContain('role="alert"')
  })
})

describe("the shell with Tasks open", () => {
  const draw = (p: Partial<SimpleShellProps> = {}) => html(createElement(SimpleShell, {
    view: resolveHubLayout(), owner: true, agents: [{ id: "ada", name: "Ada" }], agent: "ada", ...p,
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
