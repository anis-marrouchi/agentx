import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore, type Call } from "../src/calls/store"
import { CallService, WIDGET_FRESH_MS, openerPrompt, SUMMARY_PROMPT, callerHeaders, type CallDeps } from "../src/calls/service"
import { handleCalls, isCallsPath } from "../src/daemon/calls-api"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { callsSchema, type CallsConfig } from "../src/daemon/config"
import { setCaller } from "../src/commands/call"
import type { FocusState } from "../src/notify/focus"

// An agent rings the owner (#321): policy, lifecycle, routes and gate.

const OFF: FocusState = { active: false, mode: null, reason: "off" }
const ON: FocusState = { active: true, mode: "com.apple.focus.work", reason: "on" }

let now: number
let focus: FocusState
let cfg: CallsConfig
let notices: Array<{ title: string; message: string; urgent: boolean; from: string }>
let filed: Array<{ call: Call; summary: string }>
let summaryText: string | null
/** Notices wait on this, to hold a sweep mid-way. */
let gate: Promise<void>
let calls: CallService
/** The chat a task-proved turn runs in, when the test sets one. */
let turnChat: { channel: string; chatId: string } | null

beforeEach(() => {
  now = 1_000_000
  focus = OFF
  cfg = callsSchema.parse({ allow: ["writer"] })
  notices = []
  filed = []
  summaryText = "We agreed to ship on Friday."
  gate = Promise.resolve()
  turnChat = null
  const deps: CallDeps = {
    store: new CallStore(new Database(":memory:")),
    config: () => cfg,
    agentName: (id) => ({ writer: "Writer", ops: "Ops" } as Record<string, string>)[id] ?? null,
    // Each agent has one running turn: task `task-<id>`, or chat voice:<id>.
    isRunningTurn: (id, p) => p.taskId ? p.taskId === `task-${id}` : p.channel === "voice" && p.chatId === `voice:${id}`,
    turnSession: (id, p) => p.taskId === `task-${id}` ? turnChat : null,
    alert: async (n) => { notices.push(n); await gate },
    summarize: async () => summaryText,
    file: (call, summary) => { filed.push({ call, summary }) },
    focus: () => focus,
    now: () => now,
  }
  calls = new CallService(deps)
})

/** A call placed from inside the agent's own running turn. */
const place = (input: { agentId: string; reason: string; urgency?: string }) =>
  calls.request(input, { taskId: `task-${input.agentId}` })

/** The widget polls, so it counts as running. */
async function widgetUp() { await calls.ringing() }

describe("config", () => {
  it("defaults to nobody allowed", () => {
    const d = callsSchema.parse(undefined)
    expect(d.allow).toEqual([])
    expect(d).toMatchObject({ maxPerHour: 3, ringSeconds: 45, maxCallMinutes: 30, ringSound: "Submarine", summary: true })
  })

  it("setCaller adds and removes an agent in calls.allow", () => {
    const raw: any = {}
    expect(setCaller(raw, "writer", true)).toMatch(/may now call/)
    expect(raw.calls.allow).toEqual(["writer"])
    expect(setCaller(raw, "writer", true)).toMatch(/already/)
    expect(setCaller(raw, "writer", false)).toMatch(/no longer/)
    expect(raw.calls.allow).toEqual([])
  })
})

describe("request", () => {
  it("rings on the widget when it is polling", async () => {
    await widgetUp()
    const r = await place({ agentId: "writer", reason: "  The deploy\n needs you  " })
    expect(r.ok && r.rang).toBe("widget")
    if (!r.ok) return
    expect(r.call).toMatchObject({ agentId: "writer", reason: "The deploy needs you", status: "ringing", urgency: "normal" })
    expect(notices).toEqual([])
    expect((await calls.ringing()).map((c) => c.id)).toEqual([r.call.id])
  })

  it("falls back to notify when the widget is not running", async () => {
    await widgetUp()
    now += WIDGET_FRESH_MS
    const r = await place({ agentId: "writer", reason: "Need a decision" })
    expect(r.ok && r.rang).toBe("notify")
    expect(notices).toEqual([expect.objectContaining({ title: "Writer is calling", urgent: false, from: "writer" })])
    expect(notices[0].message).toMatch(/^Need a decision\n/)
  })

  it("refuses an agent the owner did not allow", async () => {
    const r = await place({ agentId: "ops", reason: "hi" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    cfg = { ...cfg, allow: ["*"] }
    expect((await place({ agentId: "ops", reason: "hi" })).ok).toBe(true)
  })

  it("rejects bad input and unknown agents", async () => {
    expect(await place({ agentId: "writer", reason: " " })).toMatchObject({ status: 400 })
    expect(await place({ agentId: "writer", reason: "x".repeat(201) })).toMatchObject({ status: 413 })
    cfg = { ...cfg, allow: ["*"] }
    expect(await place({ agentId: "ghost", reason: "hi" })).toMatchObject({ status: 404 })
  })

  it("allows one call in progress per agent", async () => {
    await place({ agentId: "writer", reason: "one" })
    expect(await place({ agentId: "writer", reason: "two" })).toMatchObject({ ok: false, status: 409 })
  })

  it("rate-limits each agent per hour", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await place({ agentId: "writer", reason: `call ${i}` })
      if (r.ok) calls.decline(r.call.id)
    }
    expect(await place({ agentId: "writer", reason: "fourth" })).toMatchObject({ ok: false, status: 429 })
    now += 3_600_000
    expect((await place({ agentId: "writer", reason: "next hour" })).ok).toBe(true)
  })

  it("holds a non-urgent call during Focus as missed, through notify", async () => {
    focus = ON
    await widgetUp()
    const r = await place({ agentId: "writer", reason: "Can wait" })
    expect(r.ok && r.rang).toBe(false)
    if (!r.ok) return
    expect(r.call).toMatchObject({ status: "missed", note: "in work" })
    expect(notices).toEqual([expect.objectContaining({ title: "Missed call from Writer", urgent: false })])
    expect(await calls.ringing()).toEqual([])
  })

  it("rings an urgent call through Focus", async () => {
    focus = ON
    await widgetUp()
    const r = await place({ agentId: "writer", reason: "Prod is down", urgency: "urgent" })
    expect(r.ok && r.rang).toBe("widget")
  })
})

describe("lifecycle", () => {
  async function ringingCall(): Promise<Call> {
    await widgetUp()
    const r = await place({ agentId: "writer", reason: "Pick a launch date" })
    if (!r.ok) throw new Error(r.error)
    return r.call
  }

  it("answer returns the opener with the reason", async () => {
    const call = await ringingCall()
    const r = calls.answer(call.id)
    expect(r.ok && r.call.status).toBe("answered")
    expect(r.ok && r.opener).toBe(openerPrompt(call))
    expect(r.ok && r.opener).toContain('"Pick a launch date"')
    expect(calls.answer(call.id)).toMatchObject({ ok: false, status: 409 })
  })

  it("hang-up ends the call and files the agent's summary", async () => {
    const call = await ringingCall()
    calls.answer(call.id)
    const r = calls.hangup(call.id)
    expect(r.ok && r.call.status).toBe("ended")
    await (r.ok ? r.summarized : undefined)
    expect(calls.get(call.id)?.summary).toBe("We agreed to ship on Friday.")
    expect(filed).toEqual([expect.objectContaining({ summary: "We agreed to ship on Friday." })])
  })

  it("files nothing when the summary is off or empty", async () => {
    const call = await ringingCall()
    calls.answer(call.id)
    summaryText = "  "
    const r = calls.hangup(call.id)
    await (r.ok ? r.summarized : undefined)
    expect(filed).toEqual([])
    expect(SUMMARY_PROMPT).toMatch(/summarise/)
  })

  it("only an answered call hangs up", async () => {
    const call = await ringingCall()
    expect(calls.hangup(call.id)).toMatchObject({ ok: false, status: 409 })
  })

  it("an unanswered call becomes missed after ringSeconds", async () => {
    const call = await ringingCall()
    now += cfg.ringSeconds * 1000
    expect(await calls.ringing()).toEqual([])
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "not answered" })
    expect(notices.at(-1)).toMatchObject({ title: "Missed call from Writer" })
  })

  it("a call answered while a sweep is mid-way stays answered", async () => {
    cfg = { ...cfg, allow: ["*"] }
    await widgetUp()
    const a = await place({ agentId: "writer", reason: "first" })
    const b = await place({ agentId: "ops", reason: "second" })
    if (!a.ok || !b.ok) throw new Error("not placed")
    now += cfg.ringSeconds * 1000
    let release!: () => void
    gate = new Promise((r) => { release = r })
    // The sweep read both as overdue, marked the newest missed, and now
    // waits on its notice; the owner picks up the other one meanwhile.
    const sweeping = calls.sweep()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.answer(a.call.id).ok).toBe(true)
    release()
    await sweeping
    expect(calls.get(a.call.id)?.status).toBe("answered")
    expect(calls.get(b.call.id)?.status).toBe("missed")
    expect(notices.filter((n) => n.title.startsWith("Missed"))).toHaveLength(1)
  })

  it("two sweeps at once send one missed notice", async () => {
    await ringingCall()
    now += cfg.ringSeconds * 1000
    await Promise.all([calls.sweep(), calls.sweep(), calls.ringing()])
    expect(notices.filter((n) => n.title.startsWith("Missed"))).toHaveLength(1)
  })

  it("later rings again when due", async () => {
    const call = await ringingCall()
    expect(calls.later(call.id, 0)).toMatchObject({ ok: false, status: 400 })
    expect(calls.later(call.id, 5)).toMatchObject({ ok: true, call: { status: "later" } })
    now += 4 * 60_000
    expect(await calls.ringing()).toEqual([])
    now += 60_000
    const again = await calls.ringing()
    expect(again.map((c) => c.id)).toEqual([call.id])
    expect(again[0].ringingSince).toBe(now)
  })

  it("an answered call nobody hangs up ends, and the agent can call again", async () => {
    const call = await ringingCall()
    expect(calls.answer(call.id).ok).toBe(true)
    now += (cfg.maxCallMinutes - 1) * 60_000
    await calls.sweep()
    expect(await place({ agentId: "writer", reason: "again" })).toMatchObject({ ok: false, status: 409 })
    now += 60_000
    await calls.sweep()
    expect(calls.get(call.id)).toMatchObject({ status: "ended", note: "no hang-up", endedAt: now })
    expect((await place({ agentId: "writer", reason: "again" })).ok).toBe(true)
    expect(filed).toEqual([])
  })

  it("decline ends a ringing call", async () => {
    const call = await ringingCall()
    expect(calls.decline(call.id)).toMatchObject({ ok: true, call: { status: "declined" } })
    expect(calls.decline("call-nope")).toMatchObject({ ok: false, status: 404 })
  })
})

describe("caller identity", () => {
  it("refuses an allowed agent's id with no running turn of it", async () => {
    expect(await calls.request({ agentId: "writer", reason: "hi" })).toMatchObject({ ok: false, status: 403 })
    // ops (not allowed) naming writer, with its own task id
    expect(await calls.request({ agentId: "writer", reason: "hi", urgency: "urgent" }, { taskId: "task-ops" }))
      .toMatchObject({ ok: false, status: 403 })
    expect(await calls.request({ agentId: "writer", reason: "hi" }, { channel: "voice", chatId: "voice:ops" }))
      .toMatchObject({ ok: false, status: 403 })
    expect(calls.list()).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  it("accepts a warm process by its channel and chat", async () => {
    expect((await calls.request({ agentId: "writer", reason: "hi" }, { channel: "voice", chatId: "voice:writer" })).ok).toBe(true)
  })

  it("the route refuses a request without proof", async () => {
    const r = await handleCalls(calls, () => cfg, "POST", "/calls", new URLSearchParams(), { agentId: "writer", reason: "hi" })
    expect(r.status).toBe(403)
  })

  it("callerHeaders prefers the task id, else channel and chat", () => {
    expect(callerHeaders({ AGENTX_TASK_ID: "t1", AGENTX_CHANNEL: "voice", AGENTX_CHAT_ID: "c" })).toEqual({ "X-AgentX-Task": "t1" })
    expect(callerHeaders({ AGENTX_CHANNEL: "voice", AGENTX_CHAT_ID: "c" })).toEqual({ "X-AgentX-Channel": "voice", "X-AgentX-Chat": "c" })
    expect(callerHeaders({ AGENTX_CHANNEL: "voice" })).toEqual({})
  })
})

// A camera ask (#325 phase 3) is a call of kind "camera": the same checks,
// answered on the phone instead of the widget.
describe("camera asks", () => {
  const see = (input: { agentId: string; reason: string; urgency?: string }, proof: { taskId?: string; channel?: string; chatId?: string } = { taskId: `task-${input.agentId}` }) =>
    calls.request({ ...input, kind: "camera" }, proof)

  it("tells the phone, never the widget, and is answered on the phone", async () => {
    await widgetUp()
    const r = await see({ agentId: "writer", reason: "Show me the rack" })
    expect(r.ok && r.rang).toBe("notify")
    if (!r.ok) return
    expect(r.call).toMatchObject({ kind: "camera", status: "ringing", reason: "Show me the rack", channel: null, chatId: null })
    expect(notices).toEqual([expect.objectContaining({ title: "Writer wants to see through your camera", from: "writer", urgent: false })])
    expect(notices[0].message).toMatch(/tap Show/)
    expect(await calls.ringing()).toEqual([])                      // the widget's poll: voice only
    expect((await calls.asking()).map((c) => c.id)).toEqual([r.call.id])
    const answered = calls.answer(r.call.id)
    expect(answered.ok && answered.call.status).toBe("answered")
    expect(answered.ok && answered.opener).toBeUndefined()         // nothing to say first
  })

  it("asking() does not count as the widget being up", async () => {
    await calls.asking()
    const r = await place({ agentId: "writer", reason: "voice" })
    expect(r.ok && r.rang).toBe("notify")
  })

  it("uses the same allowlist, rate limit, one-in-progress rule and running-turn proof as calls", async () => {
    expect(await see({ agentId: "ops", reason: "hi" })).toMatchObject({ ok: false, status: 403, error: /may not ask to see/ })
    expect(await see({ agentId: "writer", reason: "hi" }, {})).toMatchObject({ ok: false, status: 403 })
    expect(await see({ agentId: "writer", reason: "hi" }, { taskId: "task-ops" })).toMatchObject({ ok: false, status: 403 })
    expect(await calls.request({ agentId: "writer", reason: "hi", kind: "video" }, { taskId: "task-writer" })).toMatchObject({ ok: false, status: 400 })
    const first = await see({ agentId: "writer", reason: "one" })
    expect(first.ok).toBe(true)
    expect(await see({ agentId: "writer", reason: "two" })).toMatchObject({ ok: false, status: 409 })
    expect(await place({ agentId: "writer", reason: "a voice call meanwhile" })).toMatchObject({ ok: false, status: 409 })
    if (first.ok) calls.decline(first.call.id)
    for (let i = 0; i < 2; i++) {
      const r = await see({ agentId: "writer", reason: `ask ${i}` })
      if (r.ok) calls.decline(r.call.id)
    }
    expect(await see({ agentId: "writer", reason: "fourth this hour" })).toMatchObject({ ok: false, status: 429 })
    expect(await place({ agentId: "writer", reason: "voice, same hour" })).toMatchObject({ ok: false, status: 429 })
  })

  it("keeps the chat the agent asked from, so the answer goes back there", async () => {
    turnChat = { channel: "telegram", chatId: "chat-9" }
    const byTask = await see({ agentId: "writer", reason: "the invoice" })
    expect(byTask.ok && byTask.call).toMatchObject({ channel: "telegram", chatId: "chat-9" })
    if (byTask.ok) calls.decline(byTask.call.id)
    const warm = await see({ agentId: "writer", reason: "the cable" }, { channel: "voice", chatId: "voice:writer" })
    expect(warm.ok && warm.call).toMatchObject({ channel: "voice", chatId: "voice:writer" })
    // A voice call keeps no chat: nothing is answered there afterwards.
    if (warm.ok) calls.decline(warm.call.id)
    const voice = await place({ agentId: "writer", reason: "talk" })
    expect(voice.ok && voice.call).toMatchObject({ kind: "voice", channel: null, chatId: null })
  })

  it("is held as missed in Focus, and missed when nobody taps Show", async () => {
    focus = ON
    const held = await see({ agentId: "writer", reason: "later" })
    expect(held.ok && held.rang).toBe(false)
    expect(held.ok && held.call).toMatchObject({ status: "missed", note: "in work" })
    expect(notices.at(-1)).toMatchObject({ title: "Writer asked to see through your camera" })
    focus = OFF
    const asked = await see({ agentId: "writer", reason: "now" })
    if (!asked.ok) throw new Error(asked.error)
    now += cfg.ringSeconds * 1000
    expect(await calls.asking()).toEqual([])
    expect(calls.get(asked.call.id)).toMatchObject({ status: "missed", note: "not answered" })
    expect(notices.at(-1)).toMatchObject({ title: "Writer asked to see through your camera" })
  })

  it("ends with the share, without a summary", async () => {
    const r = await see({ agentId: "writer", reason: "rack" })
    if (!r.ok) throw new Error(r.error)
    expect(calls.endCamera(r.call.id, "phone stopped")).toBe(false)   // not answered yet: still asking
    calls.answer(r.call.id)
    expect(calls.endCamera(r.call.id, "phone stopped")).toBe(true)
    expect(calls.get(r.call.id)).toMatchObject({ status: "ended", note: "phone stopped", summary: null })
    expect(filed).toEqual([])
    expect(calls.endCamera(r.call.id)).toBe(false)
    // hangup on an answered camera ask ends it too, and files nothing.
    const again = await see({ agentId: "writer", reason: "again" })
    if (!again.ok) throw new Error(again.error)
    calls.answer(again.call.id)
    const h = calls.hangup(again.call.id)
    expect(h.ok && h.summarized).toBeUndefined()
    expect(filed).toEqual([])
    const voice = await place({ agentId: "writer", reason: "talk" })
    expect(calls.endCamera(voice.ok ? voice.call.id : "x")).toBe(false)
  })

  it("the store migrates a table from before camera asks", () => {
    const db = new Database(":memory:")
    db.exec(`CREATE TABLE calls (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, reason TEXT NOT NULL,
      urgency TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, ringing_since INTEGER,
      answered_at INTEGER, ended_at INTEGER, ring_again_at INTEGER, note TEXT, summary TEXT)`)
    db.prepare("INSERT INTO calls VALUES ('call-old', 'writer', 'old one', 'normal', 'ended', 5, NULL, 6, 7, NULL, NULL, 'done')").run()
    const store = new CallStore(db)
    expect(store.get("call-old")).toMatchObject({ kind: "voice", channel: null, chatId: null, summary: "done" })
    expect(store.list({ kind: "camera" })).toEqual([])
    expect(store.list({ kind: "voice" }).map((c) => c.id)).toEqual(["call-old"])
    new CallStore(db)   // a second open changes nothing
    expect(store.list()).toHaveLength(1)
  })

  it("routes: kind on POST, ?kind= on GET, and the phone's /calls/asking", async () => {
    const post = (body: Record<string, unknown>) => handleCalls(calls, () => cfg, "POST", "/calls", new URLSearchParams(), body, { taskId: `task-${body.agentId}` })
    const placed = await post({ agentId: "writer", reason: "the rack", kind: "camera" })
    expect(placed.status).toBe(201)
    const id = (placed.body as any).call.id
    const asking = await handleCalls(calls, () => cfg, "GET", "/calls/asking", new URLSearchParams(), {})
    expect(asking).toMatchObject({ status: 200, body: { ringSeconds: 45 } })
    expect((asking.body as any).calls.map((c: Call) => c.id)).toEqual([id])
    const ringing = await handleCalls(calls, () => cfg, "GET", "/calls/ringing", new URLSearchParams(), {})
    expect((ringing.body as any).calls).toEqual([])
    const listed = await handleCalls(calls, () => cfg, "GET", "/calls", new URLSearchParams("kind=camera&status=ringing"), {})
    expect((listed.body as any).calls.map((c: Call) => c.id)).toEqual([id])
    const voices = await handleCalls(calls, () => cfg, "GET", "/calls", new URLSearchParams("kind=voice"), {})
    expect((voices.body as any).calls).toEqual([])
    const answered = await handleCalls(calls, () => cfg, "POST", `/calls/${id}/answer`, new URLSearchParams(), {})
    expect(answered.status).toBe(200)
    expect((answered.body as any).opener).toBeUndefined()
  })
})

describe("routes", () => {
  const get = (path: string, q = "") => handleCalls(calls, () => cfg, "GET", path, new URLSearchParams(q), {})
  const post = (path: string, body: Record<string, unknown> = {}) =>
    handleCalls(calls, () => cfg, "POST", path, new URLSearchParams(), body, { taskId: `task-${body.agentId}` })

  it("are all mesh-gated", () => {
    for (const p of ["/calls", "/calls/ringing", "/calls/call-1/answer"]) {
      expect(isCallsPath(p)).toBe(true)
      expect(isMeshGatedPath(p)).toBe(true)
    }
    expect(isCallsPath("/call")).toBe(false)
  })

  it("place, poll, answer and hang up", async () => {
    await get("/calls/ringing")
    const placed = await post("/calls", { agentId: "writer", reason: "Quick question" })
    expect(placed.status).toBe(201)
    const id = (placed.body as any).call.id

    const ringing = await get("/calls/ringing")
    expect(ringing).toMatchObject({ status: 200, body: { ringSound: "Submarine", ringSeconds: 45 } })
    expect((ringing.body as any).calls.map((c: Call) => c.id)).toEqual([id])

    const answered = await post(`/calls/${id}/answer`)
    expect(answered.status).toBe(200)
    expect((answered.body as any).opener).toContain("Quick question")
    expect((await post(`/calls/${id}/hangup`)).status).toBe(200)
    expect((await get(`/calls/${id}`)).body).toMatchObject({ call: { status: "ended" } })
  })

  it("202 when held in Focus, 403 when not allowed", async () => {
    focus = ON
    expect((await post("/calls", { agentId: "writer", reason: "later" })).status).toBe(202)
    expect((await post("/calls", { agentId: "ops", reason: "hi" })).status).toBe(403)
  })

  it("lists by status and 404s the unknown", async () => {
    focus = ON
    await post("/calls", { agentId: "writer", reason: "missed one" })
    const missed = await get("/calls", "status=missed,bogus")
    expect((missed.body as any).calls).toHaveLength(1)
    expect((await get("/calls/call-nope")).status).toBe(404)
    expect((await post("/calls/call-nope/explode")).status).toBe(404)
    expect((await post("/calls/x/later", { minutes: 5 })).status).toBe(404)
  })
})
