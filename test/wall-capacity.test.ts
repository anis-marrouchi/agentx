import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { PlanStore } from "../src/requests/plan-store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { handleWallApi, WALL_PREFIX, type WallDeps } from "../src/daemon/wall-api"
import { overCapacity, wallCapacity, type CapacityPost } from "../src/daemon/wall-capacity"
import type { WallBlocker } from "../src/daemon/wall-blocks"
import { dashboardConfigSchema } from "../src/boards/config"

// Capacity per owner on the Wall (#1191): per agent, its work in progress,
// the items waiting on it, and an over-capacity flag above a configured
// threshold (default off). Read from the Wall's posts only.

const H = 3_600_000
const NOW = Date.now()
const on = (who: string): WallBlocker => ({ kind: "agent", who, source: "handoff", project: null, crossProject: false })
const p = (owner: string, state: string, extra: Partial<CapacityPost> = {}): CapacityPost => ({ owner, state, ...extra })

// coder: two in progress; ops: one item waits on it; reviewer: one waiting_owner post (its row is zeros).
const POSTS: CapacityPost[] = [
  p("coder", "in_progress"),
  p("coder", "in_progress"),
  p("coder", "waiting_other", { blockedBy: on("ops") }),
  p("reviewer", "waiting_owner", { blockedBy: { kind: "owner", who: "owner", source: "owner", project: null, crossProject: false } }),
  p("coder", "done"),
]

describe("wallCapacity", () => {
  it("counts work in progress and items waiting per agent, with a row for each", () => {
    const c = wallCapacity(POSTS)
    expect(c.owners).toEqual([
      { owner: "coder", inProgress: 2, waiting: 0, over: false },
      { owner: "ops", inProgress: 0, waiting: 1, over: false },
      { owner: "reviewer", inProgress: 0, waiting: 0, over: false },
    ])
  })

  it("is off by default: no threshold, no flag, however loaded", () => {
    const c = wallCapacity(Array.from({ length: 50 }, () => p("coder", "in_progress")))
    expect(c.threshold).toBeNull()
    expect(c.owners[0]).toMatchObject({ inProgress: 50, over: false })
  })

  it("flags only above the threshold: under and at are not over", () => {
    const by = (t: number) => Object.fromEntries(wallCapacity(POSTS, t).owners.map((r) => [r.owner, r.over]))
    expect(by(3)).toEqual({ coder: false, ops: false, reviewer: false }) // coder under
    expect(by(2)).toEqual({ coder: false, ops: false, reviewer: false }) // coder at
    expect(by(1)).toEqual({ coder: true, ops: false, reviewer: false }) // coder over, ops at
    expect(by(0)).toEqual({ coder: true, ops: true, reviewer: false }) // nothing is never over
    expect(wallCapacity(POSTS, 1).threshold).toBe(1)
  })

  it("adds in progress and waiting together for the flag", () => {
    const posts = [p("ops", "in_progress"), p("coder", "waiting_other", { blockedBy: on("ops") })]
    expect(wallCapacity(posts, 1).owners.find((r) => r.owner === "ops")).toEqual({ owner: "ops", inProgress: 1, waiting: 1, over: true })
    expect(overCapacity(2, 2)).toBe(false)
    expect(overCapacity(3, 2)).toBe(true)
    expect(overCapacity(99, null)).toBe(false)
  })

  it("counts a plan step as the step agent's work, once, not the owner's", () => {
    const posts = [p("coder", "in_progress", { stepAgent: "ops", blockedBy: { ...on("ops"), source: "plan" } })]
    expect(wallCapacity(posts).owners).toEqual([
      { owner: "ops", inProgress: 1, waiting: 0, over: false },
      { owner: "coder", inProgress: 0, waiting: 0, over: false },
    ])
  })

  it("never counts the owner or an outside person as an agent", () => {
    const c = wallCapacity([p("coder", "waiting_other", { blockedBy: { kind: "person", who: "Sara", source: "person", project: null, crossProject: false } })])
    expect(c.owners.map((r) => r.owner)).toEqual(["coder"])
  })
})

describe("the threshold setting", () => {
  it("defaults to unset and takes a whole number", () => {
    expect(dashboardConfigSchema.parse({}).wall.capacity?.threshold).toBeUndefined()
    expect(dashboardConfigSchema.parse({ wall: { capacity: { threshold: 3 } } }).wall.capacity?.threshold).toBe(3)
    expect(() => dashboardConfigSchema.parse({ wall: { capacity: { threshold: -1 } } })).toThrow()
  })
})

describe("capacity in the Wall reply, from the records", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore
  let plans: PlanStore
  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-capacity-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    plans = new PlanStore(db)
    const open = (id: string) => {
      store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: `demo-${id}`, agentId: "coder", text: `Task ${id}`, now: NOW - H })
      store.progress(id, NOW - H)
    }
    open("a"); open("b")
    open("step")
    plans.create("step", "coder", [{ name: "Deploy", kind: "task", agentId: "ops", doneWhen: "live", needsApproval: false }] as any, NOW - H)
  })
  afterAll(() => { closeDb(); process.chdir(home) })

  const deps = (capacityThreshold?: number): WallDeps => ({ store, plans, db, now: NOW, staleAfterHours: 24, isAgent: () => true, capacityThreshold })
  const reply = (t?: number) => handleWallApi(WALL_PREFIX, new URLSearchParams(), deps(t), "node-a").body as any

  it("carries each post's active step agent and one capacity row per agent", () => {
    const body = reply()
    expect(body.posts.find((x: any) => x.id === "step").stepAgent).toBe("ops")
    expect(body.posts.find((x: any) => x.id === "a").stepAgent).toBeNull()
    expect(body.capacity).toEqual({ threshold: null, owners: [
      { owner: "coder", inProgress: 2, waiting: 0, over: false },
      { owner: "ops", inProgress: 1, waiting: 0, over: false },
    ] })
  })

  it("flags with the configured threshold", () => {
    expect(reply(1).capacity.owners.map((r: any) => [r.owner, r.over])).toEqual([["coder", true], ["ops", false]])
  })

  it("answers with empty capacity on a node that keeps no requests", () => {
    expect((handleWallApi(WALL_PREFIX, new URLSearchParams(), null, "node-a").body as any).capacity).toEqual({ threshold: null, owners: [] })
  })
})
