import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { handleWallApi, WALL_PREFIX, type WallDeps } from "../src/daemon/wall-api"
import { wallProjects } from "../src/daemon/wall-projects"
import { claimClosure, wallThroughput, weekIndex } from "../src/daemon/wall-throughput"

// Weekly throughput on the Wall (#1192): closures per week, per project and
// per owner, over four rolling weeks, from closedAt and the project mapping.

const H = 3_600_000
const DAY = 24 * H
const WEEK = 7 * DAY
const NOW = 1_800_000_000_000

describe("weekIndex", () => {
  it("puts the last seven days in week 0 and a closure exactly seven days ago in week 1", () => {
    expect(weekIndex(NOW, NOW)).toBe(0)
    expect(weekIndex(NOW - WEEK + 1, NOW)).toBe(0)
    expect(weekIndex(NOW - WEEK, NOW)).toBe(1)
    expect(weekIndex(NOW - 2 * WEEK, NOW)).toBe(2)
  })

  it("leaves out anything four weeks old or more", () => {
    expect(weekIndex(NOW - 4 * WEEK + 1, NOW)).toBe(3)
    expect(weekIndex(NOW - 4 * WEEK, NOW)).toBe(-1)
    expect(weekIndex(NOW - 60 * DAY, NOW)).toBe(-1)
  })

  it("counts a closure stamped a little ahead (another node's clock) in this week", () => {
    expect(weekIndex(NOW + 5000, NOW)).toBe(0)
  })
})

describe("wallThroughput", () => {
  const c = (owner: string, project: string | null, agoMs: number) => ({ owner, project, closedAt: NOW - agoMs })

  it("counts per week oldest first, per project and per owner", () => {
    const t = wallThroughput([
      c("coder", "Web", 1 * H), c("coder", "Web", 2 * DAY), c("ops", "Ops", WEEK), c("coder", "Web", 3 * WEEK + DAY),
      c("ops", null, 10 * DAY), c("ops", "Ops", 5 * WEEK),
    ], { now: NOW, projectNames: ["Web", "Ops", "Docs"] })
    expect(t.weeks).toHaveLength(4)
    expect(t.weeks[0]).toEqual({ from: NOW - 4 * WEEK, to: NOW - 3 * WEEK })
    expect(t.weeks[3]).toEqual({ from: NOW - WEEK, to: NOW })
    expect(t.projects).toEqual([
      { project: "Web", weeks: [1, 0, 0, 2], total: 3 },
      { project: "Ops", weeks: [0, 0, 1, 0], total: 1 },
      { project: "Docs", weeks: [0, 0, 0, 0], total: 0 },
      { project: null, weeks: [0, 0, 1, 0], total: 1 },
    ])
    expect(t.owners).toEqual([
      { owner: "coder", weeks: [1, 0, 0, 2], total: 3 },
      { owner: "ops", weeks: [0, 0, 2, 0], total: 2 },
    ])
  })

  it("gives owners with no closures a row of zeros, after the busy ones", () => {
    const t = wallThroughput([c("coder", "Web", H)], { now: NOW, owners: ["writer", "coder"] })
    expect(t.owners).toEqual([
      { owner: "coder", weeks: [0, 0, 0, 1], total: 1 },
      { owner: "writer", weeks: [0, 0, 0, 0], total: 0 },
    ])
  })

  it("is empty with no closures and no names", () => {
    const t = wallThroughput([], { now: NOW })
    expect(t.projects).toEqual([])
    expect(t.owners).toEqual([])
  })
})

describe("a peer's closure through this node's mapping", () => {
  const m = wallProjects({ projects: [{ name: "Ops", agents: ["ops"], repos: [], workspaces: [] }] }, 24)

  it("is renamed when an entry here claims it, else kept", () => {
    const peer = { owner: "ops", agentId: "ops", project: "peer-name", repo: null, closedAt: NOW }
    expect(claimClosure(peer, m).project).toBe("Ops")
    const other = { ...peer, owner: "x", agentId: "x" }
    expect(claimClosure(other, m)).toBe(other)
    expect(claimClosure(peer, null).project).toBe("peer-name")
  })
})

describe("the throughput reply", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-tp-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    const add = (id: string, agentId: string, at: number, chatId = `chat-${id}`) => {
      store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId, agentId, text: `Task ${id}`, now: at })
      store.progress(id, at)
    }
    add("a", "coder", NOW - 3 * DAY, "acme/web:issue:1")
    store.close("a", "done", "https://example.com/pr/1", NOW - 2 * DAY)
    add("b", "ops", NOW - 12 * DAY)
    store.close("b", "dropped", "not needed", NOW - 9 * DAY)
    add("c", "coder", NOW - 40 * DAY)
    store.close("c", "done", "old", NOW - 35 * DAY)
    // Open, never closed: its owner still gets a row.
    add("d", "writer", NOW - DAY)
  })
  afterAll(() => { closeDb(); process.chdir(home) })

  const deps = (): WallDeps => ({
    store, db, now: NOW, staleAfterHours: 24, isAgent: () => true,
    projects: wallProjects({ projects: [{ name: "Web", repos: ["acme/web"], agents: [], workspaces: [] }] }, 24),
  })

  it("lists this node's closures of the last four weeks with their project, and counts them", () => {
    const r = handleWallApi(`${WALL_PREFIX}/throughput`, new URLSearchParams(), deps(), "n")
    expect(r.status).toBe(200)
    const body = r.body as any
    expect(body.closures.map((x: any) => [x.owner, x.project, x.repo])).toEqual([["coder", "Web", "acme/web"], ["ops", null, null]])
    expect(body.owners).toEqual(["writer"])
    expect(body.throughput.projects).toEqual([
      { project: "Web", weeks: [0, 0, 0, 1], total: 1 },
      { project: null, weeks: [0, 0, 1, 0], total: 1 },
    ])
    expect(body.throughput.owners.map((o: any) => [o.owner, o.total])).toEqual([["coder", 1], ["ops", 1], ["writer", 0]])
  })

  it("answers with empty lists on a node that keeps no requests", () => {
    const body = handleWallApi(`${WALL_PREFIX}/throughput`, new URLSearchParams(), null, "n").body as any
    expect(body.closures).toEqual([])
    expect(body.throughput.projects).toEqual([])
  })
})
