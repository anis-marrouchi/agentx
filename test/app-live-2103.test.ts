import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { LIVE_OFF_ERROR, PREVIEW_CHARS, type AppFleetDeps, type SnapshotNode, type TaskStreamOpen } from "../src/daemon/app-fleet"
import { PhoneStreamTrimmer, SseFrames } from "../src/daemon/app-task-stream"
import { makeStreamEventFormatter } from "../src/agents/registry"
import { setLiveControl } from "../src/commands/app"
import { liveLabel, liveReduce, liveSseFrames, type LiveView } from "../src/daemon/ui/pages/app-live-logic"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// #2103 PR B: follow a running task from the phone, with the app:live gate.

const NODE_A = "http://node-a:18800"
const node: SnapshotNode = {
  id: NODE_A, name: "node-a", url: NODE_A, reachable: true,
  agents: [{
    id: "helper", name: "Helper", active: 1, errors: 0,
    runningTasks: [{ id: "t-run", messagePreview: "check the deploy", channel: "app", startedAt: "2026-11-23T08:00:00Z" }],
  }],
}

function sse(frames: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const [ev, data] of frames) c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
      c.close()
    },
  })
}

const SECRET = "TOPSECRET-cmd"
const longText = "a".repeat(2000)
let upstream: () => TaskStreamOpen = () => ({
  ok: true,
  body: sse([
    ["start", { taskId: "t-run", initial: "Looking at it.\n→ Read({\"file_path\":\"/x\"})\n", done: false }],
    ["chunk", { text: `\n→ Bash({"command":"${SECRET}"})\n` }],
    ["chunk", { text: `← ${SECRET} output\nsecond line of output\n` }],
    ["chunk", { text: longText }],
    ["chunk", { text: "\n💭 thinking about secrets\n" }],
    ["chunk", { text: "[error] boom: database password wrong\n" }],
    ["chunk", { text: "Final words." }],
    ["chunk", { text: "\n[task finished]\n" }],
    ["end", { reason: "completed" }],
  ]),
})

let snapshot = async () => ({ ts: "2026-11-23T08:00:00Z", nodes: [node] })
let dir: string
let tokens: TokenStore
let server: Server
let base: string
const taskStream = vi.fn(async (_n: string, _a: string, _t: string, _s: AbortSignal) => upstream())
const nodePost = vi.fn(async () => ({ status: 200, body: { ok: true } }))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-live-"))
  tokens = new TokenStore(dir)
  const fleet: AppFleetDeps = {
    snapshot: () => snapshot(),
    nodePost,
    approvals: async () => [],
    decide: async () => ({ status: 200, body: {} }),
    taskStream,
  }
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    const handled = await handleAppRequest(req, res, path, req.method || "GET", { tokens, fleet })
    if (!handled) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

function phone(scopes: string[]) {
  const { token, record } = tokens.create({ name: "Phone", scopes })
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { token, record, call }
}

function events(text: string): Array<{ event: string; data: any }> {
  return new SseFrames().push(text).map((f) => ({ event: f.event, data: JSON.parse(f.data) }))
}

describe("app:live gate (exact scope)", () => {
  it("a phone with only `app` gets 403 on stream, cancel and followup, and no node is called", async () => {
    const p = phone(["app"])
    nodePost.mockClear(); taskStream.mockClear()
    const r1 = await p.call("GET", "/api/app/tasks/stream?taskId=t-run&agentId=helper")
    const r2 = await p.call("POST", "/api/app/tasks/cancel", { taskId: "t-run" })
    const r3 = await p.call("POST", "/api/app/tasks/followup", { taskId: "t-run", message: "hi" })
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(403)
      expect((await r.json()).error).toBe(LIVE_OFF_ERROR)
    }
    expect(nodePost).not.toHaveBeenCalled()
    expect(taskStream).not.toHaveBeenCalled()
  })

  it("`app:live` alone, without `app`, does not log in", async () => {
    const p = phone(["app:live"])
    expect((await p.call("GET", "/api/app/me")).status).toBe(401)
    expect((await p.call("GET", "/api/app/tasks/stream?taskId=t-run")).status).toBe(401)
  })

  it("a look-alike scope does not count", async () => {
    // Only exact strings are valid scopes, so a near miss cannot be minted.
    expect(() => tokens.create({ name: "x", scopes: ["app", "app:live2"] })).toThrow(/Invalid scope/)
    expect(() => tokens.create({ name: "x", scopes: ["app", "app:*"] })).toThrow(/Invalid scope/)
  })

  it("me and activity tell the phone whether live control is on", async () => {
    const off = phone(["app"])
    const on = phone(["app", "app:live"])
    expect((await (await off.call("GET", "/api/app/me")).json()).live).toBe(false)
    expect((await (await on.call("GET", "/api/app/me")).json()).live).toBe(true)
    expect((await (await off.call("GET", "/api/app/activity")).json()).live).toBe(false)
    expect((await (await on.call("GET", "/api/app/activity")).json()).live).toBe(true)
  })
})

describe("the phone never picks the node", () => {
  it("stream: a node= parameter is refused, the server uses the snapshot's node", async () => {
    const p = phone(["app", "app:live"])
    taskStream.mockClear()
    expect((await p.call("GET", `/api/app/tasks/stream?taskId=t-run&node=${encodeURIComponent("http://evil:1")}`)).status).toBe(400)
    expect(taskStream).not.toHaveBeenCalled()
    const r = await p.call("GET", "/api/app/tasks/stream?taskId=t-run&agentId=helper")
    expect(r.status).toBe(200)
    await r.text()
    expect(taskStream).toHaveBeenCalledWith(NODE_A, "helper", "t-run", expect.anything())
  })

  it("cancel and followup: a foreign node is 400, no node goes to the snapshot's one, an unknown task is 404", async () => {
    const p = phone(["app", "app:live"])
    nodePost.mockClear()
    expect((await p.call("POST", "/api/app/tasks/cancel", { node: "http://evil:1", taskId: "t-run" })).status).toBe(400)
    expect(nodePost).not.toHaveBeenCalled()
    const gone = await p.call("POST", "/api/app/tasks/cancel", { taskId: "t-gone" })
    expect(gone.status).toBe(404)
    expect((await gone.json()).error).toBe("this task has ended")
    expect((await p.call("POST", "/api/app/tasks/followup", { taskId: "t-run", message: "and the logs" })).status).toBe(200)
    expect(nodePost).toHaveBeenLastCalledWith(NODE_A, "/api/tasks/t-run/followup", { message: "and the logs", sender: "operator (phone: Phone)" })
    expect((await p.call("POST", "/api/app/tasks/cancel", { taskId: "t-run" })).status).toBe(200)
    expect(nodePost).toHaveBeenLastCalledWith(NODE_A, "/api/tasks/t-run/cancel", { reason: "cancelled by operator (phone: Phone)" })
  })
})

describe("GET /api/app/tasks/stream", () => {
  it("a task not in the snapshot is 404 'this task has ended'", async () => {
    const p = phone(["app", "app:live"])
    const r = await p.call("GET", "/api/app/tasks/stream?taskId=t-gone")
    expect(r.status).toBe(404)
    expect((await r.json()).error).toBe("this task has ended")
  })

  it("sends step names, text ≤ 160 and 'failed' with no error text, tool input or tool output", async () => {
    const p = phone(["app", "app:live"])
    const r = await p.call("GET", "/api/app/tasks/stream?taskId=t-run&agentId=helper")
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/)
    const raw = await r.text()
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain("boom")
    expect(raw).not.toContain("password")
    expect(raw).not.toContain("thinking")
    expect(raw).not.toContain("second line of output")
    expect(raw).not.toContain("/x")
    const evs = events(raw)
    expect(evs[0]).toMatchObject({ event: "start", data: { taskId: "t-run", agentName: "Helper", nodeName: "node-a", step: "Read" } })
    expect(evs[0].data).not.toHaveProperty("text")
    expect(evs.filter((e) => e.event === "step").map((e) => e.data.name)).toEqual(["Bash"])
    for (const e of evs.filter((e) => e.event === "text")) expect(e.data.text.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    const end = evs[evs.length - 1]
    expect(end.event).toBe("end")
    expect(end.data.state).toBe("failed")
    expect(end.data.final.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(end.data.more).toBe("Full answer on the Hub")
  })

  it("a task that already finished ends at once with its final preview", async () => {
    const saved = upstream
    upstream = () => ({ ok: true, body: sse([["start", { taskId: "t-run", initial: "All done here.\n[task finished]\n", done: true }], ["end", { reason: "already finished" }]]) })
    try {
      const p = phone(["app", "app:live"])
      const evs = events(await (await p.call("GET", "/api/app/tasks/stream?taskId=t-run")).text())
      expect(evs.map((e) => e.event)).toEqual(["start", "end"])
      expect(evs[1].data).toMatchObject({ state: "done", final: "All done here." })
    } finally { upstream = saved }
  })

  it("an evicted task (upstream error event) ends as 'ended'", async () => {
    const saved = upstream
    upstream = () => ({ ok: true, body: sse([["error", { message: "task not found or already evicted" }]]) })
    try {
      const p = phone(["app", "app:live"])
      const raw = await (await p.call("GET", "/api/app/tasks/stream?taskId=t-run")).text()
      expect(raw).not.toContain("evicted")
      expect(events(raw)).toEqual([{ event: "end", data: { state: "ended", more: "Full answer on the Hub" } }])
    } finally { upstream = saved }
  })

  it("a phone that leaves while the snapshot is slow opens no upstream (#2137 follow-up)", async () => {
    const saved = snapshot
    let release = () => {}
    let entered = () => {}
    const inSnapshot = new Promise<void>((r) => { entered = r })
    snapshot = () => new Promise((r) => { entered(); release = () => r({ ts: "2026-11-23T08:00:00Z", nodes: [node] }) })
    taskStream.mockClear()
    // What the node is asked with: whether the phone was already gone then.
    const abortedAtOpen: boolean[] = []
    taskStream.mockImplementationOnce(async (_n, _a, _t, signal) => {
      abortedAtOpen.push(signal.aborted)
      return { ok: true, body: new ReadableStream({ start(c) { signal.addEventListener("abort", () => c.close()) } }) }
    })
    try {
      const p = phone(["app", "app:live"])
      const ac = new AbortController()
      const req = fetch(`${base}/api/app/tasks/stream?taskId=t-run`, { headers: { Authorization: `Bearer ${p.token}` }, signal: ac.signal })
      await inSnapshot
      ac.abort()
      await req.catch(() => {})
      await new Promise((r) => setTimeout(r, 50))
      release()
      await new Promise((r) => setTimeout(r, 50))
      // Either the node is never asked, or it is asked with a signal already aborted.
      expect(abortedAtOpen.every(Boolean)).toBe(true)
    } finally {
      snapshot = saved
      taskStream.mockReset()
      taskStream.mockImplementation(async () => upstream())
    }
  })

  it("a peer that refuses or is offline gives a plain message, not a raw 403", async () => {
    const saved = upstream
    try {
      const p = phone(["app", "app:live"])
      upstream = () => ({ ok: false, status: 403, error: "node not in dashboard allowlist" })
      let r = await p.call("GET", "/api/app/tasks/stream?taskId=t-run")
      expect(r.status).toBe(502)
      expect((await r.json()).error).toBe("node-a does not let this computer follow its tasks")
      upstream = () => ({ ok: false, status: 502, error: "ECONNREFUSED" })
      r = await p.call("GET", "/api/app/tasks/stream?taskId=t-run")
      expect((await r.json()).error).toBe("node-a could not be reached")
    } finally { upstream = saved }
  })
})

describe("PhoneStreamTrimmer", () => {
  it("drops tool results, thinking and markers; resets the text at each step", () => {
    const t = new PhoneStreamTrimmer()
    expect(t.feed("Reading the file")).toEqual([{ event: "text", data: { text: "Reading the file" } }])
    expect(t.feed("\n→ Grep({\"pattern\":\"x\"})\n")).toEqual([{ event: "step", data: { name: "Grep" } }])
    expect(t.feed("← 3 matches\nline two\n")).toEqual([])
    expect(t.feed("· done (3s)\n")).toEqual([])
    expect(t.feed("Found it.")).toEqual([{ event: "text", data: { text: "Found it." } }])
    expect(t.final()).toBe("Found it.")
    expect(t.failed).toBe(false)
  })

  it("keeps the tail of a long text and the start of the final answer, both ≤ 160", () => {
    const t = new PhoneStreamTrimmer()
    t.feed("x".repeat(500) + "END")
    expect(t.text().length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(t.text().endsWith("END")).toBe(true)
    expect(t.final()!.length).toBeLessThanOrEqual(PREVIEW_CHARS)
  })

  it("names codex steps without their command text", () => {
    const t = new PhoneStreamTrimmer()
    expect(t.feed("\n> codex command_execution rm -rf /tmp/secret\n")).toEqual([{ event: "step", data: { name: "command_execution" } }])
    expect(t.feed("\n> codex mcp_tool_call agentx_lookup\n")).toEqual([{ event: "step", data: { name: "mcp_tool_call agentx_lookup" } }])
  })

  it("marks the run failed on an [error] line", () => {
    const t = new PhoneStreamTrimmer()
    t.feed("[error] something\n")
    expect(t.failed).toBe(true)
  })

  // #2137 review B1: runtimes that are not claude-code mark only the first
  // thinking token with 💭; the rest come bare in later chunks.
  it("keeps thinking dropped across chunks until the thought's newline", () => {
    const t = new PhoneStreamTrimmer()
    const evs = [
      ...t.feed("💭 The user's"),
      ...t.feed(" password is hunter2"),
      ...t.feed(" and more"),
      ...t.feed("\n💭 a second line of the thought"),
    ]
    expect(JSON.stringify(evs)).not.toContain("password")
    expect(evs).toEqual([])
    // The daemon ends the thought with a newline, then the answer comes.
    expect(t.feed("\n")).toEqual([])
    expect(t.feed("Here is the answer.")).toEqual([{ event: "text", data: { text: "Here is the answer." } }])
    expect(t.final()).toBe("Here is the answer.")
  })

  it("drops a thought that starts a chunk right after text, and its later tokens", () => {
    const t = new PhoneStreamTrimmer()
    expect(t.feed("Checking.")).toEqual([{ event: "text", data: { text: "Checking." } }])
    expect(t.feed("💭 secret plan")).toEqual([])
    expect(t.feed(" more secret plan")).toEqual([])
    expect(JSON.stringify(t.final())).not.toContain("secret")
  })

  // #2137 review B2: an error marker glued to text with no newline.
  it("an [error] chunk right after text: the run fails and the error text is dropped", () => {
    const t = new PhoneStreamTrimmer()
    const evs = [...t.feed("…working on it"), ...t.feed("[error] API key invalid\n")]
    expect(JSON.stringify(evs)).not.toContain("API key")
    expect(t.text()).not.toContain("API key")
    expect(t.failed).toBe(true)
  })

  it("in the start buffer, splits markers glued to text (older daemons)", () => {
    const one = new PhoneStreamTrimmer()
    one.feedStart("Working on it[error] API key invalid\n")
    expect(one.failed).toBe(true)
    expect(one.final()).toBe("Working on it")
    const two = new PhoneStreamTrimmer()
    expect(two.feedStart("Checking.💭 secret plan")).toEqual([{ event: "text", data: { text: "Checking." } }])
    expect(two.feed(" more secret plan")).toEqual([])
  })

  // Hakim on #2148: live text that quotes a marker is answer text.
  it("live answer text that quotes [error], ← or · done does not fail or cut the answer", () => {
    for (const quote of ["The log line `[error] connection refused` is harmless.", "Data flows A ← B here.", "Step 1 · done, step 2 next."]) {
      const t = new PhoneStreamTrimmer()
      t.feed("Answer: ")
      t.feed(quote)
      t.feed(" More text.")
      expect(t.failed).toBe(false)
      expect(t.final()).toBe(`Answer: ${quote} More text.`)
    }
  })

  it("the daemon writes every marker line on a line of its own, after a text delta too", () => {
    const f = makeStreamEventFormatter()
    // At the start: no blank line first.
    expect(f({ type: "system", subtype: "init", model: "m" })).toBe("· init model=m\n")
    expect(f({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } })).toBe("Working on it")
    expect(f({ type: "error", message: "API key invalid" })).toBe("\n[error] API key invalid\n")
    f({ type: "assistant", message: { content: [{ type: "text", text: "Working on it, still" }] } })
    expect(f({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }, { type: "tool_result", content: "two" }] } })).toBe("\n← ok\n← two\n")
    expect(f({ type: "result", duration_ms: 2000 })).toBe("· done (2s)\n")
    // The trimmer reads the whole formatted stream right.
    const t = new PhoneStreamTrimmer()
    const g = makeStreamEventFormatter()
    for (const ev of [
      { type: "assistant", message: { content: [{ type: "text", text: "Quoting `[error] x` here" }] } },
      { type: "error", message: "real failure" },
    ]) t.feed(g(ev))
    expect(t.failed).toBe(true)
    expect(t.final()).toBe("Quoting `[error] x` here")
  })

  it("a full start buffer that begins inside a thought shows none of it", () => {
    const t = new PhoneStreamTrimmer()
    const initial = "x".repeat(64 * 1024 - 17) + " hunter2 thinking"
    expect(t.feedStart(initial)).toEqual([])
    expect(t.feed(" still thinking hunter2")).toEqual([])
    expect(t.feed("\nAnswer.")).toEqual([{ event: "text", data: { text: "Answer." } }])
  })
})

describe("agentx app live <device> on|off", () => {
  it("adds and removes app:live on a paired phone only", () => {
    const store = new TokenStore(mkdtempSync(join(tmpdir(), "agentx-app-live-cli-")))
    const { record } = store.create({ name: "Anis phone", scopes: ["app"] })
    expect(setLiveControl(store, record.id, "on")).toMatchObject({ ok: true })
    expect(store.list()[0].scopes).toEqual(["app", "app:live"])
    expect(setLiveControl(store, record.id, "on")).toMatchObject({ ok: true })
    expect(store.list()[0].scopes).toEqual(["app", "app:live"])
    expect(setLiveControl(store, record.id, "off")).toMatchObject({ ok: true })
    expect(store.list()[0].scopes).toEqual(["app"])
    expect(setLiveControl(store, record.id, "maybe")).toMatchObject({ ok: false })
    expect(setLiveControl(store, "tok_none", "on")).toMatchObject({ ok: false })
    const other = store.create({ name: "wall", scopes: ["wall:portfolio"] })
    expect(setLiveControl(store, other.record.id, "on")).toMatchObject({ ok: false })
    store.revoke(record.id)
    expect(setLiveControl(store, record.id, "on")).toMatchObject({ ok: false })
  })
})

describe("Live sheet logic", () => {
  const start: LiveView = { phase: "connecting", step: "", steps: 0, text: "", final: "", more: "" }

  it("parses SSE frames across reads", () => {
    const a = liveSseFrames("event: step\ndata: {\"name\":\"Bash\"}\n\nevent: te")
    expect(a.frames).toEqual([{ event: "step", data: "{\"name\":\"Bash\"}" }])
    const b = liveSseFrames(a.rest + "xt\ndata: {\"text\":\"hi\"}\n\n: ping\n\n")
    expect(b.frames).toEqual([{ event: "text", data: "{\"text\":\"hi\"}" }])
    expect(b.rest).toBe("")
  })

  it("moves through start, step, text and end", () => {
    let v = liveReduce(start, "start", { step: "Read" })
    expect(liveLabel(v)).toBe("Working · Read")
    v = liveReduce(liveReduce(v, "step", { name: "Bash" }), "text", { text: "running tests" })
    expect(v).toMatchObject({ step: "Bash", steps: 2, text: "running tests" })
    v = liveReduce(v, "end", { state: "failed", final: "tests failed", more: "Full answer on the Hub" })
    expect(liveLabel(v)).toBe("Failed")
    expect(v.final).toBe("tests failed")
    expect(liveLabel(liveReduce(start, "end", { state: "ended" }))).toBe("This task has ended")
    expect(liveLabel({ ...start, phase: "lost" })).toBe("Lost the connection")
  })

  it("the app page carries the Live sheet and its injected helpers", () => {
    const html = renderAppPage()
    expect(html).toContain("window.AXLive")
    expect(html).toContain('"liveReduce"')
    expect(html).toContain("data-act=\"watch\"")
  })
})
