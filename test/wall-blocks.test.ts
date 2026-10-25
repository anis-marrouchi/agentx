import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { PlanStore } from "../src/requests/plan-store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "../src/storage/traces"
import { wallPosts, type WallDeps, type WallPost } from "../src/daemon/wall-api"
import { wallProjects, type WallProjectsConfig } from "../src/daemon/wall-projects"
import { blockerOf, claimBlocker } from "../src/daemon/wall-blocks"

// Cross-project and cross-agent blocks on the Wall (#1193): a blocked
// post names the agent, owner or person a record says it waits on, the
// blocking agent's project from the mapping, and whether that project is
// another one. A post that is only quiet has no blocker.

const H = 3_600_000
const NOW = Date.now()

const CFG: WallProjectsConfig = {
  projects: [
    { name: "Web", repos: ["acme/web"], agents: ["coder", "reviewer"] },
    { name: "Ops", agents: ["ops"] },
  ],
}
const m = wallProjects(CFG, 24)

describe("blockerOf", () => {
  const at = (extra: Partial<Parameters<typeof blockerOf>[0]>) =>
    blockerOf({ owner: "coder", project: "Web", handedTo: null, stepAgent: null, waitsOn: { group: "agent", who: "coder" }, ...extra }, m)

  it("marks a hand-off to an agent in another project as cross-project", () => {
    expect(at({ handedTo: "ops", waitsOn: { group: "agent", who: "ops" } }))
      .toEqual({ kind: "agent", who: "ops", source: "handoff", project: "Ops", crossProject: true })
  })

  it("keeps a block inside one project as not cross-project", () => {
    expect(at({ handedTo: "reviewer" })).toEqual({ kind: "agent", who: "reviewer", source: "handoff", project: "Web", crossProject: false })
  })

  it("reads another agent's active plan step when there is no hand-off", () => {
    expect(at({ stepAgent: "ops" })).toMatchObject({ who: "ops", source: "plan", crossProject: true })
  })

  it("invents nothing: a quiet post, or one waiting on its own step, has no blocker", () => {
    expect(at({})).toBeNull()
    expect(at({ stepAgent: "coder" })).toBeNull()
    expect(at({ handedTo: "coder" })).toBeNull()
  })

  it("names the owner and an outside person, with no project", () => {
    expect(at({ waitsOn: { group: "owner", who: "owner" } })).toEqual({ kind: "owner", who: "owner", source: "owner", project: null, crossProject: false })
    expect(at({ waitsOn: { group: "person", who: "Sara" } })).toMatchObject({ kind: "person", who: "Sara", project: null })
  })

  it("gives an agent no mapping names no project, so never cross-project", () => {
    expect(at({ handedTo: "stranger" })).toMatchObject({ who: "stranger", project: null, crossProject: false })
    expect(blockerOf({ owner: "coder", project: null, handedTo: "ops", stepAgent: null, waitsOn: { group: "agent", who: "ops" } }, m))
      .toMatchObject({ project: "Ops", crossProject: false })
  })
})

describe("a peer's blocker through this node's mapping", () => {
  it("redoes the blocking agent's project when an entry here names it, else keeps it", () => {
    const p = { project: "Web", blockedBy: { kind: "agent" as const, who: "ops", source: "handoff" as const, project: null, crossProject: false } }
    expect(claimBlocker(p, m).blockedBy).toMatchObject({ project: "Ops", crossProject: true })
    const q = { ...p, blockedBy: { ...p.blockedBy, who: "stranger" } }
    expect(claimBlocker(q, m)).toBe(q)
    expect(claimBlocker({ project: "Web", blockedBy: null }, m).blockedBy).toBeNull()
  })
})

describe("blocked posts from the records", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore
  let plans: PlanStore

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-blocks-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    plans = new PlanStore(db)
    const open = (id: string, ageHours: number) => {
      store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: `acme/web:issue:${id.length}${id}`, agentId: "coder", text: `Task ${id}`, now: NOW - ageHours * H })
    }
    const handoff = (id: string, to: string, ageHours: number) => {
      store.link(id, "delegation", `dlg-${id}`, NOW - ageHours * H)
      recordTraceStart(db, { agentId: to, channel: "a2a", chatId: `a2a:coder:${to}:dlg-${id}`, messagePreview: "go" }, `t-dlg-${id}`)
      recordTraceEnd(db, `t-dlg-${id}`, { status: "ok", finalResponse: "on it" } as any)
      store.progress(id, NOW - ageHours * H, "waiting_other")
    }
    // Across projects: Web work handed to ops, 5 h ago.
    open("across", 6); handoff("across", "ops", 5)
    // Inside one project: handed to reviewer (Web), 2 h ago.
    open("inside", 3); handoff("inside", "reviewer", 2)
    // Waiting on ops's plan step, no hand-off.
    open("step", 4)
    plans.create("step", "coder", [{ name: "Deploy", kind: "task", agentId: "ops", doneWhen: "live", needsApproval: false }] as any, NOW - 4 * H)
    store.progress("step", NOW - 4 * H, "waiting_other")
    // Quiet for 30 h, nothing recorded against it: blocked, no blocker.
    open("quiet", 30)
    store.progress("quiet", NOW - 30 * H)
  })
  afterAll(() => { closeDb(); process.chdir(home) })

  const deps = (): WallDeps => ({ store, plans, db, now: NOW, staleAfterHours: 24, isAgent: () => true, projects: m })
  const posts = () => Object.fromEntries(wallPosts(deps(), 7).map((p) => [p.id, p])) as Record<string, WallPost>

  it("names the blocker, its project and since when, across and inside projects", () => {
    const by = posts()
    expect(by.across.project).toBe("Web")
    expect(by.across.blocked).toMatchObject({ who: "ops", since: NOW - 5 * H })
    expect(by.across.blockedBy).toEqual({ kind: "agent", who: "ops", source: "handoff", project: "Ops", crossProject: true })
    expect(by.inside.blockedBy).toEqual({ kind: "agent", who: "reviewer", source: "handoff", project: "Web", crossProject: false })
    expect(by.step.blockedBy).toMatchObject({ who: "ops", source: "plan", crossProject: true })
  })

  it("leaves a blocked post with nothing recorded against it without a blocker", () => {
    const q = posts().quiet
    expect(q.blocked).not.toBeNull()
    expect(q.blockedBy).toBeNull()
  })
})
