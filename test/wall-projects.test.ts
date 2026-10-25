import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { handleWallApi, WALL_PREFIX, type WallDeps, type WallPost } from "../src/daemon/wall-api"
import { claimPost, isStalled, projectOverview, wallProjects, type WallProjectsConfig } from "../src/daemon/wall-projects"
import { isStalledPost } from "../src/daemon/wall-portfolio"
import { dashboardConfigSchema } from "../src/boards/config"

// The Wall's project overview (#1190): a read-only mapping (home repo,
// agent, workspace → project), one row per project with open, in
// progress, blocked and stalled counts, unmapped work under "Other".

const H = 3_600_000
const NOW = 1_800_000_000_000

const CFG: WallProjectsConfig = {
  rhythmHours: 12,
  projects: [
    { name: "Web", repos: ["acme/web"], rhythmHours: 4 },
    { name: "Ops", agents: ["ops"] },
    { name: "Docs", workspaces: ["/srv/work/docs"] },
  ],
}
const WORKSPACES: Record<string, string> = { writer: "/srv/work/docs/site", coder: "/srv/work/web", ops: "/srv/work/ops" }

describe("wallProjects mapping", () => {
  const m = wallProjects(CFG, 24, (id) => WORKSPACES[id])
  const req = (agentId: string, askedAgent: string | null = null) => ({ home: null, chatId: "c", agentId, askedAgent })

  it("maps by home repo first, then agent, then workspace", () => {
    expect(m.of(req("ops"), "acme/web")).toEqual({ name: "Web", rhythmHours: 4 })
    expect(m.of(req("ops"), null)).toEqual({ name: "Ops", rhythmHours: 12 })
    expect(m.of(req("writer"), null)).toEqual({ name: "Docs", rhythmHours: 12 })
  })

  it("matches a workspace folder whole, not by its first letters", () => {
    const m2 = wallProjects({ projects: [{ name: "Docs", workspaces: ["/srv/work/doc"] }] }, 24, (id) => WORKSPACES[id])
    expect(m2.of(req("writer"), null).name).toBeNull()
  })

  it("maps by the owner the work was handed to before the agent it was asked of", () => {
    expect(m.of(req("writer", "ops"), null).name).toBe("Ops")
  })

  it("puts unmapped work under Other (no project), even with a home repo", () => {
    expect(m.of(req("coder"), "acme/api")).toEqual({ name: null, rhythmHours: 12 })
    expect(m.of(req("coder"), null)).toEqual({ name: null, rhythmHours: 12 })
  })

  it("with no config maps nothing and uses the default rhythm", () => {
    const none = wallProjects(undefined, 24)
    expect(none.names).toEqual([])
    expect(none.of(req("ops"), "acme/web")).toEqual({ name: "acme/web", rhythmHours: 24 })
  })

  it("is optional and empty in the dashboard config", () => {
    expect(dashboardConfigSchema.parse({}).wall).toEqual({ projects: [] })
    expect(() => dashboardConfigSchema.parse({ wall: { projects: [{ name: "" }] } })).toThrow()
    expect(() => dashboardConfigSchema.parse({ wall: { rhythmHours: 0 } })).toThrow()
  })
})

describe("isStalled", () => {
  const p = (state: string, idleHours: number, rhythmHours = 24) => ({ state, lastMoveAt: NOW - idleHours * H, rhythmHours })

  it("is stalled only past twice the rhythm", () => {
    expect(isStalled(p("in_progress", 47), NOW)).toBe(false)
    expect(isStalled(p("in_progress", 48), NOW)).toBe(false)
    expect(isStalled(p("in_progress", 48.01), NOW)).toBe(true)
  })

  it("uses the project's own rhythm", () => {
    expect(isStalled(p("waiting_other", 9, 4), NOW)).toBe(true)
    expect(isStalled(p("waiting_other", 9, 12), NOW)).toBe(false)
  })

  it("never counts closed work", () => {
    expect(isStalled(p("done", 500), NOW)).toBe(false)
    expect(isStalled(p("dropped", 500), NOW)).toBe(false)
  })
})

describe("projectOverview", () => {
  const post = (project: string | null, state: string, blocked = false, stalled = false) => ({ project, state, blocked: blocked ? { who: "x" } : null, stalled })

  it("counts open, in progress, blocked and stalled per project, closed work not at all", () => {
    const rows = projectOverview([
      post("Web", "in_progress"), post("Web", "in_progress", false, true), post("Web", "waiting_other", true), post("Web", "done"),
      post("Ops", "waiting_owner", true, true),
    ], ["Web", "Ops"])
    expect(rows).toEqual([
      { project: "Web", open: 3, inProgress: 2, blocked: 1, stalled: 1 },
      { project: "Ops", open: 1, inProgress: 0, blocked: 1, stalled: 1 },
    ])
  })

  it("lists configured projects with nothing open, in config order, then others by name, then Other", () => {
    const rows = projectOverview([post(null, "in_progress"), post("zeta/repo", "in_progress"), post("alpha/repo", "needs_attention", true)], ["Web", "Docs"])
    expect(rows.map((r) => r.project)).toEqual(["Web", "Docs", "alpha/repo", "zeta/repo", null])
    expect(rows[0]).toEqual({ project: "Web", open: 0, inProgress: 0, blocked: 0, stalled: 0 })
    expect(rows[4]).toMatchObject({ project: null, open: 1, inProgress: 1 })
  })
})

describe("Wall reply with the mapping set", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-proj-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    const open = (id: string, agentId: string, ageHours: number, chatId = `chat-${id}`) => {
      store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId, agentId, text: `Task ${id}`, now: NOW - ageHours * H })
      store.progress(id, NOW - ageHours * H)
    }
    // Web (rhythm 4 h): one fresh, one quiet 9 h (stalled, not yet blocked:
    // blocked keeps the requests' 24 h), one on its GitLab chat.
    open("w1", "coder", 1)
    store.setHome("w1", { kind: "issue", link: "https://gitlab.example.com/acme/web/-/issues/1" }, NOW - 1 * H)
    open("w2", "coder", 9)
    store.setHome("w2", { kind: "issue", link: "https://gitlab.example.com/acme/web/-/issues/2" }, NOW - 9 * H)
    open("w3", "coder", 2, "acme/web:issue:3")
    // Ops, by agent: waits on the owner.
    open("o1", "ops", 3)
    store.waitOnOwner("o1", "Which day?", NOW - 3 * H)
    // Docs, by workspace: closed, not counted.
    open("d1", "writer", 5)
    store.close("d1", "done", "https://example.com/pr/1", NOW - 1 * H)
    // No repo, no mapped agent: Other, quiet 30 h with a 12 h rhythm.
    open("x1", "coder", 30)
  })
  afterAll(() => { closeDb(); process.chdir(home) })

  const deps = (): WallDeps => ({
    store, db, now: NOW, staleAfterHours: 24, isAgent: () => true,
    workspaceOf: (id) => WORKSPACES[id],
    projects: wallProjects(CFG, 24, (id) => WORKSPACES[id]),
  })

  it("names each post's project and marks the stalled ones", () => {
    const body = handleWallApi(WALL_PREFIX, new URLSearchParams(), deps(), "n").body as { posts: WallPost[] }
    const by = Object.fromEntries(body.posts.map((p) => [p.id, p]))
    expect(by.w1).toMatchObject({ project: "Web", rhythmHours: 4, stalled: false })
    expect(by.w2).toMatchObject({ project: "Web", stalled: true })
    expect(by.w3.project).toBe("Web")
    expect(by.o1).toMatchObject({ project: "Ops", rhythmHours: 12, stalled: false })
    expect(by.d1).toMatchObject({ project: "Docs", stalled: false })
    expect(by.x1).toMatchObject({ project: null, stalled: true })
  })

  it("returns one overview row per project with Other last", () => {
    const body = handleWallApi(WALL_PREFIX, new URLSearchParams(), deps(), "n").body as any
    expect(body.projects).toEqual([
      { project: "Web", open: 3, inProgress: 3, blocked: 0, stalled: 1 },
      { project: "Ops", open: 1, inProgress: 0, blocked: 1, stalled: 0 },
      { project: "Docs", open: 0, inProgress: 0, blocked: 0, stalled: 0 },
      { project: null, open: 1, inProgress: 1, blocked: 1, stalled: 1 },
    ])
  })

  it("without the mapping keeps the home repo as the project", () => {
    const body = handleWallApi(WALL_PREFIX, new URLSearchParams(), { ...deps(), projects: null }, "n").body as any
    expect(body.posts.find((p: WallPost) => p.id === "w1").project).toBe("acme/web")
    expect(body.projects.map((r: any) => r.project)).toEqual(["acme/web", null])
  })
})

describe("a peer's post through this node's mapping", () => {
  const m = wallProjects(CFG, 24)
  const peer = (extra: Record<string, unknown> = {}) => ({
    id: "p", owner: "ops", agentId: "ops", repo: null as string | null, project: "peer-name" as string | null,
    state: "in_progress", lastMoveAt: NOW - 20 * H, rhythmHours: 48, stalled: false, ...extra,
  })

  it("renames it and redoes the stalled mark when an entry here claims it", () => {
    expect(claimPost(peer(), m, NOW)).toMatchObject({ project: "Ops", rhythmHours: 12, stalled: false })
    expect(claimPost(peer({ lastMoveAt: NOW - 25 * H }), m, NOW)).toMatchObject({ project: "Ops", stalled: true })
    expect(claimPost(peer({ owner: "x", agentId: "x", repo: "ACME/web" }), m, NOW)).toMatchObject({ project: "Web", rhythmHours: 4, stalled: true })
  })

  it("keeps what its own node said when nothing here claims it", () => {
    const p = peer({ owner: "x", agentId: "x" })
    expect(claimPost(p, m, NOW)).toBe(p)
    expect(claimPost(peer(), null, NOW).project).toBe("peer-name")
  })
})

describe("the portfolio's stalled count", () => {
  it("uses the Wall's mark when the post has one, else twice the stale time", () => {
    const base = { state: "in_progress", lastMoveAt: NOW - 30 * H }
    expect(isStalledPost({ ...base, stalled: false }, NOW, 12)).toBe(false)
    expect(isStalledPost({ ...base, stalled: true }, NOW, 48)).toBe(true)
    expect(isStalledPost(base, NOW, 12)).toBe(true)
  })
})
