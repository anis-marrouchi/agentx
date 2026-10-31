import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart } from "../src/storage/traces"
import { handleWallApi, wallPost, type WallDeps } from "../src/daemon/wall-api"
import { mergeGoals } from "../src/daemon/wall-goals"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// #1392: the Wall filters by the goal a request serves (#1168), with the
// goal's progress and cost over the posts.

const H = 3_600_000
const NOW = 1_700_000_000_000

describe("Wall goals", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore
  const deps = (): WallDeps => ({ store, db, now: NOW, staleAfterHours: 24, isAgent: () => true })

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-goals-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    const add = (id: string, at: number) => {
      store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: `chat-${id}`, sender: "owner", agentId: "coder", text: `Work for ${id}`, now: at })
      store.progress(id, at + 1000)
    }
    add("g1", NOW - 5 * H)
    add("g2", NOW - 4 * H)
    add("g3", NOW - 3 * H)
    add("plain", NOW - 2 * H)
    store.setGoal("g1", { id: "launch", title: "Launch the site" })
    store.setGoal("g2", { id: "launch", title: "Launch the site" })
    store.setGoal("g3", { id: "hire", title: "Hire a designer token=supersecretvalue123" })
    store.close("g1", "done", "https://example.com/pr/1", NOW - H)
    for (const [task, req, usd] of [["c1", "g1", 0.5], ["c2", "g2", 0.25], ["c3", "g2", null]] as const) {
      recordTraceStart(db, { agentId: "coder", channel: "telegram", chatId: `chat-${req}`, messagePreview: "go" }, task)
      db.prepare("UPDATE task_traces SET cost_usd = ? WHERE task_id = ?").run(usd, task)
      store.link(req, "run", task, NOW - H)
    }
  })
  afterAll(() => { closeDb(); process.chdir(home) })

  it("puts the goal on its post, and none on a post without one", () => {
    expect(wallPost(store.get("g2")!, deps()).goal).toEqual({ id: "launch", title: "Launch the site" })
    expect(wallPost(store.get("plain")!, deps()).goal).toBeNull()
  })

  // /approvals showed a promise's loop on its card; it redirects to the Hub
  // now, so the post carries it (#1440).
  it("puts a promise's loop on its post: owed to, due, the check and what it said", () => {
    store.addPromise({ id: "p1", channel: "telegram", chatId: "chat-p1", agentId: "coder", text: "Send the quote", owedTo: "client-a",
      dueAt: NOW + 2 * H, closeWhen: { kind: "url", url: "https://example.com/quote" }, now: NOW - H })
    store.markChecked("p1", "unverified", "HTTP 503 token=supersecretvalue123", NOW)
    expect(wallPost(store.get("p1")!, deps()).loop).toMatchObject({
      owedTo: "client-a", promise: true, dueAt: NOW + 2 * H, check: "https://example.com/quote answers", verifyState: "unverified",
    })
    expect(wallPost(store.get("p1")!, deps()).loop!.verifyDetail).not.toContain("supersecretvalue123")
    expect(wallPost(store.get("plain")!, deps()).loop).toBeNull()
  })

  it("redacts secrets in a goal's title", () => {
    const post = wallPost(store.get("g3")!, deps())
    expect(post.goal!.title).not.toContain("supersecretvalue123")
    const body = handleWallApi("/api/admin/wall", new URLSearchParams(), deps(), "here").body as any
    expect(JSON.stringify(body.goals)).not.toContain("supersecretvalue123")
  })

  it("lists one row per goal with progress and cost, without the request list", () => {
    const body = handleWallApi("/api/admin/wall", new URLSearchParams(), deps(), "here").body as any
    const launch = body.goals.find((g: any) => g.id === "launch")
    expect(launch).toMatchObject({ title: "Launch the site", open: 1, done: 1, dropped: 0, progress: 0.5, costUsd: 0.75, runs: 3, unpriced: 1 })
    expect(launch.requests).toBeUndefined()
    expect(store.goalCounts()).toEqual(store.goals().map(({ requests: _, ...g }) => g))
    expect(body.goals.map((g: any) => g.id).sort()).toEqual(["hire", "launch"])
  })

  it("lists no goals for a node without requests or a store without goals", () => {
    expect((handleWallApi("/api/admin/wall", new URLSearchParams(), null, "here").body as any).goals).toEqual([])
    const old: WallDeps = { ...deps(), store: { listOpen: () => [], listClosedSince: () => [], get: () => null, byLink: () => null } }
    expect((handleWallApi("/api/admin/wall", new URLSearchParams(), old, "here").body as any).goals).toEqual([])
  })

  it("adds up the same goal across nodes and keeps the newest title", () => {
    const merged = mergeGoals([
      [{ id: "launch", title: "Launch", open: 1, done: 1, dropped: 0, costUsd: 0.5, runs: 2, unpriced: 0, lastAt: 10 }],
      [{ id: "launch", title: "Launch the site", open: 0, done: 2, dropped: 1, costUsd: 0.25, runs: 1, unpriced: 1, lastAt: 20 },
        { id: "hire", title: "Hire", open: 2, done: 0, dropped: 0, costUsd: 0, runs: 0, unpriced: 0, lastAt: 5 }],
      // An older or odd peer: skipped, not thrown on.
      [null, { title: "no id" }, { id: "x" }] as unknown[],
    ])
    expect(merged.map((g) => g.id)).toEqual(["launch", "hire"])
    expect(merged[0]).toMatchObject({ title: "Launch the site", open: 1, done: 3, dropped: 1, progress: 0.75, costUsd: 0.75, runs: 3, unpriced: 1, lastAt: 20 })
    expect(merged[1].progress).toBe(0)
  })

  it("has a Goal filter, a goal line and a goal link on posts", () => {
    const html = renderWallPage()
    expect(html).toContain('id="f-goal"')
    expect(html).toContain('id="wall-goal"')
    expect(WALL_PAGE_SCRIPT).toContain("'goal'")
    expect(WALL_PAGE_SCRIPT).toContain("data-goal-clear")
    expect(WALL_PAGE_SCRIPT).toContain('role="progressbar"')
  })
})
