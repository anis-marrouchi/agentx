// Tasks by project (#2587 PR 2): a request is under the project it is filed
// under, the filter has No project and a count per project, and an opened
// request shows the picker that moves it.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  NO_PROJECT, projectLabel, taskPosts, taskProjectCounts, tasksOfProject, typedProjectKey, type TaskPost,
} from "../src/hub/tasks"
import { TaskThread, TasksBody, TasksProjectFilter } from "../src/hub/pages/ShellTasks"
import { TooltipProvider } from "../src/hub/ui"

const now = Date.now()
const posts: TaskPost[] = [
  { id: "r1", state: "in_progress", headline: "Fix the login page", owner: "coder", project: "acme/site", updatedAt: now },
  { id: "r2", state: "waiting_owner", headline: "Pick a logo", owner: "designer", project: null, updatedAt: now - 1000 },
  { id: "r3", state: "done", headline: "Ship the menu", owner: "coder", project: "acme/site", updatedAt: now - 2000 },
  { id: "f1", state: "todo", headline: "Broken link", owner: "sam", project: "acme/app", updatedAt: now - 3000, forge: { kind: "issue", ref: "#4", url: "https://example.com/acme/app/issues/4" } },
]
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))

describe("a request's own project", () => {
  it("wins over the Wall's mapped project, null included", () => {
    const read = taskPosts({ posts: [
      { ...posts[0], project: "Mapped", requestProject: "acme/site" },
      { ...posts[1], project: "Mapped", requestProject: null },
    ] })
    expect(read.map((p) => [p.id, p.project])).toEqual([["r1", "acme/site"], ["r2", null]])
  })
  it("a node too old to send one keeps the mapped project", () => {
    expect(taskPosts({ posts: [{ ...posts[0], project: "Mapped" }] })[0].project).toBe("Mapped")
  })
})

describe("the filter", () => {
  it("counts each project and the tasks with none", () => {
    const c = taskProjectCounts(posts)
    expect([...c.counts]).toEqual([["acme/site", 2], ["acme/app", 1]])
    expect(c.none).toBe(1)
  })
  it("No project shows the tasks with none", () => {
    expect(tasksOfProject(posts, NO_PROJECT).map((p) => p.id)).toEqual(["r2"])
    expect(tasksOfProject(posts, "acme/site").map((p) => p.id)).toEqual(["r1", "r3"])
    expect(tasksOfProject(posts, null)).toHaveLength(4)
  })
  it("names No project in words", () => {
    expect(projectLabel(NO_PROJECT)).toBe("No project")
    expect(projectLabel(null)).toBe("No project")
    expect(projectLabel("acme/site")).toBe("acme/site")
  })
  it("the trigger says No project when it is picked", () => {
    const out = html(createElement(TasksProjectFilter, { projects: ["acme/site"], project: NO_PROJECT, counts: taskProjectCounts(posts) }))
    expect(out).toContain("No project")
  })
  it("an empty No project says every task has one, with a way back", () => {
    const out = html(createElement(TasksBody, { view: "list", posts: [posts[0]], project: NO_PROJECT }))
    expect(out).toContain("Every task has a project")
    expect(out).toContain("All projects")
  })
})

describe("moving a request", () => {
  it("an opened request shows its project as the move picker", () => {
    const out = html(createElement(TaskThread, { post: posts[1], events: [], projects: ["acme/site"] }))
    expect(out).toContain('data-shell="task-project"')
    expect(out).toContain("No project")
    expect(out).toContain("Move to a project")
  })
  it("an issue or PR has no picker: its project is its repository", () => {
    const out = html(createElement(TaskThread, { post: posts[3], events: [], projects: ["acme/site"] }))
    expect(out).not.toContain('data-shell="task-project"')
  })
  it("a typed key is trimmed; spaces and none are not keys", () => {
    expect(typedProjectKey("  acme/new ")).toBe("acme/new")
    expect(typedProjectKey("two words")).toBeNull()
    expect(typedProjectKey("none")).toBeNull()
    expect(typedProjectKey("")).toBeNull()
  })
})
