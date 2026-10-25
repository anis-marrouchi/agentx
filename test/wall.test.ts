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
import { listCards, saveCard, type DecisionCard } from "../src/approvals/cards"
import { recordTraceStart, recordTraceEnd } from "../src/storage/traces"
import {
  a2aRoute, handleWallApi, mentionsIn, projectOf, SILENCE_WORDS, sourceIdsIn, wallFailures, wallPost, wallPosts, wallThread, type WallDeps,
} from "../src/daemon/wall-api"
import { renderWallPage, WALL_CLASSIC_LINKS, WALL_DASHBOARD_HREF } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

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
  return {
    store, plans, db, now, staleAfterHours: 24, isAgent: (id) => ["coder", "pm", "secretary"].includes(id),
    cards: () => listCards(process.cwd(), "pending"),
  }
}

function run(taskId: string, agentId: string, chatId: string, end: { status: "ok" | "error" | "timeout"; text?: string; error?: string }, channel?: string) {
  recordTraceStart(db, { agentId, channel: channel ?? (chatId.startsWith("a2a:") ? "a2a" : "telegram"), chatId, messagePreview: "go" }, taskId)
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
  run("t2", "pm", "a2a:coder:pm:dlg-abc123", { status: "ok", text: "Checked, looks fine" })
  // Another dialog whose id starts with r1's: never part of r1's thread.
  run("t2-other", "secretary", "a2a:coder:secretary:dlg-abc1234", { status: "ok", text: "longer dialog id" })
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

  // A GitLab webhook run that ended without a reply (forge channel, as stored live).
  run("t-hook", "coder", "acme/api:merge_request:11", { status: "ok" }, "gitlab")

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

  it("names the agent a hand-off is waiting on", () => {
    store.progress("r1", T0 + 3500, "waiting_other")
    try {
      expect(wallPosts(deps(), 7).find((p) => p.id === "r1")!.blocked?.who).toBe("pm")
    } finally {
      store.progress("r1", T0 + 3600)
    }
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

  it("leads with the result: its own last ok reply, else the close, else none (#1242)", () => {
    const posts = wallPosts(deps(), 7)
    const r1 = posts.find((p) => p.id === "r1")!
    expect(r1.result).toMatchObject({ from: "reply", taskId: "t1", agentId: "coder" })
    expect(r1.result!.text).toContain("Asked @pm to check")
    // r2's runs all failed: no result, and nothing guessed from the hand-off or the chat.
    expect(posts.find((p) => p.id === "r2")!.result).toBeNull()
    expect(posts.find((p) => p.id === "r3")!.result).toMatchObject({ from: "reply", text: "Done", taskId: "t5" })
    // Closed with no run recorded: the proof it was closed with.
    const closedOnly = wallPost({ ...store.get("r3")!, id: "r-no-run" }, deps())
    expect(closedOnly.result).toMatchObject({ from: "close", taskId: null, at: T0 + 9000 })
    expect(closedOnly.result!.text).toContain("merge_requests/9")
    // Runs' raw replies never ride along on the post.
    expect(JSON.stringify(posts)).not.toContain("unrelated chat-A turn")
  })

  it("redacts the proof and keeps a link a link", () => {
    const r3 = { ...store.get("r3")!, evidence: "https://gitlab.example.com/acme/api/-/merge_requests/9 token=supersecretvalue123" }
    const post = wallPost(r3, deps())
    expect(post.evidence).toContain("https://gitlab.example.com/acme/api/-/merge_requests/9")
    expect(post.evidence).not.toContain("supersecretvalue123")
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

  it("matches a hand-off's dialog id whole, not as a prefix", () => {
    const events = wallThread(store.get("r1")!, deps())
    expect(events.some((e) => e.ref === "t2")).toBe(true)
    expect(events.some((e) => e.ref === "t2-other")).toBe(false)
  })

  it("redacts a hand-off's proof link and keeps the link", () => {
    store.link("r3", "delegation", "dlg-proof1", T0 + 8600)
    store.endLink("delegation", "dlg-proof1", "done", "https://gitlab.example.com/acme/web/-/merge_requests/5?token=supersecretvalue123", T0 + 8700)
    const handoff = wallThread(store.get("r3")!, deps()).find((e) => e.kind === "handoff")!
    expect(handoff.text).toContain("done: https://gitlab.example.com/acme/web/-/merge_requests/5?")
    expect(handoff.text).toContain("[redacted]")
    expect(handoff.text).not.toContain("supersecretvalue123")
  })

  it("ends a closed post with its close and proof", () => {
    const events = wallThread(store.get("r3")!, deps())
    const closed = events.find((e) => e.kind === "closed")!
    expect(closed).toMatchObject({ at: T0 + 9000, status: "done" })
    expect(closed.ids[0]).toContain("merge_requests/9")
  })
})

function card(id: string, extra: Partial<DecisionCard> = {}): DecisionCard {
  return {
    id, title: `Card ${id}`, ask: "Ship on Friday?", recommend: "Yes: the tests are green", if_silent: "keep",
    expires: new Date(Date.now() + 5 * H).toISOString(), raised_by: "pm", created_at: new Date(T0 + 7000).toISOString(),
    status: "pending", ...extra,
  }
}

describe("owner decision cards (#1185)", () => {
  beforeAll(() => {
    // c-r2: raised from r2's turn. c-plan: asks about a step of r1's plan.
    // c-free: tied to no request. c-done: already answered.
    saveCard(process.cwd(), card("c-r2", { source: "https://gitlab.example.com/acme/web/-/merge_requests/3?token=supersecretvalue123" }))
    store.link("r2", "card", "c-r2", T0 + 7000)
    saveCard(process.cwd(), card("c-plan", { if_silent: "pause", origin: { kind: "plan-step", requestId: "r1", step: 1 } }))
    saveCard(process.cwd(), card("c-free"))
    saveCard(process.cwd(), card("c-done", { status: "decided", verdict: "yes" }))
    store.link("r3", "card", "c-done", T0 + 8000)
  })

  it("puts a pending card on the post of the request it belongs to, with expiry and silence outcome", () => {
    const posts = wallPosts(deps(), 7)
    const r2 = posts.find((p) => p.id === "r2")!
    expect(r2.ownerCards).toHaveLength(1)
    expect(r2.ownerCards[0]).toMatchObject({
      id: "c-r2", recommend: "Yes: the tests are green", ifSilent: "keep", silence: SILENCE_WORDS.keep, raisedBy: "pm",
    })
    expect(r2.ownerCards[0].expiresAt).toBeGreaterThan(Date.now())
    expect(r2.ownerCards[0].source).not.toContain("supersecretvalue123")
    const r1 = posts.find((p) => p.id === "r1")!
    expect(r1.ownerCards.map((c) => c.id)).toEqual(["c-plan"])
    expect(r1.ownerCards[0].silence).toBe(SILENCE_WORDS.pause)
  })

  it("shows no answered card, and no card tied to no request", () => {
    const all = wallPosts(deps(), 7).flatMap((p) => p.ownerCards.map((c) => c.id))
    expect(all).not.toContain("c-done")
    expect(all).not.toContain("c-free")
  })

  it("only reads: the card files are unchanged", () => {
    const before = JSON.stringify(listCards(process.cwd()))
    wallPosts(deps(), 7)
    expect(JSON.stringify(listCards(process.cwd()))).toBe(before)
  })

  it("never says a card approves itself", () => {
    expect(SILENCE_WORDS.discard).not.toContain("approve")
    expect(SILENCE_WORDS.pause).not.toContain("approve")
    expect(SILENCE_WORDS.keep).toContain("nothing is approved")
  })

  it("comes with the post from the dashboard API", async () => {
    const list = JSON.parse((await get("/api/admin/wall")).body)
    expect(list.posts.find((p: any) => p.id === "r2").ownerCards[0].id).toBe("c-r2")
  })

  it("offers a waiting-on-the-owner filter and no answer buttons", () => {
    const html = renderWallPage()
    expect(html).toContain('<option value="waiting_owner">Waiting on the owner</option>')
    expect(html).toContain("Answer it on the Desk")
    expect(html).not.toMatch(/data-decide|data-verdict/)
  })
})

describe("QA verdict (#1188)", () => {
  beforeAll(() => {
    // r2: needs QA, no verdict. r3: passed after the ask. r1: blocked, then asked again.
    store.setNeedsQa("r2", true, T0 + 7100)
    store.setNeedsQa("r3", true, T0 + 9100)
    store.recordVerdict("r3", { verdict: "pass", by: "qa", note: null }, T0 + 9200)
    store.setNeedsQa("r1", true, T0 + 4100)
    store.recordVerdict("r1", { verdict: "block", by: "qa", note: "login fails, token=supersecretvalue123" }, T0 + 4200)
    store.setNeedsQa("r1", true, T0 + 4300)
  })

  it("puts each verdict on its post with who gave it and when", () => {
    const posts = wallPosts(deps(), 7)
    const by = (id: string) => posts.find((p) => p.id === id)!
    expect(by("r3").qa).toEqual({ verdict: "pass", by: "qa", at: T0 + 9200, note: null })
    expect(by("r3").awaitingQa).toBe(false)
    expect(by("r2")).toMatchObject({ qa: null, awaitingQa: true })
    expect(by("r1").qa).toMatchObject({ verdict: "block", by: "qa", at: T0 + 4200 })
    expect(by("r1").qa!.note).not.toContain("supersecretvalue123")
    expect(by("r1").awaitingQa).toBe(true)
  })

  it("comes with the post from the dashboard API and the thread", async () => {
    const list = JSON.parse((await get("/api/admin/wall")).body)
    expect(list.posts.find((p: any) => p.id === "r2").awaitingQa).toBe(true)
    expect((handleWallApi("/api/admin/wall/thread", new URLSearchParams("id=r3"), deps(), "node-a").body as any).post.qa.verdict).toBe("pass")
  })

  it("offers an awaiting-QA filter that keeps only posts waiting on a verdict", () => {
    expect(renderWallPage()).toContain('<input type="checkbox" id="f-qa"> Awaiting QA only')
    expect(WALL_PAGE_SCRIPT).toContain("if (f.qa && !p.awaitingQa) return false;")
    expect(WALL_PAGE_SCRIPT).toMatch(/FILTERS = \[[^\]]*'qa'/)
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

  it("lists webhook runs that ended without a reply, under their forge channel", () => {
    const hook = wallFailures(db, Date.now()).find((x) => x.lastTaskId === "t-hook")!
    expect(hook).toMatchObject({ agentId: "coder", status: "ok", error: "webhook run ended without a reply" })
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
  it("sends the post's plan steps with its thread, none without a plan (#1355)", () => {
    const plan = (handleWallApi("/api/admin/wall/thread", new URLSearchParams({ id: "r1" }), deps(), "n").body as any).plan
    expect(plan.map((s: any) => [s.idx, s.name, s.agentId, s.doneWhen])).toEqual([[1, "Write the fix", "coder", "PR open"], [2, "Review", "pm", "approved"]])
    expect(plan[0]).toHaveProperty("state")
    expect((handleWallApi("/api/admin/wall/thread", new URLSearchParams({ id: "r2" }), deps(), "n").body as any).plan).toEqual([])
  })

  it("keeps a proof URL whole and clamps a long proof text (#1377)", () => {
    plans.updateStep("r1", 1, { evidence: "https://gitlab.example.com/acme/web/-/merge_requests/9", updatedAt: T0 + 9000 } as any)
    plans.updateStep("r1", 2, { evidence: "x".repeat(5000), updatedAt: T0 + 9000 } as any)
    const plan = (handleWallApi("/api/admin/wall/thread", new URLSearchParams({ id: "r1" }), deps(), "n").body as any).plan
    expect(plan[0].evidence).toBe("https://gitlab.example.com/acme/web/-/merge_requests/9")
    expect(plan[1].evidence.length).toBe(500)
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

  it("is its own space: no dashboard top bar or styles, a link back to the dashboard (#1242)", () => {
    const html = renderWallPage()
    expect(html).not.toContain("ax-topbar")
    expect(html).not.toContain("fonts.googleapis.com")
    expect(html).not.toContain("ax-as-dock")
    expect(html).toContain('class="ax-wall__nav"')
    expect(html).toContain(`href="${WALL_DASHBOARD_HREF}"`)
    expect(html).toContain("ax-wall-theme")
    // The ids the Wall's script paints into are all still there.
    for (const id of ["wall-feed", "wall-nodes", "wall-agents", "wall-synced", "wall-refresh", "wall-count", "wall-search", "wall-compose", "f-q"]) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it("the dashboard keeps its Wall link (#1242)", async () => {
    expect((await get("/live")).body).toContain('href="/wall"')
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

  it("times each part of the build on request, locally and across the fleet (#1252)", async () => {
    expect(JSON.parse((await get("/api/admin/wall")).body).timings).toBeUndefined()
    const local = JSON.parse((await get("/api/admin/wall?timings=1")).body)
    expect(local.timings).toMatchObject({ runs: expect.any(Number), concurrent: expect.any(Number), comments: expect.any(Number), forgeMs: expect.any(Number) })
    const fleet = JSON.parse((await get("/api/admin/wall?peer=fleet&timings=1")).body)
    expect(fleet.timings).toMatchObject({ totalMs: expect.any(Number), local: { doneMs: expect.any(Number), runs: expect.any(Number) }, peers: {} })
    expect(fleet.posts.map((p: any) => p.id).sort()).toEqual(["r1", "r2", "r3"])
  })

  it("keeps one timing per peer when two peers report the same node name (#1255)", async () => {
    const stub = (build: number) => createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ node: "twin", syncedAt: 1, posts: [], failures: [], timings: { totalMs: build } }))
    })
    const peers = [stub(11), stub(22)]
    for (const p of peers) await new Promise<void>((r) => p.listen(0, "127.0.0.1", () => r()))
    const urls = peers.map((p) => `http://127.0.0.1:${(p.address() as AddressInfo).port}`)
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, agents: { coder: { name: "Coder", workspace: process.cwd() } },
      dashboard: { daemons: urls.map((url) => ({ name: "twin", url })) } })
    const fleetServer = createServer((req, res) => {
      void handleBoardRequest(req, res, { boards: [], sources: new Map(), config } as unknown as Ctx)
    })
    await new Promise<void>((r) => fleetServer.listen(0, "127.0.0.1", () => r()))
    try {
      const r = await fetch(`http://127.0.0.1:${(fleetServer.address() as AddressInfo).port}/api/admin/wall?peer=fleet&timings=1`)
      const fleet = await r.json() as any
      expect(fleet.nodes.filter((n: any) => n.name === "twin")).toHaveLength(2)
      expect(Object.keys(fleet.timings.peers).sort()).toEqual([...urls].sort())
      for (const [i, url] of urls.entries()) {
        expect(fleet.timings.peers[url]).toMatchObject({ node: "twin", answeredMs: expect.any(Number), build: { totalMs: i ? 22 : 11 } })
      }
    } finally {
      for (const s of [fleetServer, ...peers]) await new Promise<void>((r) => s.close(() => r()))
    }
  })

  it("sits behind the dashboard token", async () => {
    token = "tok-123"
    try {
      expect((await get("/api/admin/wall")).status).toBe(401)
      expect((await get("/api/admin/wall", { Authorization: "Bearer tok-123" })).status).toBe(200)
      expect((await get("/api/admin/wall?peer=fleet")).status).toBe(401)
      expect((await get("/api/admin/wall?peer=fleet", { Authorization: "Bearer tok-123" })).status).toBe(200)
      // #1201: the fleet activity graph and the per-peer proxy run before the
      // /api/admin/* gate and call peers with their tokens; they need it too.
      expect((await get("/api/admin/activity-graph?peer=fleet")).status).toBe(401)
      expect((await get("/api/admin/activity-graph", { "X-Agentx-Peer": "fleet" })).status).toBe(401)
      expect((await get("/api/admin/activity-graph/stream?peer=fleet")).status).toBe(401)
      expect((await get("/api/admin/activity-graph", { "X-Agentx-Peer": "fleet", Authorization: "Bearer wrong" })).status).toBe(401)
      expect((await get("/api/workflows", { "X-Agentx-Peer": "http://peer.example:4200" })).status).toBe(401)
      expect((await get("/api/admin/activity-graph", { "X-Agentx-Peer": "http://peer.example:4200" })).status).toBe(401)
      // GET /api/agents needs no token on this node, so its proxy needs none.
      expect((await get("/api/agents", { "X-Agentx-Peer": "http://peer.example:4200" })).status).not.toBe(401)
      expect((await get("/api/admin/activity-graph?peer=fleet", { Authorization: "Bearer tok-123" })).status).toBe(200)
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
