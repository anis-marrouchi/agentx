// Projects in the React simple shell (#2454): the menu opens it in the
// shell's centre (not the old Hub), the pane says how to add a project when
// empty and when filled, the Add action is the owner's, and the dialog's
// body lands in dashboard.wall.projects.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SHELL_MAIN } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import { shellPane } from "../src/hub/tasks"
import { projectAddBody, projectState, projectTasksHref } from "../src/hub/projects"
import { PROJECT_HELP, ProjectsBody, ProjectsPane } from "../src/hub/pages/ShellProjects"
import { Button, TooltipProvider } from "../src/hub/ui"
import { addWallProject, wallProjectAdd } from "../src/daemon/wall-project-settings"
import { WALL_PROJECT_PATH, isWallWrite } from "../src/daemon/wall-actions"

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))
const row = (project: string | null, o: Partial<{ open: number; inProgress: number; blocked: number; stalled: number }> = {}) =>
  ({ project, open: 0, inProgress: 0, blocked: 0, stalled: 0, ...o })

describe("Projects in the shell menu", () => {
  it("opens in the shell's centre, as Tasks and Automations do", () => {
    const item = SHELL_MAIN.find((i) => i.id === "projects")!
    expect(item.href).toBe("#page=home&pane=projects")
    const p = parseHash(item.href!)
    expect(p.get("page")).toBe("home")
    expect(shellPane(p).pane).toBe("projects")
  })
})

describe("project rows", () => {
  it("says the worst state first", () => {
    expect(projectState(row("a", { open: 2, blocked: 1, stalled: 1 }))).toBe("stalled")
    expect(projectState(row("a", { open: 2, blocked: 1 }))).toBe("blocked")
    expect(projectState(row("a", { open: 1 }))).toBe("moving")
    expect(projectState(row("a"))).toBe("quiet")
  })
  it("links a project to its tasks", () => {
    expect(projectTasksHref("Shop")).toBe("#page=home&pane=tasks&project=Shop")
  })
})

describe("the Add dialog's body", () => {
  it("splits repos and agents and drops a leading @", () => {
    expect(projectAddBody({ name: " Shop ", repos: "acme/shop, acme/api acme/shop", agents: "@coder" }))
      .toEqual({ body: { name: "Shop", repos: ["acme/shop", "acme/api"], agents: ["coder"] } })
  })
  it("asks for a name, a well-formed repo, and a repo or an agent", () => {
    expect(projectAddBody({ name: "", repos: "a/b", agents: "" })).toMatchObject({ field: "name" })
    expect(projectAddBody({ name: "X", repos: "shop", agents: "" })).toMatchObject({ field: "repos", problem: expect.stringContaining("group/project") })
    expect(projectAddBody({ name: "X", repos: "", agents: "" })).toMatchObject({ field: "repos" })
  })
})

describe("the Projects pane", () => {
  const add = createElement(Button, { "data-projects": "add" } as never, "Add project")
  it("empty: says how to add one and offers Add", () => {
    const out = html(createElement(ProjectsBody, { rows: [], add }))
    expect(out).toContain("No projects yet")
    expect(out).toContain(PROJECT_HELP.slice(0, 40))
    expect(out).toContain('data-projects="add"')
  })
  it("filled: the same help, each project with its counts and a link to its tasks", () => {
    const out = html(createElement(ProjectsBody, { rows: [row("Shop", { open: 3, inProgress: 1 }), row(null, { open: 1 })], add }))
    expect(out).toContain('data-projects="help"')
    expect(out).toContain('data-project="Shop"')
    expect(out).toContain('href="#page=home&amp;pane=tasks&amp;project=Shop"')
    expect(out).toContain("Other")
    expect(out).toContain("Moving")
  })
  it("error: says so with Try again", () => {
    const out = html(createElement(ProjectsBody, { error: "offline" }))
    expect(out).toContain("Could not read the projects")
    expect(out).toContain("Try again")
  })
  it("draws its own header (the shell's centre), loading first", () => {
    const out = html(createElement(ProjectsPane, { owner: true }))
    expect(out).toContain('data-shell="projects"')
    expect(out).toContain("<h1")
  })
})

describe("adding a project to agentx.json", () => {
  let dir: string, file: string
  const read = () => JSON.parse(readFileSync(file, "utf-8"))
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-wall-project-"))
    file = join(dir, "agentx.json")
    writeFileSync(file, JSON.stringify({
      node: { id: "t", name: "t" },
      agents: { coder: { name: "Coder", workspace: dir } },
      dashboard: { wall: { projects: [{ name: "Shop", repos: ["acme/shop"] }] } },
    }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("is an owner-only Wall write", () => {
    expect(isWallWrite("POST", WALL_PROJECT_PATH)).toBe(true)
  })
  it("checks the body the server gets", () => {
    expect(wallProjectAdd({ name: "", repos: ["a/b"] })).toEqual({ problem: "Give the project a name." })
    expect(wallProjectAdd({ name: "X", repos: ["nope"] })).toMatchObject({ problem: expect.stringContaining("group/project") })
    expect(wallProjectAdd({ name: "X" })).toMatchObject({ problem: expect.stringContaining("repo or an agent") })
    expect(wallProjectAdd({ name: "Api", repos: ["acme/api"], agents: ["coder", 3] })).toEqual({ entry: { name: "Api", repos: ["acme/api"], agents: ["coder"] } })
  })
  it("appends the entry and refuses a name taken", async () => {
    expect((await addWallProject({ name: "Api", repos: ["acme/api"], agents: [] }, { configPath: file, reload: false })).success).toBe(true)
    expect(read().dashboard.wall.projects).toEqual([{ name: "Shop", repos: ["acme/shop"] }, { name: "Api", repos: ["acme/api"] }])
    const again = await addWallProject({ name: "shop", repos: [], agents: ["coder"] }, { configPath: file, reload: false })
    expect(again.success).toBe(false)
    expect(again.error).toContain("already exists")
  })
})
