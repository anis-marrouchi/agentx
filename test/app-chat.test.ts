import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { AppChatStore } from "../src/daemon/app-chat-store"
import { buildPicker, type AppChatDeps } from "../src/daemon/app-chat"
import { readSse } from "../src/daemon/app-chat-relay"
import { openDb, closeDb } from "../src/storage/sqlite"
import { A2AMesh } from "../src/a2a/mesh"
import { daemonConfigSchema } from "../src/daemon/config"

// Two real servers on 127.0.0.1: a fake daemon that records what the app
// sends to /task and /mesh/task, and the app routes in front of it. Every
// request is loopback, as behind `tailscale serve`, so none may pass without
// an `app` token.

const FENCE = "```"
const DAEMON_TOKEN = "daemon-secret"

interface Seen { path: string; auth?: string; body: any; closedEarly: boolean }
let seen: Seen[] = []
/** When set, /task streams one chunk and then waits to be disconnected. */
let hold = false
/** Upstream events of a normal turn, in order. */
const TURN = [
  ["start", { agentId: "alpha" }],
  ["thinking", { text: "hmm" }],
  ["text", { text: "Partial " }],
  ["tool", { status: "start", id: "t1", name: "Read", arg: "notes.md" }],
  ["tool", { status: "result", id: "t1", name: "Read", error: true }],
  ["text", { text: "answer" }],
  ["done", {
    content: `Here you go.\n\n${FENCE}agentx:ui\n{"buttons":[{"label":"Docs","url":"https://example.com/docs"},{"label":"Bad","url":"javascript:alert(1)"}],"poll":{"question":"Ship?","options":["Yes","No"]},"media":{"type":"image","url":"data:image/png;base64,AAAA"}}\n${FENCE}`,
    duration: 5,
  }],
] as const

let dir: string
let tokens: TokenStore
let store: AppChatStore
let daemon: Server
let app: Server
let base: string
let daemonUrl: string
let appToken: string
let otherPhone: string
const posts: Array<{ node: string; path: string; body: any }> = []
/** Tasks the fake snapshot reports running on node-a's "alpha". */
let running: Array<{ id: string; chatId: string }> = []

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function fakeDaemon(req: IncomingMessage, res: ServerResponse) {
  let raw = ""
  for await (const c of req) raw += c
  const rec: Seen = { path: req.url || "", auth: req.headers.authorization, body: JSON.parse(raw || "{}"), closedEarly: false }
  seen.push(rec)
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.on("close", () => { if (!res.writableEnded) rec.closedEarly = true })
  if (hold) { sse(res, "start", {}); sse(res, "text", { text: "Partial " }); return }
  for (const [event, data] of TURN) sse(res, event, data)
  res.end()
}

const PEERS = [
  { peer: "peer-b", peerUrl: "http://peer-b.test:18800", healthy: true, skills: [{ id: "beta", name: "Beta" }] },
  { peer: "peer-c", peerUrl: "http://peer-c.test:18800", healthy: false, skills: [{ id: "gamma" }] },
]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-chat-"))
  tokens = new TokenStore(dir)
  store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  appToken = tokens.create({ name: "Test phone", scopes: ["app"] }).token
  otherPhone = tokens.create({ name: "Other phone", scopes: ["app"] }).token

  daemon = createServer((req, res) => { void fakeDaemon(req, res) })
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r))
  daemonUrl = `http://127.0.0.1:${(daemon.address() as any).port}`

  const deps: AppChatDeps = {
    store: () => store,
    daemon: { url: daemonUrl, token: DAEMON_TOKEN, name: "node-a" },
    snapshot: async () => ({ nodes: [
      { id: "a", url: daemonUrl, name: "node-a", reachable: true, agents: [{ id: "alpha", name: "Alpha", active: running.length ? 1 : 0, errors: 0, runningTasks: running.map((t) => ({ ...t, messagePreview: "", channel: "app", startedAt: "" })) }] },
      { id: "b", url: "http://peer-b.test:18800/", name: "node-b", reachable: true, agents: [{ id: "beta", name: "Beta", active: 0, errors: 0, runningTasks: [] }] },
      { id: "l", url: "http://lonely.test:18800", name: "http://lonely.test:18800", reachable: false, agents: [] },
    ] }),
    meshPeers: async () => PEERS,
    nodePost: async (node, path, body) => { posts.push({ node, path, body }); return { status: 200, body: { ok: true } } },
  }
  app = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (!(await handleAppRequest(req, res, path, req.method || "GET", { nodeName: "node-a", tokens, chat: deps }))) {
      res.writeHead(418); res.end()
    }
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

beforeEach(() => { seen = []; hold = false; posts.length = 0; running = [] })

const auth = (t = appToken) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" })
const getJson = async (path: string, t = appToken) => {
  const r = await fetch(base + path, { headers: auth(t) })
  return { status: r.status, body: await r.json() }
}

async function chat(body: unknown, t = appToken): Promise<{ status: number; events: Array<{ event: string; data: any }>; error?: string }> {
  const r = await fetch(`${base}/api/app/chat`, { method: "POST", headers: auth(t), body: JSON.stringify(body) })
  if (!r.ok || !r.body) return { status: r.status, events: [], error: (await r.json()).error }
  const events: Array<{ event: string; data: any }> = []
  for await (const ev of readSse(r.body as any)) events.push(ev)
  return { status: r.status, events }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe("chat routes need the device token", () => {
  it("refuses every route with no token, or a token without the app scope", async () => {
    const { token: admin } = tokens.create({ name: "admin", scopes: ["dashboard:write", "agent:*"] })
    const routes: Array<[string, string]> = [
      ["GET", "/api/app/agents"], ["GET", "/api/app/conversations"], ["GET", "/api/app/conversations/cabcdefgh12"],
      ["POST", "/api/app/chat"], ["POST", "/api/app/chat/stop"],
    ]
    for (const [method, path] of routes) {
      const body = method === "POST" ? JSON.stringify({ node: "local", agent: "alpha", message: "hi" }) : undefined
      expect((await fetch(base + path, { method, body })).status, `${method} ${path}`).toBe(401)
      expect((await fetch(base + path, { method, body, headers: auth(admin) })).status, `${method} ${path}`).toBe(401)
    }
    expect(seen).toEqual([]) // nothing reached the daemon
  })
})

describe("agent picker", () => {
  it("lists every node from the snapshot with presence, busy state and how to reach it", async () => {
    running = [{ id: "t-1", chatId: "telegram:1" }]
    const { status, body } = await getJson("/api/app/agents")
    expect(status).toBe(200)
    expect(body.nodes).toEqual([
      { target: "local", name: "node-a", online: true, agents: [{ id: "alpha", name: "Alpha", busy: true, running: 1 }] },
      { target: "peer-b", name: "node-b", online: true, agents: [{ id: "beta", name: "Beta", busy: false, running: 0 }] },
      // Configured but not in the mesh: listed, but chat can't reach it.
      { target: null, name: "http://lonely.test:18800", online: false, agents: [] },
      // In the daemon's mesh but missing from the snapshot: still listed.
      { target: "peer-c", name: "peer-c", online: false, agents: [{ id: "gamma", name: "gamma", busy: false, running: 0 }] },
    ])
  })

  it("falls back to the mesh's agent list when the dashboard can't reach a peer", () => {
    const nodes = buildPicker([{ id: "x", url: "http://peer-b.test:18800", name: "http://peer-b.test:18800", reachable: false, agents: [] }], { url: "http://daemon" }, PEERS)
    expect(nodes[0]).toMatchObject({ target: "peer-b", name: "peer-b", online: true, agents: [{ id: "beta", name: "Beta" }] })
  })
})

describe("sending a message", () => {
  it("runs a local agent through /task with the daemon token and the app context", async () => {
    const { status, events } = await chat({ node: "local", agent: "alpha", message: "What's up?" })
    expect(status).toBe(200)
    const conv = events[0]
    expect(conv).toMatchObject({ event: "conversation", data: { node: "local", nodeName: "node-a", agent: "alpha", agentName: "Alpha", title: "What's up?" } })
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe("/task")
    expect(seen[0].auth).toBe(`Bearer ${DAEMON_TOKEN}`)
    expect(seen[0].body).toEqual({
      agent: "alpha", message: "What's up?", stream: true,
      context: { channel: "app", chatId: `app:${conv.data.id}` },
    })
  })

  it("passes every upstream event through unchanged, then the saved reply", async () => {
    const { events } = await chat({ node: "local", agent: "alpha", message: "Stream it" })
    expect(events.slice(1, -1)).toEqual(TURN.map(([event, data]) => ({ event, data })))
    // The agentx:ui block is lifted out of the text and sent parsed, with
    // anything that isn't a web link dropped.
    expect(events.at(-1)).toEqual({
      event: "final",
      data: {
        status: "done", content: "Here you go.",
        ui: { buttons: [{ label: "Docs", url: "https://example.com/docs" }], poll: { question: "Ship?", options: ["Yes", "No"], multiple: false } },
      },
    })
  })

  it("runs a peer's agent through /mesh/task on the same daemon", async () => {
    const { events } = await chat({ node: "peer-b", agent: "beta", message: "Hello peer" })
    const id = events[0].data.id
    expect(seen[0].path).toBe("/mesh/task")
    expect(seen[0].auth).toBe(`Bearer ${DAEMON_TOKEN}`)
    expect(seen[0].body).toEqual({
      peer: "peer-b", agent: "beta", message: "Hello peer", stream: true,
      context: { channel: "app", chatId: `app:${id}` },
    })
  })

  it("keeps a follow-up on the conversation's own agent and chat id", async () => {
    const first = await chat({ node: "peer-b", agent: "beta", message: "One" })
    const id = first.events[0].data.id
    seen = []
    const next = await chat({ conversationId: id, node: "local", agent: "alpha", message: "Two" })
    expect(next.status).toBe(200)
    expect(seen[0].path).toBe("/mesh/task")
    expect(seen[0].body).toMatchObject({ peer: "peer-b", agent: "beta", message: "Two", context: { chatId: `app:${id}` } })
  })

  it("refuses unknown or offline nodes, unknown agents, empty messages and foreign conversations", async () => {
    const mine = (await chat({ node: "local", agent: "alpha", message: "mine" })).events[0].data.id
    seen = []
    expect((await chat({ node: "nowhere", agent: "alpha", message: "hi" })).status).toBe(400)
    expect((await chat({ node: "peer-c", agent: "gamma", message: "hi" })).status).toBe(409)
    expect((await chat({ node: "local", agent: "beta", message: "hi" })).status).toBe(400)
    expect((await chat({ node: "local", agent: "../etc", message: "hi" })).status).toBe(400)
    expect((await chat({ node: "local", agent: "alpha", message: "   " })).status).toBe(400)
    expect((await chat({ conversationId: "cdoesnotexist", message: "hi" })).status).toBe(404)
    expect((await chat({ conversationId: mine, message: "hi" }, otherPhone)).status).toBe(404)
    expect(seen).toEqual([])
  })
})

describe("conversation history", () => {
  it("is saved per phone with tools, extras and how the turn ended", async () => {
    const { events } = await chat({ node: "local", agent: "alpha", message: "Remember me" })
    const id = events[0].data.id
    const list = await getJson("/api/app/conversations")
    expect(list.body.conversations[0]).toMatchObject({ id, title: "Remember me", agent: "alpha", agentName: "Alpha", messages: 2, last: "Here you go." })
    const conv = await getJson(`/api/app/conversations/${id}`)
    expect(conv.body.running).toBe(false)
    expect(conv.body.messages).toMatchObject([
      { role: "user", content: "Remember me" },
      { role: "assistant", content: "Here you go.", status: "done", tools: [{ name: "Read", arg: "notes.md", error: true }], ui: { buttons: [{ label: "Docs" }] } },
    ])
    // Another phone sees none of it.
    expect((await getJson("/api/app/conversations", otherPhone)).body.conversations).toEqual([])
    expect((await getJson(`/api/app/conversations/${id}`, otherPhone)).status).toBe(404)
  })
})

describe("stopping a turn", () => {
  it("Stop ends the turn, disconnects upstream, cancels the task and keeps the partial answer", async () => {
    hold = true
    const r = await fetch(`${base}/api/app/chat`, { method: "POST", headers: auth(), body: JSON.stringify({ node: "local", agent: "alpha", message: "Long job" }) })
    const events: Array<{ event: string; data: any }> = []
    let id = ""
    for await (const ev of readSse(r.body as any)) {
      events.push(ev)
      if (ev.event === "conversation") id = ev.data.id
      if (ev.event === "text") {
        running = [{ id: "t-9", chatId: `app:${id}` }, { id: "t-other", chatId: "app:someone-else" }]
        // One turn at a time per conversation.
        expect((await chat({ conversationId: id, message: "again" })).status).toBe(409)
        expect((await getJson(`/api/app/conversations/${id}`)).body.running).toBe(true)
        const stop = await fetch(`${base}/api/app/chat/stop`, { method: "POST", headers: auth(), body: JSON.stringify({ conversationId: id }) })
        expect(stop.status).toBe(200)
      }
    }
    expect(events.at(-1)).toEqual({ event: "final", data: { status: "stopped", content: "Partial " } })
    await settle()
    expect(seen[0].closedEarly).toBe(true)
    // Through the task's own cancel route, for this conversation's run only.
    expect(posts).toEqual([{ node: daemonUrl, path: "/api/tasks/t-9/cancel", body: { reason: "cancelled by operator (phone: Test phone)" } }])
    expect(store.get(tokens.verify(appToken)!.id, id)?.messages.at(-1)).toMatchObject({ role: "assistant", content: "Partial ", status: "stopped" })
    running = []
    expect((await fetch(`${base}/api/app/chat/stop`, { method: "POST", headers: auth(), body: JSON.stringify({ conversationId: id }) })).status).toBe(404)
  })

  it("the phone disconnecting aborts the upstream turn", async () => {
    hold = true
    const ac = new AbortController()
    const r = await fetch(`${base}/api/app/chat`, { method: "POST", headers: auth(), body: JSON.stringify({ node: "local", agent: "alpha", message: "Leave" }), signal: ac.signal })
    let id = ""
    try {
      for await (const ev of readSse(r.body as any)) {
        if (ev.event === "conversation") id = ev.data.id
        if (ev.event === "text") ac.abort()
      }
    } catch { /* aborted */ }
    await settle()
    expect(seen[0].closedEarly).toBe(true)
    expect(store.get(tokens.verify(appToken)!.id, id)?.messages.at(-1)).toMatchObject({ status: "stopped" })
  })
})

describe("Stop reaches a mesh peer", () => {
  it("sendTaskStream drops the peer's /task when its signal aborts", async () => {
    let peerClosed = false
    const peer = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.on("close", () => { if (!res.writableEnded) peerClosed = true })
      sse(res, "text", { text: "working" })
    })
    await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(peer.address() as any).port}`
    const mesh = new A2AMesh(daemonConfigSchema.parse({ node: { id: "a", name: "a" }, mesh: { enabled: true, peers: [{ name: "p", url }] } }), () => {})
    const st = (mesh as any).peers.get("p")
    st.healthy = true
    st.agents = [{ id: "beta" }]

    const ac = new AbortController()
    const got: string[] = []
    await expect((async () => {
      for await (const ev of mesh.sendTaskStream("p", "hi", "beta", { signal: ac.signal })) {
        got.push(ev.event)
        ac.abort()
      }
    })()).rejects.toThrow()
    expect(got).toEqual(["text"])
    await settle()
    expect(peerClosed).toBe(true)
    peer.close()
  })
})
