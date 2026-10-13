import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore, type Call } from "../src/calls/store"
import { CallService, busyText, CANCELLED_NOTE, type CallDeps } from "../src/calls/service"
import { handleCalls } from "../src/daemon/calls-api"
import { callsSchema, type CallsConfig } from "../src/daemon/config"

// A call that arrives while the widget cannot ring (#408): it waits for
// the widget instead of running out of ring time unseen. The caller is
// told the owner is busy, and may withdraw its call (#969).

const POLL_MS = 2000

let now: number
let cfg: CallsConfig
let notices: Array<{ title: string; message: string; urgent: boolean }>
let calls: CallService
let deps: CallDeps
let inFocus: boolean

beforeEach(async () => {
  now = 1_000_000
  cfg = callsSchema.parse({ allow: ["*"] })
  notices = []
  inFocus = false
  deps = {
    store: new CallStore(new Database(":memory:")),
    config: () => cfg,
    agentName: (id) => ({ writer: "Writer", ops: "Ops", sales: "Sales" } as Record<string, string>)[id] ?? null,
    isRunningTurn: (id, p) => p.taskId === `task-${id}`,
    alert: async (n) => { notices.push(n) },
    focus: () => ({ active: inFocus, mode: null, reason: inFocus ? "on" : "off" }),
    now: () => now,
  }
  calls = new CallService(deps)
  // The widget is running: a new call goes to it, not to notify.
  await calls.ringing()
})

async function place(agentId: string): Promise<Call> {
  const r = await calls.request({ agentId, reason: "Pick a launch date" }, { taskId: `task-${agentId}` })
  if (!r.ok) throw new Error(r.error)
  return r.call
}

/** The widget polls every two seconds for `ms`, saying what it says. */
async function poll(ms: number, widget: { busy?: boolean; showing?: string }): Promise<Call[]> {
  let last: Call[] = []
  for (let t = 0; t < ms; t += POLL_MS) {
    now += POLL_MS
    last = await calls.ringing(widget)
  }
  return last
}

const titles = () => notices.map((n) => n.title)
const maxWait = () => cfg.busy.maxWaitMinutes * 60_000
const retry = () => cfg.busy.retryMinutes * 60_000
const request = (agentId: string, urgency?: string) => calls.request({ agentId, reason: "Pick a launch date", urgency }, { taskId: `task-${agentId}` })

describe("a call while the widget is busy", () => {
  it("waits past ringSeconds, tells the owner once, and rings when the widget is free", async () => {
    const call = await place("writer")
    const offered = await poll(cfg.ringSeconds * 2000, { busy: true })

    expect(offered.map((c) => c.id)).toEqual([call.id])
    expect(calls.get(call.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Call waiting: Writer"])
    expect(notices[0].message).toMatch(/^Pick a launch date\n.*busy/)

    // Free: the ring time runs from the poll where the widget first shows it.
    await poll(cfg.ringSeconds * 1000, { showing: call.id })
    expect(calls.get(call.id)?.status).toBe("ringing")
    await poll(POLL_MS, { showing: call.id })
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "not answered" })
    expect(titles()).toEqual(["Call waiting: Writer", "Missed call from Writer"])
  })

  it("is missed after the longest wait, and says why; the owner is told again on the way", async () => {
    const call = await place("writer")
    await poll(maxWait(), { busy: true })
    expect(calls.get(call.id)?.status).toBe("ringing")
    await poll(cfg.ringSeconds * 1000, { busy: true })
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "widget busy" })
    expect(titles()).toEqual(["Call waiting: Writer", "Call waiting: Writer", "Missed call from Writer"])
  })

  it("rings for the full ring time when the widget is free after the longest wait", async () => {
    const call = await place("writer")
    await poll(maxWait() + cfg.ringSeconds * 1000 - POLL_MS, { busy: true })
    expect(calls.get(call.id)?.status).toBe("ringing")

    await poll(cfg.ringSeconds * 1000, { showing: call.id })
    expect(calls.get(call.id)?.status).toBe("ringing")
    await poll(POLL_MS, { showing: call.id })
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "not answered" })
  })

  it("the call the widget is showing keeps its ring time; a second caller waits", async () => {
    const first = await place("writer")
    await poll(POLL_MS, {})
    const second = await place("ops")
    await poll(cfg.ringSeconds * 1000, { busy: true, showing: first.id })

    expect(calls.get(first.id)?.status).toBe("missed")
    expect(calls.get(second.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Call waiting: Ops", "Missed call from Writer"])
  })

  it("a call that came back from later waits again, with a new notice", async () => {
    const call = await place("writer")
    await poll(POLL_MS, { busy: true })
    await poll(POLL_MS, { showing: call.id })
    calls.later(call.id, 5)
    await poll(5 * 60_000 + cfg.ringSeconds * 2000, { busy: true })

    expect(calls.get(call.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Call waiting: Writer", "Call waiting: Writer"])
  })

  it("a widget that says nothing keeps the old ring time", async () => {
    const call = await place("writer")
    await poll(cfg.ringSeconds * 1000, {})
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "not answered" })
  })

  it("GET /calls/ringing reads busy and showing from the query", async () => {
    const first = await place("writer")
    const second = await place("ops")
    const get = (query: string) => handleCalls(calls, () => cfg, "GET", "/calls/ringing", new URLSearchParams(query), {})
    for (let t = 0; t < cfg.ringSeconds * 1000; t += POLL_MS) {
      now += POLL_MS
      expect((await get(`busy=1&showing=${first.id}`)).status).toBe(200)
    }
    expect(calls.get(first.id)?.status).toBe("missed")
    expect(calls.get(second.id)?.status).toBe("ringing")
  })

  it("the waiting notice is told again every retryMinutes, and its words are settings", async () => {
    cfg = callsSchema.parse({ allow: ["*"], busy: { retryMinutes: 2, maxWaitMinutes: 7, title: "{agent} on the other line", notice: "Rings when you hang up." } })
    await place("writer")
    await poll(retry() - POLL_MS, { busy: true })
    expect(notices).toHaveLength(1)
    await poll(maxWait() - retry(), { busy: true })
    // At 0, 2, 4 and 6 minutes; the wait ends at 7.
    expect(titles()).toEqual(Array(4).fill("Writer on the other line"))
    expect(notices[0].message).toBe("Pick a launch date\nRings when you hang up.")
  })
})

describe("the caller of a busy owner (#969)", () => {
  /** The owner answers `id` on the widget and talks. */
  async function talk(id: string): Promise<void> {
    await poll(POLL_MS, { showing: id })
    expect(calls.answer(id).ok).toBe(true)
    await poll(POLL_MS, { busy: true })
  }

  it("is told the owner is in another call, with whom and until when; the owner gets the notice at once", async () => {
    const first = await place("writer")
    await talk(first.id)
    const r = await request("ops")

    expect(r).toMatchObject({ ok: true, rang: "waiting", call: { status: "ringing" } })
    expect(r.busy).toEqual({ why: "call", with: "Writer", remindAt: now + retry(), waitsUntil: now + maxWait() + cfg.ringSeconds * 1000 })
    // Told before the next poll, and the call in progress is left alone.
    expect(titles()).toEqual(["Call waiting: Ops"])
    expect(notices[0].message).toMatch(/^Pick a launch date\n/)
    expect(calls.get(first.id)?.status).toBe("answered")
    // The next polls do not tell the owner twice.
    await poll(POLL_MS * 5, { busy: true })
    expect(notices).toHaveLength(1)
  })

  it("says another call is ringing, or that the widget is busy, when the owner is not in a call", async () => {
    const first = await place("writer")
    await poll(POLL_MS, { busy: true, showing: first.id })
    expect((await request("ops")).busy).toMatchObject({ why: "ringing", with: "Writer" })

    calls.decline(first.id)
    await poll(POLL_MS, { busy: true })
    expect((await request("sales")).busy).toMatchObject({ why: "voice", with: null })
  })

  it("two calls between two polls: the second is told the first is ringing, and waits", async () => {
    const first = await request("writer")
    const second = await request("ops")
    expect(first).toMatchObject({ ok: true, rang: "widget" })
    expect(second).toMatchObject({ ok: true, rang: "waiting", busy: { why: "ringing", with: "Writer" } })
    expect(titles()).toEqual(["Call waiting: Ops"])
    // The widget shows the first; the second outlives its own ring time.
    if (!first.ok || !second.ok) throw new Error("not placed")
    await poll(cfg.ringSeconds * 2000, { busy: true, showing: first.call.id })
    expect(calls.get(second.call.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Call waiting: Ops", "Missed call from Writer"])
  })

  it("is missed at about waitsUntil when the owner stays busy, not before", async () => {
    const first = await place("writer")
    await talk(first.id)
    const r = await request("ops")
    if (!r.ok || !r.busy) throw new Error("not waiting")
    cfg = { ...cfg, maxCallMinutes: 60 }
    // Within a poll or two of the time the caller was given.
    await poll(r.busy.waitsUntil - now - POLL_MS * 2, { busy: true })
    expect(calls.get(r.call.id)?.status).toBe("ringing")
    await poll(POLL_MS * 2, { busy: true })
    expect(calls.get(r.call.id)).toMatchObject({ status: "missed", note: "widget busy" })
  })

  it("an urgent call during Focus waits for a busy owner; a normal one is held as missed", async () => {
    const first = await place("writer")
    await talk(first.id)
    inFocus = true
    expect(await request("ops", "urgent")).toMatchObject({ ok: true, rang: "waiting", busy: { why: "call" } })
    expect(await request("sales")).toMatchObject({ ok: true, rang: false, call: { status: "missed" } })
  })

  it("withdrawing a call back that is due does not ring it first", async () => {
    const call = await place("writer")
    await poll(POLL_MS, { showing: call.id })
    calls.later(call.id, 5)
    now += 6 * 60_000
    expect(await calls.cancel({ agentId: "writer" }, { taskId: "task-writer" })).toMatchObject({ ok: true, call: { status: "ended", note: CANCELLED_NOTE } })
    expect(notices).toEqual([])
  })

  it("a free widget is not a busy result", async () => {
    const r = await request("writer")
    expect(r).toMatchObject({ ok: true, rang: "widget" })
    expect(r.busy).toBeUndefined()
    expect(notices).toEqual([])
  })

  it("rings by itself when the owner hangs up: one at a time, oldest first", async () => {
    const first = await place("writer")
    await talk(first.id)
    const second = await place("ops")
    now += POLL_MS
    const third = await place("sales")
    await poll(60_000, { busy: true })

    calls.hangup(first.id)
    // Free: both are offered, oldest first, and the widget rings the first.
    const offered = await poll(POLL_MS, {})
    expect(offered.map((c) => c.id)).toEqual([second.id, third.id])
    await poll(POLL_MS * 3, { busy: true, showing: second.id })
    expect(calls.answer(second.id).ok).toBe(true)
    expect(calls.get(third.id)?.status).toBe("ringing")

    await poll(60_000, { busy: true })
    calls.hangup(second.id)
    expect((await poll(POLL_MS, {})).map((c) => c.id)).toEqual([third.id])
    // One waiting notice each, none for ringing after the wait.
    expect(titles()).toEqual(["Call waiting: Ops", "Call waiting: Sales"])
  })

  it("a waiting call counts once against maxPerHour, however long it waits", async () => {
    cfg = callsSchema.parse({ allow: ["*"], maxPerHour: 2 })
    const first = await place("writer")
    await talk(first.id)
    const waiting = await place("ops")
    await poll(retry() * 2, { busy: true })
    calls.decline(waiting.id)
    expect((await request("ops")).ok).toBe(true)
    calls.decline(calls.list({ status: ["ringing"] })[0].id)
    expect(await request("ops")).toMatchObject({ ok: false, status: 429 })
  })

  it("an urgent call waits too, and its notices are urgent", async () => {
    const first = await place("writer")
    await talk(first.id)
    const r = await request("ops", "urgent")
    expect(r).toMatchObject({ ok: true, rang: "waiting", call: { urgency: "urgent" } })
    await poll(retry(), { busy: true })
    expect(notices.map((n) => n.urgent)).toEqual([true, true])
  })

  it("the caller withdraws its waiting call: it never rings, and it may call again", async () => {
    const first = await place("writer")
    await talk(first.id)
    const waiting = await place("ops")

    expect(await calls.cancel({ agentId: "ops" }, { taskId: "task-writer" })).toMatchObject({ ok: false, status: 403 })
    const r = await calls.cancel({ agentId: "ops" }, { taskId: "task-ops" })
    expect(r).toMatchObject({ ok: true, call: { id: waiting.id, status: "ended", note: CANCELLED_NOTE } })
    expect(await calls.cancel({ agentId: "ops" }, { taskId: "task-ops" })).toMatchObject({ ok: false, status: 404 })

    calls.hangup(first.id)
    expect(await poll(maxWait(), {})).toEqual([])
    expect(titles()).toEqual(["Call waiting: Ops"])
    expect((await request("ops")).ok).toBe(true)
  })

  it("an answered call is not withdrawn", async () => {
    const first = await place("writer")
    await talk(first.id)
    expect(await calls.cancel({ agentId: "writer" }, { taskId: "task-writer" })).toMatchObject({ ok: false, status: 404 })
    expect(calls.get(first.id)?.status).toBe("answered")
  })

  it("routes: POST /calls returns busy, POST /calls/cancel withdraws", async () => {
    const first = await place("writer")
    await talk(first.id)
    const post = (path: string, taskId: string) => handleCalls(calls, () => cfg, "POST", path, new URLSearchParams(), { agentId: "ops", reason: "Pick a launch date" }, { taskId })
    const placed = await post("/calls", "task-ops")
    expect(placed.status).toBe(201)
    expect(placed.body).toMatchObject({ rang: "waiting", busy: { why: "call", with: "Writer" } })
    expect((await post("/calls/cancel", "task-writer")).status).toBe(403)
    expect(await post("/calls/cancel", "task-ops")).toMatchObject({ status: 200, body: { call: { status: "ended" } } })
    expect((await handleCalls(calls, () => cfg, "GET", "/calls/cancel", new URLSearchParams(), {})).status).toBe(405)
  })

  it("busyText says who, when the owner is told again, and when the wait ends", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0)
    const text = busyText({ why: "call", with: "Writer", remindAt: at + 5 * 60_000, waitsUntil: at + 10 * 60_000 }, at)
    expect(text).toMatch(/^The owner is busy in another call \(with Writer\)\./)
    expect(text).toMatch(/Still busy at \d\d:\d\d \S+ \(in 5 min\), they are told again/)
    expect(text).toMatch(/waits until \d\d:\d\d \S+ \(in 10 min\) at most/)
    // The time names its zone.
    expect(busyText({ why: "call", with: null, remindAt: null, waitsUntil: at + 10 * 60_000 }, at, "UTC")).toMatch(/waits until 12:10 UTC \(in 10 min\)/)
    expect(text).toContain("do not call again")
    expect(busyText({ why: "voice", with: null, remindAt: null, waitsUntil: at + 60_000 }, at)).not.toMatch(/told again/)
  })

  it("a daemon restart keeps the wait: same waitsUntil, no second notice, still missed as widget busy", async () => {
    const first = await place("writer")
    await talk(first.id)
    const r = await request("ops")
    if (!r.ok || !r.busy) throw new Error("not waiting")
    await poll(60_000, { busy: true })

    // A new service over the same store, as after a restart.
    calls = new CallService(deps)
    cfg = { ...cfg, maxCallMinutes: 60 }
    await poll(POLL_MS, { busy: true })
    expect(titles()).toEqual(["Call waiting: Ops"])
    await poll(r.busy.waitsUntil - now - POLL_MS * 2, { busy: true })
    expect(calls.get(r.call.id)?.status).toBe("ringing")
    await poll(POLL_MS * 2, { busy: true })
    expect(calls.get(r.call.id)).toMatchObject({ status: "missed", note: "widget busy" })
    expect(titles()).toEqual(["Call waiting: Ops", "Call waiting: Ops", "Missed call from Ops"])
  })
})
