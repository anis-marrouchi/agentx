import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { AppChatStore } from "../src/daemon/app-chat-store"
import type { AppChatDeps } from "../src/daemon/app-chat"
import { ACTIVE_LIMIT, AppPresence, buildActive, finishPush, firstLine, shouldPushFinish, type FinishPush, type RunningTurn } from "../src/daemon/app-chat-active"
import { readSse } from "../src/daemon/app-chat-relay"
import { openDb, closeDb } from "../src/storage/sqlite"

// Several conversations at once (#265): the strip's endpoint, read state,
// and the notification sent to one phone when an answer finishes out of
// its sight. A fake daemon answers every turn; `hold` keeps a turn running
// until the test releases it.

let hold = false
let release: Array<() => void> = []
let dir: string
let tokens: TokenStore
let store: AppChatStore
let daemon: Server
let app: Server
let base: string
let deps: AppChatDeps
let phoneA: string
let phoneB: string
let pushes: FinishPush[] = []
let alertsOn = true

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function fakeDaemon(req: IncomingMessage, res: ServerResponse) {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  sse(res, "start", {})
  sse(res, "text", { text: "Looking into it\n" })
  const end = () => {
    if (res.writableEnded || res.destroyed) return
    sse(res, "done", { content: "## All **done** here\nSecond line." })
    res.end()
  }
  if (hold) release.push(end)
  else end()
}

beforeAll(async () => {
  closeDb()
  dir = mkdtempSync(join(tmpdir(), "agentx-app-active-"))
  tokens = new TokenStore(dir)
  store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  phoneA = tokens.create({ name: "Phone A", scopes: ["app"] }).token
  phoneB = tokens.create({ name: "Phone B", scopes: ["app"] }).token
  daemon = createServer((req, res) => { void fakeDaemon(req, res) })
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r))
  const daemonUrl = `http://127.0.0.1:${(daemon.address() as any).port}`
  deps = {
    store: () => store,
    daemon: { url: daemonUrl, name: "node-a" },
    snapshot: async () => ({ nodes: [{ id: "a", url: daemonUrl, name: "node-a", reachable: true, agents: [
      { id: "alpha", name: "Alpha", active: 0, errors: 0, runningTasks: [], color: "#123456" },
      { id: "beta", name: "Beta", active: 0, errors: 0, runningTasks: [] },
    ] }] }),
    meshPeers: async () => [],
    nodePost: async () => ({ status: 200, body: {} }),
    finishAlerts: () => alertsOn,
    notifyFinish: async (p) => { pushes.push(p) },
  }
  app = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (!(await handleAppRequest(req, res, path, req.method || "GET", { tokens, chat: deps }))) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(app.address() as any).port}`
})

afterAll(() => {
  app.close()
  daemon.close()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => { hold = false; release = []; pushes = []; alertsOn = true; deps.presence = new AppPresence() })

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" })
const settle = () => new Promise((r) => setTimeout(r, 60))
const active = async (t = phoneA) => (await (await fetch(`${base}/api/app/chat/active`, { headers: auth(t) })).json()).conversations as any[]
const deviceOf = (t: string) => tokens.verify(t)!.id

/** Runs a turn to the end with the phone watching it. */
async function watchTurn(agent: string, message: string, t = phoneA): Promise<string> {
  const r = await fetch(`${base}/api/app/chat`, { method: "POST", headers: auth(t), body: JSON.stringify({ node: "local", agent, message }) })
  let id = ""
  for await (const ev of readSse(r.body as any)) if (ev.event === "conversation") id = ev.data.id
  return id
}

/** Starts a held turn and lets go of it, as a phone switching away does. */
async function leaveTurn(agent: string, message: string, t = phoneA): Promise<string> {
  hold = true
  const ac = new AbortController()
  const r = await fetch(`${base}/api/app/chat`, { method: "POST", headers: auth(t), body: JSON.stringify({ node: "local", agent, message }), signal: ac.signal })
  let id = ""
  try {
    for await (const ev of readSse(r.body as any)) {
      if (ev.event === "conversation") id = ev.data.id
      if (ev.event === "text") ac.abort()
    }
  } catch { /* let go */ }
  await settle()
  return id
}
const finishAll = async () => { release.forEach((f) => f()); release = []; await settle() }

describe("GET /api/app/chat/active", () => {
  it("needs a paired phone", async () => {
    expect((await fetch(`${base}/api/app/chat/active`)).status).toBe(401)
    expect((await fetch(`${base}/api/app/chat/away`, { method: "POST" })).status).toBe(401)
  })

  it("lists this phone's running conversations with their state, then the unread answers", async () => {
    const a = await leaveTurn("alpha", "First question")
    const b = await leaveTurn("beta", "Second question")
    const list = await active()
    expect(list.map((c) => [c.id, c.agentName, c.state])).toEqual([[a, "Alpha", "answering"], [b, "Beta", "answering"]])
    expect(list[0]).toMatchObject({ agent: "alpha", color: "#123456", preview: "Looking into it", title: "First question" })
    expect(list[1].color).toBeUndefined()
    // Another phone sees none of them.
    expect(await active(phoneB)).toEqual([])

    await finishAll()
    const done = await active()
    expect(done.map((c) => [c.id, c.state, c.status])).toEqual([[b, "done", "done"], [a, "done", "done"]])
    expect(done[0].preview).toBe("All done here")

    // Peeking (to read it out) leaves it unread; opening reads it.
    expect((await fetch(`${base}/api/app/conversations/${a}?peek=1`, { headers: auth(phoneA) })).status).toBe(200)
    expect((await active()).map((c) => c.id)).toEqual([b, a])
    await fetch(`${base}/api/app/conversations/${a}`, { headers: auth(phoneA) })
    expect((await active()).map((c) => c.id)).toEqual([b])
    await fetch(`${base}/api/app/conversations/${b}`, { headers: auth(phoneA) })
    expect(await active()).toEqual([])
  })

  it("never lists an answer the phone watched finish", async () => {
    await watchTurn("alpha", "Watched")
    expect(await active()).toEqual([])
  })

  it("marks a conversation read when the phone attaches to it", async () => {
    const id = await leaveTurn("alpha", "Attach later")
    const r = await fetch(`${base}/api/app/chat/attach?conversationId=${id}`, { headers: auth(phoneA) })
    for await (const ev of readSse(r.body as any)) if (ev.event === "resume") release.forEach((f) => f())
    await settle()
    expect(await active()).toEqual([])
  })

  it("is bounded", async () => {
    const dev = deviceOf(phoneB)
    for (let i = 0; i < ACTIVE_LIMIT + 5; i++) {
      const c = store.create(dev, { node: "local", nodeName: "node-a", agent: "alpha", agentName: "Alpha" }, `q${i}`, 1000 + i)
      store.append(dev, c.id, { role: "assistant", content: `answer ${i}`, status: "done", at: 5000 + i })
    }
    const list = await active(phoneB)
    expect(list).toHaveLength(ACTIVE_LIMIT)
    expect(list[0].preview).toBe(`answer ${ACTIVE_LIMIT + 4}`)
    expect(await active()).toEqual([]) // still scoped
  })

  it("counts conversations from before read state as read", () => {
    const path = join(dir, "old.sqlite")
    const db = new Database(path)
    db.exec(`CREATE TABLE app_chat_conversations (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, title TEXT NOT NULL,
      node TEXT NOT NULL, node_name TEXT NOT NULL, agent TEXT NOT NULL, agent_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE app_chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT, error TEXT, ui TEXT, tools TEXT, at INTEGER NOT NULL);
      INSERT INTO app_chat_conversations VALUES ('cold0000001', 'dev', 'Old', 'local', 'n', 'alpha', NULL, 1, 50);
      INSERT INTO app_chat_messages (conversation_id, role, content, status, at) VALUES ('cold0000001', 'assistant', 'old answer', 'done', 50);`)
    const old = new AppChatStore(db)
    expect(old.unread("dev", 12)).toEqual([])
    old.append("dev", "cold0000001", { role: "assistant", content: "new answer", status: "done", at: 60 })
    expect(old.unread("dev", 12).map((u) => u.answer)).toEqual(["new answer"])
    db.close()
  })
})

describe("a notification when an answer finishes out of sight", () => {
  it("goes to that phone only, with a link to the conversation", async () => {
    const id = await leaveTurn("alpha", "Ping me")
    await finishAll()
    expect(pushes).toEqual([{ deviceId: deviceOf(phoneA), title: "Alpha", body: "All done here", url: `/app#chat=${id}` }])
  })

  it("is not sent for the conversation the phone is watching", async () => {
    await watchTurn("alpha", "Watching")
    expect(pushes).toEqual([])
  })

  it("is not sent when the phone turned it off", async () => {
    alertsOn = false
    await leaveTurn("alpha", "Quiet")
    await finishAll()
    expect(pushes).toEqual([])
  })

  it("is not sent while the app is open on screen (it shows a banner), and is again once it is away", async () => {
    await active() // the strip polls: the app is open
    await leaveTurn("alpha", "Banner please")
    await finishAll()
    expect(pushes).toEqual([])
    expect((await fetch(`${base}/api/app/chat/away`, { method: "POST", headers: auth(phoneA) })).status).toBe(200)
    await leaveTurn("beta", "Push please")
    await finishAll()
    expect(pushes.map((p) => p.title)).toEqual(["Beta"])
  })

  it("is not sent for a turn the owner stopped", async () => {
    const id = await leaveTurn("alpha", "Stop me")
    await fetch(`${base}/api/app/chat/stop`, { method: "POST", headers: auth(phoneA), body: JSON.stringify({ conversationId: id }) })
    await settle()
    expect(pushes).toEqual([])
    release = []
  })
})

describe("the rules, as pure functions", () => {
  const facts = { status: "done" as const, attached: false, appOpen: false, enabled: true }
  it("shouldPushFinish", () => {
    expect(shouldPushFinish(facts)).toBe(true)
    expect(shouldPushFinish({ ...facts, status: "error" })).toBe(true)
    expect(shouldPushFinish({ ...facts, status: "stopped" })).toBe(false)
    expect(shouldPushFinish({ ...facts, attached: true })).toBe(false)
    expect(shouldPushFinish({ ...facts, appOpen: true })).toBe(false)
    expect(shouldPushFinish({ ...facts, enabled: false })).toBe(false)
  })

  it("finishPush caps the body at the first line and says when it failed", () => {
    const long = "word ".repeat(80)
    expect(finishPush("tok_1", { id: "cabc12345", agent: "a", agentName: "Ann" }, "done", long).body.length).toBeLessThanOrEqual(140)
    expect(finishPush("tok_1", { id: "cabc12345", agent: "a" }, "done", "")).toMatchObject({ title: "a", body: "Answered.", url: "/app#chat=cabc12345" })
    expect(finishPush("tok_1", { id: "cabc12345", agent: "a" }, "error", "", "Boom\nstack")).toMatchObject({ body: "Could not answer: Boom" })
    expect(firstLine("\n\n- **Bold** item\nnext")).toBe("Bold item")
  })

  it("buildActive keeps one phone's turns, one chip per conversation, running first, at most the limit", () => {
    const turn = (id: string, deviceId: string, startedAt: number, text = ""): RunningTurn => ({ id, deviceId, title: `t ${id}`, agent: "x", text, startedAt })
    const unread = [
      { id: "c2", title: "t", agent: "y", answer: "older", status: "done" as const, at: 5 },
      { id: "c9", title: "t", agent: "y", answer: "", status: "error" as const, at: 4 },
    ]
    const out = buildActive("me", [turn("c2", "me", 20, "writing"), turn("c1", "me", 10), turn("c3", "them", 5)], unread)
    expect(out.map((c) => [c.id, c.state])).toEqual([["c1", "thinking"], ["c2", "answering"], ["c9", "done"]])
    expect(out[0].preview).toBe("t c1")
    expect(out[2].preview).toBe("The agent could not answer.")
    expect(buildActive("me", [turn("c1", "me", 1), turn("c2", "me", 2)], unread, 1)).toHaveLength(1)
    expect(buildActive("me", [turn("c1", "me", 1, "x".repeat(500))], [])[0].preview.length).toBeLessThanOrEqual(120)
  })

  it("AppPresence forgets a phone after the window or when it goes away", () => {
    const p = new AppPresence(1000)
    p.poll("d", 0)
    expect(p.open("d", 900)).toBe(true)
    expect(p.open("d", 1500)).toBe(false)
    p.poll("d", 2000); p.away("d")
    expect(p.open("d", 2001)).toBe(false)
    expect(p.open("other", 0)).toBe(false)
  })
})
