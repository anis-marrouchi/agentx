import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { StatusStore, statusText, isStatusComment } from "../src/requests/status"
import { StatusBoard, attachStatus, type StatusSettings } from "../src/requests/status-board"
import { requestStatusConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { GitLabAdapter } from "../src/channels/gitlab"
import { GitHubAdapter } from "../src/channels/github"
import { detectAgentxMarker, markBody } from "../src/channels/outbound-marker"
import { setStatusChannel, statusChannelsOf } from "../src/requests/status-settings"
import { renderAdminPage } from "../src/daemon/ui/pages/admin"

const MIN = 60_000
const CHAT = "acme/shop:issue:7"

let tmp: string
let db: Database.Database
let store: StatusStore
let board: StatusBoard
let settings: StatusSettings
let clock: number
let logs: string[]
/** What reached the thread: every post and every edit, in order. */
let wire: Array<{ op: "post" | "edit"; chatId: string; ref: string; text: string }>
let failWrites: boolean
/** Every call to post or edit, failed ones included. */
let attempts: number

const deps = () => ({
  post: async (row: { chatId: string }, text: string) => {
    attempts++
    if (failWrites) return ""
    const ref = String(100 + wire.filter((w) => w.op === "post").length)
    wire.push({ op: "post", chatId: row.chatId, ref, text })
    return ref
  },
  edit: async (row: { chatId: string }, ref: string, text: string) => {
    attempts++
    if (failWrites) return false
    wire.push({ op: "edit", chatId: row.chatId, ref, text })
    return true
  },
  log: (m: string) => { logs.push(m) },
  now: () => clock,
})

const boot = () => new StatusBoard(store, () => settings, deps())

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-status-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new StatusStore(db)
  settings = { channels: ["gitlab", "github"], retentionDays: 90 }
  clock = Date.UTC(2026, 9, 1, 14, 0)
  logs = []
  wire = []
  failWrites = false
  attempts = 0
  board = boot()
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A teammate's comment on a GitLab issue reaches the agent. */
function start(taskId: string, over: Record<string, unknown> = {}) {
  board.taskStarted({
    agentId: "coder", channel: "gitlab", chatId: CHAT, taskId, messagePreview: "fix the checkout",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Sami", id: "77", username: "sami" },
    ...over,
  } as any)
}

function end(taskId: string, over: Record<string, unknown> = {}) {
  board.taskCompleted({
    agentId: "coder", channel: "gitlab", chatId: CHAT, taskId, durationMs: 10, at: new Date(clock).toISOString(), ...over,
  } as any)
}

const dlg = (id: string) => ({ id, caller: "coder", callee: "devops", peer: "clawd", origin: { channel: "gitlab", chatId: CHAT } })
const last = () => wire[wire.length - 1]
const state = (id: string) => store.get(id)?.state

describe("setting", () => {
  it("is off by default", () => {
    expect(requestStatusConfigSchema.parse(undefined)).toEqual({ channels: [] })
  })

  it("records and posts nothing on a channel that is not listed", async () => {
    settings.channels = ["github"]
    start("t1")
    await board.idle()
    expect(store.open()).toEqual([])
    expect(wire).toEqual([])
  })

  it("ignores delegated hops and callbacks: only the turn a person started", async () => {
    start("t1", { humanRoot: false })
    await board.idle()
    expect(store.open()).toEqual([])
  })

  it("records a listed chat channel without posting a comment there", async () => {
    settings.channels = ["telegram"]
    start("t1", { channel: "telegram", chatId: "chat-1" })
    await board.idle()
    expect(store.get("req-t1")).toMatchObject({ state: "working", senderId: "77" })
    expect(wire).toEqual([])
  })
})

describe("turning it on and off (dashboard and CLI share this)", () => {
  it("adds and removes one channel, and leaves the others alone", () => {
    const cfg: any = {}
    expect(setStatusChannel(cfg, "GitLab", true)).toBe("request status on gitlab is on")
    setStatusChannel(cfg, "github", true)
    setStatusChannel(cfg, "gitlab", true)
    expect(statusChannelsOf(cfg)).toEqual(["gitlab", "github"])
    setStatusChannel(cfg, "gitlab", false)
    expect(cfg.requestStatus).toEqual({ channels: ["github"] })
    expect(requestStatusConfigSchema.parse(cfg.requestStatus)).toEqual({ channels: ["github"] })
  })

  it("refuses a channel that cannot show it, without changing anything", () => {
    const cfg: any = {}
    expect(() => setStatusChannel(cfg, "telegram", true)).toThrow(/gitlab and github/)
    expect(cfg).toEqual({})
  })

  it("ships a dashboard script that parses, with the toggle on both panes", () => {
    const html = renderAdminPage({})
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(html).toContain("requestStatusCard('gitlab', 'GitLab')")
    expect(html).toContain("requestStatusCard('github', 'GitHub')")
    for (const script of scripts) expect(() => new Function(script)).not.toThrow()
  })
})

describe("one comment per request, edited", () => {
  it("posts once when work starts and edits the same comment when it ends", async () => {
    start("t1")
    await board.idle()
    expect(wire).toHaveLength(1)
    expect(last()).toMatchObject({ op: "post", chatId: CHAT })
    expect(last().text).toContain("**Working** since 2026-10-01 14:00 UTC")

    clock += 3 * MIN
    end("t1")
    await board.idle()
    expect(wire).toHaveLength(2)
    expect(last()).toMatchObject({ op: "edit", ref: "100" })
    expect(last().text).toContain("**Done** at 2026-10-01 14:03 UTC")
    expect(state("req-t1")).toBe("done")
  })

  it("gives a second request in the same thread its own comment", async () => {
    start("t1"); end("t1")
    start("t2")
    await board.idle()
    expect(wire.filter((w) => w.op === "post").map((w) => w.ref)).toEqual(["100", "101"])
  })

  it("does not write when nothing the person sees has changed", async () => {
    start("t1")
    await board.idle()
    board.sweep()
    await board.idle()
    expect(wire).toHaveLength(1)
  })

  it("tries again at the next check when the thread could not be written", async () => {
    failWrites = true
    start("t1")
    await board.idle()
    expect(wire).toEqual([])
    failWrites = false
    clock += MIN
    board.sweep()
    await board.idle()
    expect(wire).toHaveLength(1)
    expect(last().op).toBe("post")
  })

  it("stops trying a thread that refuses the comment, instead of every minute for a day", async () => {
    failWrites = true
    start("t1")
    await board.idle()
    for (let i = 0; i < 24 * 60; i++) { clock += MIN; board.sweep(); await board.idle() }
    expect(attempts).toBe(5)
    expect(logs.filter((l) => l.includes("could not be written 5 times"))).toHaveLength(1)
  })

  it("tries once more when the state changes, and counts from zero after a write that worked", async () => {
    failWrites = true
    start("t1")
    await board.idle()
    for (let i = 0; i < 10; i++) { clock += MIN; board.sweep(); await board.idle() }
    expect(attempts).toBe(5)
    failWrites = false
    end("t1")
    await board.idle()
    expect(attempts).toBe(6)
    expect(last().text).toContain("**Done** at")
    expect(store.get("req-t1")?.writeFails).toBe(0)
  })
})

describe("events with no thread to comment on", () => {
  it.each([
    ["gitlab", "acme/shop:pipeline:9912"],
    ["github", "acme/shop:push:refs/heads/main"],
  ])("opens no request for %s %s", async (channel, chatId) => {
    start("t1", { channel, chatId })
    board.queued({ agentId: "coder", channel, chatId, at: "", humanRoot: true })
    await board.idle()
    expect(store.open()).toEqual([])
    expect(attempts).toBe(0)
  })

  it.each([
    ["gitlab", "acme/shop:merge_request:12"],
    ["github", "acme/shop:pull:391"],
    ["github", "acme/shop:issue:3"],
  ])("still opens one for %s %s", async (channel, chatId) => {
    start("t1", { channel, chatId })
    await board.idle()
    expect(last().chatId).toBe(chatId)
  })
})

describe("queued", () => {
  const queue = () => board.queued({
    agentId: "coder", channel: "gitlab", chatId: CHAT, at: new Date(clock).toISOString(),
    humanRoot: true, sender: { id: "77" },
  })

  it("says so, then becomes working in the same comment when the turn starts", async () => {
    queue()
    await board.idle()
    expect(last().text).toContain("**Queued** since")
    clock += MIN
    start("t9")
    await board.idle()
    expect(wire.map((w) => w.op)).toEqual(["post", "edit"])
    expect(last().text).toContain("**Working** since 2026-10-01 14:01 UTC")
    expect(store.byRef("run", "t9")?.state).toBe("working")
  })

  it("keeps messages that wait together as one request", async () => {
    queue(); queue()
    await board.idle()
    expect(wire).toHaveLength(1)
  })

  it("leaves queued when the turn runs with an agent's comment as its last message", async () => {
    queue()
    await board.idle()
    start("t9", { humanRoot: false })
    await board.idle()
    expect(state(store.byRef("run", "t9")!.id)).toBe("working")
    expect(last().text).toContain("**Working** since")
    // An agent's own turn with nothing queued behind it is still no request.
    start("t10", { humanRoot: false, chatId: "acme/shop:issue:8" })
    expect(store.byRef("run", "t10")).toBeNull()
  })

  const queueEnded = (flushedAt: number) => board.queueEnded({ agentId: "coder", channel: "gitlab", chatId: CHAT, flushedAt, at: "" })

  it("fails when the turn it was handed to ended without starting", async () => {
    queue()
    await board.idle()
    const id = store.open()[0].id
    clock += 5 * MIN
    queueEnded(clock)
    await board.idle()
    expect(state(id)).toBe("failed")
    expect(last().text).toContain("**Failed** at 2026-10-01 14:05 UTC")
    expect(store.open()).toEqual([])
  })

  it("stays queued when the turn that ended was handed over before this message waited", async () => {
    const flushedAt = clock
    start("t1")
    clock += MIN
    queue()
    end("t1")
    queueEnded(flushedAt)
    await board.idle()
    expect(store.open().map((r) => r.state)).toEqual(["queued"])
  })

  it("leaves a request alone when its turn did start", async () => {
    queue()
    const flushedAt = clock
    start("t9")
    queueEnded(flushedAt)
    await board.idle()
    expect(state(store.byRef("run", "t9")!.id)).toBe("working")
  })
})

describe("waiting on someone", () => {
  it("names the agent the work was handed to, not its machine", async () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    await board.idle()
    expect(last().text).toContain("**Waiting on devops** since")
    expect(last().text).not.toContain("clawd")
  })

  it("goes back to working when the answer returns while the turn still runs", async () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    board.delegationDone(dlg("d1"), "done")
    expect(state("req-t1")).toBe("working")
  })

  it("stays waiting after the turn ends, and is done when the answer returns", async () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    end("t1")
    expect(state("req-t1")).toBe("waiting")
    board.delegationDone(dlg("d1"), "done")
    expect(state("req-t1")).toBe("done")
  })

  it("waits for every hand-off before it is done", () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    board.delegationStarted(dlg("d2"))
    end("t1")
    board.delegationDone(dlg("d1"), "done")
    expect(state("req-t1")).toBe("waiting")
    board.delegationDone(dlg("d2"), "done")
    expect(state("req-t1")).toBe("done")
  })

  it("waits on the owner when the agent raises a decision card, and goes on when it is answered", async () => {
    const card = { id: "c1", raised_by: "coder", ask: "Deploy now?" }
    start("t1")
    board.cardRaised(card, { channel: "gitlab", chatId: CHAT })
    await board.idle()
    expect(last().text).toContain("**Waiting on an answer from the owner** since")
    expect(last().text).not.toContain("Deploy now?")
    end("t1")
    expect(state("req-t1")).toBe("waiting")
    board.cardResolved({ id: "c1", status: "decided" })
    expect(state("req-t1")).toBe("done")
  })

  it("times out when the card expires without an answer", () => {
    start("t1")
    board.cardRaised({ id: "c1", raised_by: "coder" }, { channel: "gitlab", chatId: CHAT })
    end("t1")
    board.cardResolved({ id: "c1", status: "expired", if_silent: "hold" })
    expect(state("req-t1")).toBe("timed_out")
  })

  it("ignores the chat a card names when the call proves no turn there", () => {
    start("t1")
    const named = { id: "c1", raised_by: "coder", reply: { channel: "gitlab", chatId: CHAT } }
    board.cardRaised(named, null)
    board.cardRaised(named, { channel: "gitlab", chatId: "group/other:issue:9" })
    expect(state("req-t1")).toBe("working")
  })

  it("does not attach a hand-off made from another chat", () => {
    start("t1")
    board.delegationStarted({ ...dlg("d1"), origin: { channel: "gitlab", chatId: "acme/shop:issue:8" } })
    expect(state("req-t1")).toBe("working")
  })
})

describe("failed", () => {
  it("says the work failed and never shows the error text", async () => {
    start("t1")
    end("t1", { error: "ENOENT /Users/owner/secret/path" })
    await board.idle()
    expect(state("req-t1")).toBe("failed")
    expect(last().text).toContain("**Failed** at")
    expect(last().text).not.toContain("ENOENT")
  })

  it("covers a hand-off that failed after the turn ended", () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    end("t1")
    board.delegationDone(dlg("d1"), "error")
    expect(state("req-t1")).toBe("failed")
  })

  it("shows a run the person stopped as stopped, not failed", () => {
    start("t1")
    end("t1", { error: "cancelled by user", errorKind: "cancelled" })
    expect(state("req-t1")).toBe("stopped")
  })

  it("keeps an ended request ended when a late signal arrives", () => {
    start("t1")
    end("t1", { error: "boom" })
    end("t1")
    expect(state("req-t1")).toBe("failed")
  })
})

describe("timed out", () => {
  it("names a run that hit its time limit", async () => {
    start("t1")
    end("t1", { error: "Task timed out after 30 minutes" })
    await board.idle()
    expect(state("req-t1")).toBe("timed_out")
    expect(last().text).toContain("**Timed out** at")
  })

  it("names a hand-off that did not answer in time", () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    end("t1")
    board.delegationDone(dlg("d1"), "timeout")
    expect(state("req-t1")).toBe("timed_out")
  })
})

describe("restart", () => {
  it("leaves the comment alone while the shutdown cuts the run, then follows the boot's decision", async () => {
    start("t1")
    end("t1", { interrupted: true, error: "daemon shutting down" })
    await board.idle()
    expect(state("req-t1")).toBe("working")

    board = boot()
    board.resumeOutcome({ taskId: "t1", decision: "reported" })
    await board.idle()
    expect(state("req-t1")).toBe("restart")
    expect(last()).toMatchObject({ op: "edit", ref: "100" })
    expect(last().text).toContain("**Cut off by a restart**")
  })

  it("stays one request and one comment when the run is resumed", async () => {
    start("t1")
    end("t1", { interrupted: true })
    await board.idle()
    board = boot()
    board.resumeOutcome({ taskId: "t1", decision: "resumed" })
    start("t2", { resumedFrom: "t1", humanRoot: false })
    clock += 3 * MIN
    board.sweep()
    expect(state("req-t1")).toBe("working")
    end("t2")
    await board.idle()
    expect(state("req-t1")).toBe("done")
    expect(wire.filter((w) => w.op === "post")).toHaveLength(1)
  })

  it("says so for a run nothing picked up again, once the boot has had its time", async () => {
    start("t1")
    await board.idle()
    board = boot()
    clock += MIN
    board.sweep()
    expect(state("req-t1")).toBe("working")
    clock += 2 * MIN
    board.sweep()
    await board.idle()
    expect(state("req-t1")).toBe("restart")
    expect(last().text).toContain("**Cut off by a restart**")
  })

  it("says so for a message that was still queued: the queue does not survive", () => {
    board.queued({ agentId: "coder", channel: "gitlab", chatId: CHAT, at: "", humanRoot: true })
    const id = store.open()[0].id
    board = boot()
    clock += 3 * MIN
    board.sweep()
    expect(state(id)).toBe("restart")
  })

  it("covers a hand-off lost in the restart", () => {
    start("t1")
    board.delegationStarted(dlg("d1"))
    end("t1")
    board = boot()
    board.delegationDone(dlg("d1"), "lost")
    expect(state("req-t1")).toBe("restart")
  })
})

describe("the minute check", () => {
  it("deletes ended requests after retentionDays and never an open one", () => {
    start("t1"); end("t1")
    start("t2")
    clock += 91 * 24 * 60 * MIN
    board.sweep()
    expect(store.get("req-t1")).toBeNull()
    expect(state("req-t2")).toBe("working")
  })
})

describe("what the comment says", () => {
  it("has no mention in any state, so it can never call an agent", () => {
    for (const s of ["queued", "working", "waiting", "done", "failed", "timed_out", "restart", "stopped"] as const) {
      expect(statusText({ state: s, agentId: "coder", waitingOn: "devops", since: clock })).not.toContain("@")
    }
  })
})

describe("on the daemon's event bus", () => {
  it("follows queued, started and completed, and stops when detached", async () => {
    const attached = attachStatus(db, () => settings, deps())
    const bus = getEventBus()
    const at = new Date(clock).toISOString()
    bus.emit("task:queued", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", at, humanRoot: true })
    bus.emit("task:started", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", taskId: "b1", messagePreview: "x", at, humanRoot: true })
    bus.emit("task:completed", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", taskId: "b1", durationMs: 1, at })
    await attached.board.idle()
    expect(attached.board.store.byRef("run", "b1")?.state).toBe("done")
    // Three changes in one tick reach the thread as one write of the last state.
    expect(wire.map((w) => w.op)).toEqual(["post"])
    expect(last().text).toContain("**Done** at")
    attached.detach()
    bus.emit("task:started", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", taskId: "b2", messagePreview: "x", at, humanRoot: true })
    expect(attached.board.store.byRef("run", "b2")).toBeNull()
  })

  it("follows the end of a queued message's turn", async () => {
    const attached = attachStatus(db, () => settings, deps())
    const bus = getEventBus()
    bus.emit("task:queued", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", at: "", humanRoot: true })
    bus.emit("task:queue-ended", { agentId: "coder", channel: "github", chatId: "acme/shop:issue:3", flushedAt: clock, at: "" })
    await attached.board.idle()
    attached.detach()
    expect(attached.board.store.open()).toEqual([])
    expect(last().text).toContain("**Failed** at")
  })
})

describe("editing the comment on the forge", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  const stubFetch = (ok = true) => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers })
      return { ok, status: ok ? 200 : 403, text: async () => "", json: async () => ({}) }
    }))
  }

  const gitlab = (mappings: any[] = [{ agentId: "coder", gitlabUsernames: ["coder-bot"], keywords: [], token: "agent-token" }]) =>
    new GitLabAdapter({
      enabled: true, webhookPort: 0, host: "https://gitlab.example", token: "global-token",
      routes: [], agentMappings: mappings,
    } as any, () => {})

  it("GitLab: edits the note with the agent's own token and keeps the signature", async () => {
    stubFetch()
    expect(await gitlab().editComment(CHAT, "555", "Request status: **Done**", "coder")).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("PUT")
    expect(calls[0].url).toBe("https://gitlab.example/api/v4/projects/acme%2Fshop/issues/7/notes/555")
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("agent-token")
    expect(detectAgentxMarker(calls[0].body.body)).toBe("coder")
  })

  it("GitLab: edits a merge request note on the merge request path", async () => {
    stubFetch()
    await gitlab().editComment("acme/shop:merge_request:12", "9", "x", "coder")
    expect(calls[0].url).toContain("/merge_requests/12/notes/9")
  })

  it("GitLab: sends the edit to the peer that holds the token, and that peer never forwards again", async () => {
    stubFetch()
    const adapter = gitlab([{ agentId: "coder", gitlabUsernames: [], keywords: [], node: "clawd" }])
    const forwarded: any[] = []
    adapter.setEditCommentForwarder(async (...args) => { forwarded.push(args); return true })
    expect(await adapter.editComment(CHAT, "555", "x", "coder")).toBe(true)
    expect(forwarded).toEqual([["clawd", CHAT, "555", "coder", "x"]])
    expect(calls).toHaveLength(0)
    // On the peer (localOnly): no second hop.
    await adapter.editComment(CHAT, "555", "x", "coder", true)
    expect(forwarded).toHaveLength(1)
  })

  it("GitLab: reports a refused edit and rejects an id that is not a note id", async () => {
    stubFetch(false)
    expect(await gitlab().editComment(CHAT, "555", "x", "coder")).toBe(false)
    expect(await gitlab().editComment(CHAT, "../../users", "x", "coder")).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("GitLab: stops asking the agent for an acknowledgement comment only while status is on", async () => {
    stubFetch()
    const prompt = async (iid: number, statusOn: boolean) => {
      const adapter = gitlab() as any
      adapter.usernameToAgent.set("coder-bot", "coder") // built by start() in the daemon
      adapter.setStatusComments(() => statusOn)
      const got: string[] = []
      adapter.onMessage(async (m: any) => { got.push(m.text) })
      await adapter.handleIssue({
        object_kind: "issue",
        user: { username: "sami", name: "Sami", id: 77 },
        project: { path_with_namespace: "acme/shop", id: 1, web_url: "https://gitlab.example/acme/shop" },
        object_attributes: { iid, id: 1000 + iid, title: "Checkout fails", description: "It fails.", action: "update", state: "opened", url: `https://gitlab.example/acme/shop/-/issues/${iid}` },
        assignees: [{ username: "coder-bot" }],
        changes: { assignees: { previous: [], current: [{ username: "coder-bot" }] } },
        labels: [],
      }, { writeHead: () => {}, end: () => {} })
      return got.join("\n")
    }
    expect(await prompt(21, false)).toContain("Please acknowledge this assignment in a comment, then start working on the issue.")
    const on = await prompt(22, true)
    expect(on).toContain("Start working on the issue.")
    expect(on).not.toContain("acknowledge")
  })

  it("GitHub: a status comment signed by another agent starts no turn; a review signed by it still does", async () => {
    stubFetch()
    const adapter = new GitHubAdapter({
      token: "t", routes: [{ repo: "acme/shop", agent: "coder" }],
      agentMappings: [{ agentId: "coder", githubUsernames: ["owner"] }],
    } as any, () => {})
    const got: string[] = []
    adapter.onMessage(async (m: any) => { got.push(m.text) })
    const comment = (id: number, body: string, login = "owner") => ({
      action: "created",
      comment: { id, body, user: { login, id: 1 } },
      issue: { number: 3, title: "Checkout fails" },
      repository: { full_name: "acme/shop", html_url: "u" },
    })
    const status = markBody(statusText({ state: "working", agentId: "devops", waitingOn: null, since: clock }), "devops")
    expect(isStatusComment(status)).toBe(true)
    await (adapter as any).handleIssueComment(comment(1, status))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual([])
    await (adapter as any).handleIssueComment(comment(2, markBody("Verdict: NOT READY", "devops")))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toHaveLength(1)
    // Typed by someone AgentX does not post as: an ordinary comment.
    await (adapter as any).handleIssueComment(comment(3, status, "outsider"))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toHaveLength(2)
  })

  it("GitHub: edits the comment in place with the same signature", async () => {
    stubFetch()
    const adapter = new GitHubAdapter({ enabled: true, token: "gh-token", routes: [], agentMappings: [] } as any, () => {})
    ;(adapter as any).globalToken = "gh-token"
    expect(await adapter.editComment("acme/shop:issue:3", "888", "Request status: **Done**", "coder")).toBe(true)
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/shop/issues/comments/888")
    expect(detectAgentxMarker(calls[0].body.body)).toBe("coder")
  })
})
