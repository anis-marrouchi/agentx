import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart } from "../src/storage/traces"
import { insertForgeComment } from "../src/storage/forge-comments"
import { handleWallApi, wallPost, wallPosts, type WallDeps } from "../src/daemon/wall-api"

// #1252: the Wall list reads runs, overlaps, hand-offs and forge comments
// once for every post instead of once per post. The bulk reads must give
// each post exactly what its own reads give.

const M = 60_000
const H = 60 * M
const NOW = 1_700_000_000_000

/** A small seeded random, so the data is the same on every run. */
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
}

describe("Wall bulk reads", () => {
  const home = process.cwd()
  let db: Database.Database
  let store: RequestStore
  const deps = (): WallDeps => ({
    store, db, now: NOW, staleAfterHours: 24, isAgent: () => true,
    workspaceOf: (id) => ({ coder: "/srv/work/web", pm: "/srv/work/pm", ops: "/srv/work/web" } as Record<string, string>)[id],
  })

  beforeAll(() => {
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-bulk-")))
    db = openDb({ quiet: true })!
    store = new RequestStore(db)
    const rand = rng(7)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const agents = ["coder", "pm", "ops"]
    let n = 0
    const trace = (taskId: string, agentId: string, channel: string, chatId: string, startedAt: number, minutes: number | null) => {
      recordTraceStart(db, { agentId, channel, chatId, messagePreview: "go" }, taskId)
      if (minutes === null) db.prepare("UPDATE task_traces SET started_at = ? WHERE task_id = ?").run(startedAt, taskId)
      else db.prepare("UPDATE task_traces SET status = ?, started_at = ?, finished_at = ?, duration_ms = ? WHERE task_id = ?")
        .run(rand() < 0.15 ? "error" : "ok", startedAt, startedAt + minutes * M, minutes * M, taskId)
    }
    // Background runs over three days on a few chats.
    for (let i = 0; i < 300; i++) trace(`bg-${i}`, pick(agents), "telegram", pick(["chat-0", "chat-1", "chat-2", "chat-Z"]), NOW - 72 * H + Math.floor(rand() * 72 * H), Math.floor(rand() * 40) + 1)
    for (let i = 0; i < 60; i++) {
      const id = `r${i}`
      const github = i % 3 === 0
      const chatId = github ? `acme/web:issue:${i}` : pick(["chat-0", "chat-1", "chat-2", "chat-3"])
      const channel = github ? "github" : "telegram"
      const agentId = pick(agents)
      const createdAt = NOW - Math.floor(rand() * 60 * H) - H
      const runs = 1 + Math.floor(rand() * 3)
      store.addCandidate({ id, runId: `t-${id}-0`, channel, chatId, agentId, text: `Task ${id}`, now: createdAt })
      store.progress(id, createdAt)
      for (let k = 0; k < runs; k++) {
        const taskId = `t-${id}-${k}`
        if (k > 0) store.link(id, "run", taskId, createdAt + k)
        trace(taskId, k === 2 ? pick(agents) : agentId, channel, chatId, createdAt + Math.floor(rand() * 4 * H), rand() < 0.1 ? null : Math.floor(rand() * 90) + 1)
        n++
      }
      if (github) {
        for (let c = 0; c < 1 + Math.floor(rand() * 8); c++) {
          insertForgeComment(db, { channel: "github", chatId, commentId: `${i}-${c}`, agentId, at: createdAt - 2 * H + Math.floor(rand() * 10 * H) })
        }
      }
      if (i % 7 === 1) {
        // Handed to another agent. A later hand-off whose id only starts
        // with this one's (dlg-1 and dlg-1x) must not be taken for it.
        const to = pick(agents.filter((a) => a !== agentId))
        store.link(id, "delegation", `dlg-${i}`, createdAt + 1)
        trace(`t-dlg-${i}`, to, "a2a", `a2a:${agentId}:${to}:dlg-${i}`, createdAt + 2 * M, 5)
        trace(`t-dlg-${i}x`, agentId, "a2a", `a2a:${to}:${agentId}:dlg-${i}x`, createdAt + 4 * M, 5)
        store.progress(id, createdAt + 3 * M, "waiting_other")
      }
      if (i % 11 === 4) store.waitOnOwner(id, "Which date?", createdAt + 5 * M)
      if (i % 5 === 2) store.close(id, "done", "shipped", createdAt + 6 * H)
    }
    // An open delegation with no A2A run yet, and one closed.
    store.addCandidate({ id: "r-quiet", runId: "t-quiet", channel: "telegram", chatId: "chat-9", agentId: "coder", text: "Quiet", now: NOW - 2 * H })
    store.link("r-quiet", "delegation", "dlg-none", NOW - 2 * H)
    store.progress("r-quiet", NOW - 2 * H, "waiting_other")
    expect(n).toBeGreaterThan(60)
  })

  afterAll(() => {
    closeDb()
    process.chdir(home)
  })

  it("gives every post the same runs, overlaps, hand-off and comments as its own reads", () => {
    const d = deps()
    const bulk = wallPosts(d, 7)
    expect(bulk.length).toBe(61)
    // The data must exercise each read.
    expect(bulk.some((p) => p.concurrent.length > 0)).toBe(true)
    expect(bulk.some((p) => p.comments.length === 5)).toBe(true)
    expect(bulk.some((p) => p.blockedBy?.source === "handoff")).toBe(true)
    expect(bulk.some((p) => p.runs > 1)).toBe(true)
    for (const p of bulk) expect(p).toEqual(wallPost(store.get(p.id)!, deps()))
  })

  it("gives the same posts with and without timings, and times each part", () => {
    const plain = handleWallApi("/api/admin/wall", new URLSearchParams({ days: "7" }), deps(), "node-a").body as any
    const timed = handleWallApi("/api/admin/wall", new URLSearchParams({ days: "7", timings: "1" }), deps(), "node-a").body as any
    expect(plain.timings).toBeUndefined()
    expect(timed.posts).toEqual(plain.posts)
    for (const part of ["requests", "runs", "concurrent", "handoffs", "comments", "cards", "failures", "totalMs"]) {
      expect(typeof timed.timings[part]).toBe("number")
    }
  })
})
