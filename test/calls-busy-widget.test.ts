import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore, type Call } from "../src/calls/store"
import { CallService, BUSY_WAIT_MAX_MS, type CallDeps } from "../src/calls/service"
import { handleCalls } from "../src/daemon/calls-api"
import { callsSchema, type CallsConfig } from "../src/daemon/config"

// A call that arrives while the widget cannot ring (#408): it waits for
// the widget instead of running out of ring time unseen.

const POLL_MS = 2000

let now: number
let cfg: CallsConfig
let notices: Array<{ title: string; message: string }>
let calls: CallService

beforeEach(async () => {
  now = 1_000_000
  cfg = callsSchema.parse({ allow: ["*"] })
  notices = []
  const deps: CallDeps = {
    store: new CallStore(new Database(":memory:")),
    config: () => cfg,
    agentName: (id) => ({ writer: "Writer", ops: "Ops" } as Record<string, string>)[id] ?? null,
    isRunningTurn: (id, p) => p.taskId === `task-${id}`,
    alert: async (n) => { notices.push(n) },
    focus: () => ({ active: false, mode: null, reason: "off" }),
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

describe("a call while the widget is busy", () => {
  it("waits past ringSeconds, tells the owner once, and rings when the widget is free", async () => {
    const call = await place("writer")
    const offered = await poll(cfg.ringSeconds * 2000, { busy: true })

    expect(offered.map((c) => c.id)).toEqual([call.id])
    expect(calls.get(call.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Writer is calling"])
    expect(notices[0].message).toMatch(/^Pick a launch date\n.*busy/)

    // Free: the ring time runs from the poll where the widget first shows it.
    await poll(cfg.ringSeconds * 1000, { showing: call.id })
    expect(calls.get(call.id)?.status).toBe("ringing")
    await poll(POLL_MS, { showing: call.id })
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "not answered" })
    expect(titles()).toEqual(["Writer is calling", "Missed call from Writer"])
  })

  it("is missed after the longest wait, and says why", async () => {
    const call = await place("writer")
    await poll(BUSY_WAIT_MAX_MS, { busy: true })
    expect(calls.get(call.id)?.status).toBe("ringing")
    await poll(cfg.ringSeconds * 1000, { busy: true })
    expect(calls.get(call.id)).toMatchObject({ status: "missed", note: "widget busy" })
    expect(titles()).toEqual(["Writer is calling", "Missed call from Writer"])
  })

  it("rings for the full ring time when the widget is free after the longest wait", async () => {
    const call = await place("writer")
    await poll(BUSY_WAIT_MAX_MS + cfg.ringSeconds * 1000 - POLL_MS, { busy: true })
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
    expect(titles()).toEqual(["Ops is calling", "Missed call from Writer"])
  })

  it("a call that came back from later waits again, with a new notice", async () => {
    const call = await place("writer")
    await poll(POLL_MS, { busy: true })
    await poll(POLL_MS, { showing: call.id })
    calls.later(call.id, 5)
    await poll(5 * 60_000 + cfg.ringSeconds * 2000, { busy: true })

    expect(calls.get(call.id)?.status).toBe("ringing")
    expect(titles()).toEqual(["Writer is calling", "Writer is calling"])
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
})
