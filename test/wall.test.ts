import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import type Database from "better-sqlite3"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { redactSecrets } from "../src/agents/memory-trust"
import { RequestStore } from "../src/requests/store"
import { PlanStore } from "../src/requests/plan-store"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "../src/storage/traces"
import {
  a2aRoute, handleWallApi, mentionsIn, projectOf, sourceIdsIn, wallFailures, wallPosts, wallThread, type WallDeps,
} from "../src/daemon/wall-api"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"

// The Wall (#1180): every request as a post, its runs, hand-offs and plan
// steps as the thread. Read-only over the request, plan and trace records;
// driven through the dashboard's own request handler for the routes.

const home = process.cwd()
let db: Database.Database
let store: RequestStore
let plans: PlanStore
let server: Server
let base: string
let token: string | undefined
const H = 3_600_000
const T0 = Date.now() - 10 * H

function deps(now = Date.now()): WallDeps {
  return { store, plans, db, now, staleAfterHours: 24, isAgent: (id) => ["coder", "pm", "secretary"].includes(id) }
}

function run(taskId: string, agentId: string, chatId: string, end: { status: "ok" | "error" | "timeout"; text?: string; error?: string }) {
  recordTraceStart(db, { agentId, channel: chatId.startsWith("a2a:") ? "a2a" : "telegram", chatId, messagePreview: "go" }, taskId)
  recordTraceEnd(db, taskId, { status: end.status, finalResponse: end.text, error: end.error } as any)
}

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method: "GET", headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location as string | undefined }))
    })
    r.on("error", reject)
    r.end()
  })
}

beforeAll(async () => {
  closeDb()
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-")))
  writeFileSync("agentx.json", JSON.stringify({ agents: { coder: { name: "Coder" } } }))
  db = openDb({ quiet: true })!
  store = new RequestStore(db)
  plans = new PlanStore(db)

  // r1: open, in progress, a run, a hand-off to pm with pm's run, a plan, a GitLab home.
  store.addCandidate({ id: "r1", runId: "t1", channel: "telegram", chatId: "chat-A", sender: "anis", agentId: "coder", text: "Fix the login page, see #42 and token=supersecretvalue123", now: T0 })
  store.progress("r1", T0 + 1000)
  store.setHome("r1", { kind: "issue", link: "https://gitlab.example.com/acme/web/-/issues/42" }, T0 + 2000)
  store.link("r1", "delegation", "dlg-abc123", T0 + 3000)
  run("t1", "coder", "chat-A", { status: "ok", text: "Asked @pm to check, commit 1a2b3c4d" })
  run("t2", "pm", "a2a:coder:pm:dlg-abc123-x", { status: "ok", text: "Checked, looks fine" })
  plans.create("r1", "coder", [
    { name: "Write the fix", kind: "code", agentId: "coder", doneWhen: "PR open", needsApproval: false },
    { name: "Review", kind: "review", agentId: "pm", doneWhen: "approved", needsApproval: false },
  ] as any, T0 + 4000)

  // r2: waiting on the owner, in another chat, a failed run twice in a row.
  store.addCandidate({ id: "r2", runId: "t3", channel: "telegram", chatId: "chat-B", sender: "sara", agentId: "pm", text: "Ship the release", now: T0 + 5000 })
  store.link("r2", "run", "t4", T0 + 6000)
  store.waitOnOwner("r2", "Which day?", T0 + 7000)
  run("t3", "pm", "chat-B", { status: "error", error: "spawn failed after 3000 ms" })
  run("t4", "pm", "chat-B", { status: "error", error: "spawn failed after 4100 ms" })

  // r3: closed today.
  store.addCandidate({ id: "r3", runId: "t5", channel: "gitlab", chatId: "acme/api:issue:7", agentId: "coder", text: "Close the old branch", now: T0 + 8000 })
  store.progress("r3", T0 + 8500)
  store.close("r3", "done", "https://gitlab.example.com/acme/api/-/merge_requests/9", T0 + 9000)
  run("t5", "coder", "acme/api:issue:7", { status: "ok", text: "Done" })

  // A run in chat-A that is not linked to any request: never in a post.
  run("t-other", "coder", "chat-A", { status: "ok", text: "unrelated chat-A turn" })

  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, agents: { coder: { name: "Coder", workspace: process.cwd() } } })
  server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
})

describe("posts", () => {
  it("lists open requests and the recently closed, newest move first", () => {
    const posts = wallPosts(deps(), 7)
    expect(posts.map((p) => p.id).sort()).toEqual(["r1", "r2", "r3"])
    const r1 = posts.find((p) => p.id === "r1")!
    expect(r1.owner).toBe("coder")
    expect(r1.group).toEqual({ channel: "telegram", chatId: "chat-A" })
    expect(r1.project).toBe("acme/web")
    expect(r1.home?.link).toContain("/issues/42")
    expect(r1.runs).toBe(1)
    expect(r1.lastRun).toEqual({ taskId: "t1", agentId: "coder" })
    expect(r1.blocked).toBeNull()
  })

  it("marks a post waiting on the owner as blocked, with who and since when", () => {
    const r2 = wallPosts(deps(), 7).find((p) => p.id === "r2")!
    expect(r2.blocked).toEqual({ who: "owner", why: "Which day?", since: T0 + 7000 })
    expect(r2.failedRuns).toBe(2)
  })

  it("keeps closed posts with their proof, and drops them outside the days asked", () => {
    const r3 = wallPosts(deps(), 7).find((p) => p.id === "r3")!
    expect(r3.state).toBe("done")
    expect(r3.evidence).toContain("merge_requests/9")
    expect(r3.project).toBe("acme/web".replace("web", "api"))
    expect(wallPosts(deps(Date.now() + 9 * 24 * H), 7).some((p) => p.id === "r3")).toBe(false)
  })

  it("redacts credentials in what it shows", () => {
    const thread = wallThread(store.get("r1")!, deps())
    expect(thread[0].text).toContain("[redacted]")
    expect(JSON.stringify(thread)).not.toContain("supersecretvalue123")
  })
})

describe("thread", () => {
  it("orders the ask, runs, home, hand-off, the other agent's run and the plan by time", () => {
    const events = wallThread(store.get("r1")!, deps())
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe("asked")
    expect(kinds).toContain("home")
    expect(kinds).toContain("plan")
    const handoff = events.find((e) => e.kind === "handoff")!
    expect(handoff.route).toEqual({ from: "coder", to: "pm" })
    const pmRun = events.find((e) => e.kind === "run" && e.who === "pm")!
    expect(pmRun.route).toEqual({ from: "coder", to: "pm" })
    expect(events.find((e) => e.kind === "plan" && e.text.includes("created"))).toBeTruthy()
    for (let i = 1; i < events.length; i++) expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at)
  })

  it("shows @mentions as hand-offs and keeps source ids to check against", () => {
    const run1 = wallThread(store.get("r1")!, deps()).find((e) => e.ref === "t1")!
    expect(run1.mentions).toEqual(["pm"])
    expect(run1.ids).toContain("1a2b3c4d")
  })

  it("never pulls a run from the same chat that is not linked to the request", () => {
    const events = wallThread(store.get("r1")!, deps())
    expect(events.some((e) => e.ref === "t-other")).toBe(false)
    expect(JSON.stringify(events)).not.toContain("unrelated chat-A turn")
  })

  it("ends a closed post with its close and proof", () => {
    const events = wallThread(store.get("r3")!, deps())
    const closed = events.find((e) => e.kind === "closed")!
    expect(closed).toMatchObject({ at: T0 + 9000, status: "done" })
    expect(closed.ids[0]).toContain("merge_requests/9")
  })
})

describe("failures", () => {
  it("groups failed runs by agent and error shape, with a count", () => {
    const f = wallFailures(db, Date.now())
    const pm = f.filter((x) => x.agentId === "pm")
    expect(pm).toHaveLength(1)
    expect(pm[0].count).toBe(2)
    expect(pm[0].error).toContain("spawn failed")
  })
})

describe("helpers", () => {
  it("reads the project from a home link or a forge chat", () => {
    expect(projectOf({ home: { kind: "issue", link: "https://github.com/acme/app/pull/3" }, chatId: "x" })).toBe("acme/app")
    expect(projectOf({ home: null, chatId: "group/sub/repo:merge_request:12" })).toBe("group/sub/repo")
    expect(projectOf({ home: null, chatId: "12345" })).toBeNull()
  })
  it("reads mentions, ids and A2A routes", () => {
    expect(mentionsIn("ask @coder and @PM, not me@example.com")).toEqual(["coder", "pm"])
    expect(sourceIdsIn("see #12 and !7 at https://x.example/a")).toEqual(["https://x.example/a", "#12", "!7"])
    expect(a2aRoute("a2a:secretary:dev:dlg-1")).toEqual({ from: "secretary", to: "dev" })
    expect(a2aRoute("chat-A")).toBeNull()
  })
  it("redacts known credential shapes", () => {
    expect(redactSecrets("key glpat-abcdefghijklmnopqrstuv end")).toBe("key [redacted] end")
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide")
  })
  it("answers 404 for an unknown post and an empty wall with no request store", () => {
    expect(handleWallApi("/api/admin/wall/thread", new URLSearchParams({ id: "nope" }), deps(), "n").status).toBe(404)
    expect((handleWallApi("/api/admin/wall", new URLSearchParams(), null, "n").body as any).posts).toEqual([])
  })
})

describe("routes", () => {
  it("serves the Wall at / and keeps Live at /live", async () => {
    const root = await get("/")
    expect(root.status).toBe(200)
    expect(root.body).toContain('id="wall-feed"')
    const live = await get("/live")
    expect(live.status).toBe(200)
    expect(live.body).not.toContain('id="wall-feed"')
    expect((await get("/wall")).body).toContain('id="wall-feed"')
  })

  it("keeps every classic page one tap away", () => {
    const html = renderWallPage()
    for (const [, href] of WALL_CLASSIC_LINKS) expect(html).toContain(`href="${href}"`)
  })

  it("answers the Wall API, the thread from a run id, and the fleet view", async () => {
    const list = JSON.parse((await get("/api/admin/wall")).body)
    expect(list.posts.map((p: any) => p.id).sort()).toEqual(["r1", "r2", "r3"])
    const byTask = JSON.parse((await get("/api/admin/wall/thread?task=t1")).body)
    expect(byTask.post.id).toBe("r1")
    const fleet = JSON.parse((await get("/api/admin/wall?peer=fleet")).body)
    expect(fleet.nodes[0]).toMatchObject({ name: "node-a", ok: true })
    expect(fleet.posts[0].node).toEqual({ name: "node-a", peer: null, daemonUrl: null })
  })

  it("sits behind the dashboard token", async () => {
    token = "tok-123"
    try {
      expect((await get("/api/admin/wall")).status).toBe(401)
      expect((await get("/api/admin/wall", { Authorization: "Bearer tok-123" })).status).toBe(200)
    } finally {
      token = undefined
    }
  })

  it("only reads: the request records are unchanged after every call", async () => {
    const before = JSON.stringify(db.prepare("SELECT * FROM requests ORDER BY id").all())
    await get("/api/admin/wall?peer=fleet")
    await get("/api/admin/wall/thread?id=r1")
    expect(JSON.stringify(db.prepare("SELECT * FROM requests ORDER BY id").all())).toBe(before)
  })
})
