import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import type Database from "better-sqlite3"
import { fetchDaemonAgents, liveOverlaps } from "../src/daemon/board-dashboard"
import { findOverlaps, type RunSpan } from "../src/daemon/concurrent-runs"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart } from "../src/storage/traces"
import { wallPosts, type WallDeps } from "../src/daemon/wall-api"

// Concurrent sessions (#1187): two runs at the same time on one chat or in
// one worktree are flagged with both run ids. Back-to-back runs and runs
// on different chats are not.

const M = 60_000
const T0 = 1_700_000_000_000

const span = (runId: string, agentId: string, chat: string | null, startMin: number, endMin: number | null, worktree: string | null = null): RunSpan =>
  ({ runId, agentId, chat, worktree, startedAt: T0 + startMin * M, endedAt: endMin === null ? null : T0 + endMin * M })

describe("findOverlaps", () => {
  it("flags two runs on one chat that overlap, with both run ids", () => {
    const out = findOverlaps([span("a", "coder", "telegram:chat-A", 0, 10), span("b", "pm", "telegram:chat-A", 5, 15)], T0 + 60 * M)
    expect(out).toEqual([{
      on: ["chat"], chat: "telegram:chat-A", worktree: null, runs: ["a", "b"], agents: ["coder", "pm"], from: T0 + 5 * M, to: T0 + 10 * M,
    }])
  })

  it("does not flag back-to-back runs on one chat", () => {
    expect(findOverlaps([span("a", "coder", "telegram:chat-A", 0, 10), span("b", "coder", "telegram:chat-A", 10, 20)], T0 + 60 * M)).toEqual([])
  })

  it("does not flag overlapping runs on different chats", () => {
    expect(findOverlaps([span("a", "coder", "telegram:chat-A", 0, 10), span("b", "pm", "telegram:chat-B", 5, 15)], T0 + 60 * M)).toEqual([])
  })

  it("flags two agents' runs in one worktree on different chats, naming the folder only", () => {
    const out = findOverlaps([
      span("a", "coder", "telegram:chat-A", 0, 10, "/srv/work/web"),
      span("b", "ops", "telegram:chat-B", 5, null, "/srv/work/web"),
    ], T0 + 60 * M)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ on: ["worktree"], chat: null, worktree: "web", runs: ["a", "b"] })
  })

  it("does not flag one agent running two chats in its own workspace", () => {
    expect(findOverlaps([
      span("a", "coder", "telegram:chat-A", 0, 10, "/srv/work/web"),
      span("b", "coder", "telegram:chat-B", 5, 15, "/srv/work/web"),
    ], T0 + 60 * M)).toEqual([])
  })

  it("treats a run still going as ending now", () => {
    const out = findOverlaps([span("a", "coder", "c", 0, null), span("b", "pm", "c", 30, null)], T0 + 60 * M)
    expect(out[0]).toMatchObject({ runs: ["a", "b"], from: T0 + 30 * M, to: null })
    expect(findOverlaps([span("a", "coder", "c", 0, null), span("b", "pm", "c", 30, null)], T0 + 20 * M)).toEqual([])
  })
})

describe("Wall posts", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore
  const now = T0 + 120 * M

  const trace = (taskId: string, agentId: string, chatId: string, startMin: number, endMin: number | null) => {
    recordTraceStart(db, { agentId, channel: "telegram", chatId, messagePreview: "go" }, taskId)
    const startedAt = T0 + startMin * M
    if (endMin === null) db.prepare("UPDATE task_traces SET started_at = ? WHERE task_id = ?").run(startedAt, taskId)
    else db.prepare("UPDATE task_traces SET status = 'ok', started_at = ?, finished_at = ?, duration_ms = ? WHERE task_id = ?")
      .run(startedAt, T0 + endMin * M, (endMin - startMin) * M, taskId)
  }
  const deps = (): WallDeps => ({
    store, db, now, staleAfterHours: 24, isAgent: () => true,
    workspaceOf: (id) => ({ coder: "/srv/work/web", pm: "/srv/work/pm", ops: "/srv/work/web" } as Record<string, string>)[id],
  })
  const post = (id: string) => wallPosts(deps(), 7).find((p) => p.id === id)!

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-conc-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    // A busy day: 250 earlier runs on another chat, all finished before r1
    // starts. They must not crowd the real overlap out of the read.
    for (let i = 0; i < 250; i++) trace(`noise-${i}`, "pm", "chat-Z", -600 + i, -599 + i)
    // r1: coder's run, and pm answering the same chat at the same time.
    store.addCandidate({ id: "r1", runId: "t1", channel: "telegram", chatId: "chat-A", agentId: "coder", text: "Fix the login page", now: T0 })
    store.progress("r1", T0)
    trace("t1", "coder", "chat-A", 0, 10)
    trace("t2", "pm", "chat-A", 5, 15)
    // r2: two runs back to back on one chat.
    store.addCandidate({ id: "r2", runId: "t3", channel: "telegram", chatId: "chat-B", agentId: "pm", text: "Ship it", now: T0 })
    store.progress("r2", T0)
    store.link("r2", "run", "t4", T0)
    trace("t3", "pm", "chat-B", 20, 30)
    trace("t4", "pm", "chat-B", 30, 40)
    // r4: a run on chat-E while a run on chat-F in another worktree: no flag.
    store.addCandidate({ id: "r4", runId: "t5", channel: "telegram", chatId: "chat-E", agentId: "pm", text: "Write notes", now: T0 })
    store.progress("r4", T0)
    trace("t5", "pm", "chat-E", 50, 60)
    trace("t6", "coder", "chat-F", 50, 60)
    // r5: ops still running in coder's worktree, on another chat.
    store.addCandidate({ id: "r5", runId: "t7", channel: "telegram", chatId: "chat-G", agentId: "ops", text: "Clean the branch", now: T0 })
    store.progress("r5", T0)
    trace("t7", "ops", "chat-G", 70, null)
    trace("t8", "coder", "chat-H", 80, 90)
  })

  afterAll(() => {
    closeDb()
    process.chdir(home)
  })

  it("marks a post whose run overlapped another run on the same chat", () => {
    expect(post("r1").concurrent).toEqual([expect.objectContaining({ on: ["chat"], chat: "telegram:chat-A", runs: ["t1", "t2"], agents: ["coder", "pm"] })])
  })

  it("leaves back-to-back runs unmarked", () => {
    expect(post("r2").concurrent).toEqual([])
  })

  it("leaves runs on different chats and worktrees unmarked", () => {
    expect(post("r4").concurrent).toEqual([])
  })

  it("marks a run still going that shares a worktree, without the other chat", () => {
    const c = post("r5").concurrent
    expect(c).toEqual([expect.objectContaining({ on: ["worktree"], worktree: "web", chat: null, runs: ["t7", "t8"], to: T0 + 90 * M })])
    expect(JSON.stringify(c)).not.toContain("chat-H")
  })
})

describe("Running now", () => {
  let server: Server
  let url: string
  const started = new Date(Date.now() - 5 * M).toISOString()
  let agents: unknown[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/agents") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(agents)); return }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  const task = (id: string, chatId: string) => ({ id, traceId: `tr-${id}`, messagePreview: "go", channel: "telegram", chatId, startedAt: started })

  it("flags two runs going now on one chat, with both run ids", async () => {
    agents = [
      { id: "coder", name: "Coder", workspace: "/srv/work/web", runningTasks: [task("1", "chat-A")] },
      { id: "pm", name: "PM", workspace: "/srv/work/pm", runningTasks: [task("2", "chat-A")] },
    ]
    const out = liveOverlaps([await fetchDaemonAgents(url)])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ on: ["chat"], runs: expect.arrayContaining(["tr-1", "tr-2"]), to: null })
  })

  it("flags two agents' runs in one worktree, and never sends the full path", async () => {
    agents = [
      { id: "coder", name: "Coder", workspace: "/srv/work/web", runningTasks: [task("1", "chat-A")] },
      { id: "ops", name: "Ops", workspace: "/srv/work/web", runningTasks: [task("2", "chat-B")] },
    ]
    const node = await fetchDaemonAgents(url)
    const out = liveOverlaps([node])
    expect(out[0]).toMatchObject({ on: ["worktree"], worktree: "web" })
    expect(JSON.stringify({ node, out })).not.toContain("/srv/work")
  })

  it("does not flag runs on different chats and worktrees", async () => {
    agents = [
      { id: "coder", name: "Coder", workspace: "/srv/work/web", runningTasks: [task("1", "chat-A")] },
      { id: "pm", name: "PM", workspace: "/srv/work/pm", runningTasks: [task("2", "chat-B")] },
    ]
    expect(liveOverlaps([await fetchDaemonAgents(url)])).toEqual([])
  })

  it("leaves unreachable nodes out", async () => {
    agents = [{ id: "coder", name: "Coder", workspace: "/srv/work/web", runningTasks: [task("1", "chat-A"), task("2", "chat-A")] }]
    const node = await fetchDaemonAgents(url)
    expect(liveOverlaps([{ ...node, stale: true }])).toEqual([])
  })
})
