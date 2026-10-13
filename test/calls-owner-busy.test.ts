import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore, type Call } from "../src/calls/store"
import { CallService, IN_A_CALL, fill, type CallDeps } from "../src/calls/service"
import { handleCalls } from "../src/daemon/calls-api"
import { callsSchema, type CallsConfig } from "../src/daemon/config"

// A call that arrives while the owner is already in a call (#969): the
// owner hears "call waiting", the caller is told the owner is busy, and
// the call rings again by itself, one at a time, oldest first.

const MIN = 60_000

let now: number
let cfg: CallsConfig
let focus: boolean
let notices: Array<{ title: string; message: string; urgent: boolean }>
let calls: CallService

beforeEach(async () => {
  now = 1_000_000
  focus = false
  cfg = callsSchema.parse({ allow: ["*"], maxPerHour: 2 })
  notices = []
  const deps: CallDeps = {
    store: new CallStore(new Database(":memory:")),
    config: () => cfg,
    agentName: (id) => ({ writer: "Writer", ops: "Ops", scout: "Scout" } as Record<string, string>)[id] ?? null,
    isRunningTurn: (id, p) => p.taskId === `task-${id}`,
    alert: async (n) => { notices.push(n) },
    focus: () => ({ active: focus, mode: focus ? "Do Not Disturb" : null, reason: focus ? "focus" : "off" }),
    now: () => now,
  }
  calls = new CallService(deps)
  await calls.ringing()
})

async function place(agentId: string, reason = "Pick a launch date", urgency?: string) {
  const r = await calls.request({ agentId, reason, urgency }, { taskId: `task-${agentId}` })
  if (!r.ok) throw new Error(r.error)
  return r
}

/** The owner answers a call from `agentId`: they are in a call now. */
async function inCallWith(agentId: string): Promise<Call> {
  const { call } = await place(agentId, "Talk now")
  const r = calls.answer(call.id)
  if (!r.ok) throw new Error(r.error)
  return r.call
}

/** Time passes; the widget polls, busy while the owner is in a call. */
async function wait(ms: number): Promise<void> {
  now += ms
  await calls.ringing({ busy: calls.inACall() })
}

describe("a call while the owner is in another call", () => {
  it("does not ring, tells the owner once, and tells the caller the owner is busy and when it rings", async () => {
    const current = await inCallWith("writer")
    const r = await place("ops", "The deploy failed")

    expect(r.call).toMatchObject({ status: "later", note: IN_A_CALL, ringAgainAt: now + 5 * MIN })
    expect(r.busy).toEqual({ ringAgainAt: now + 5 * MIN })
    expect(r.rang).toBe(false)
    expect(notices).toEqual([expect.objectContaining({
      title: "Call waiting", urgent: false,
      message: "Ops is calling: The deploy failed. You are in a call, so it rings again in 5 min.",
    })])
    // The current call goes on.
    expect(calls.get(current.id)?.status).toBe("answered")
    expect(await calls.ringing({ busy: true })).toEqual([])
  })

  it("the delay and the notice are settings", async () => {
    cfg = callsSchema.parse({ allow: ["*"], busy: { ringAgainMinutes: 12, notice: "{agent} waits ({minutes} min): {reason}" } })
    await inCallWith("writer")
    const r = await place("ops", "Budget")
    expect(r.busy?.ringAgainAt).toBe(now + 12 * MIN)
    expect(notices.at(-1)?.message).toBe("Ops waits (12 min): Budget")
  })

  it("POST /calls answers 202 with busy and ringAgainAt", async () => {
    await inCallWith("writer")
    const res = await handleCalls(calls, () => cfg, "POST", "/calls", new URLSearchParams(),
      { agentId: "ops", reason: "Budget" }, { taskId: "task-ops" })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ rang: false, busy: true, ringAgainAt: now + 5 * MIN, call: { status: "later" } })
  })

  it("rings again by itself when due and the owner is free", async () => {
    const current = await inCallWith("writer")
    const { call } = await place("ops")
    calls.hangup(current.id)
    await wait(5 * MIN - 1)
    expect(calls.get(call.id)?.status).toBe("later")
    await wait(1)
    expect(calls.get(call.id)).toMatchObject({ status: "ringing", note: null, ringAgainAt: null })
    expect((await calls.ringing()).map((c) => c.id)).toEqual([call.id])
  })

  it("still due while the owner talks: rings as soon as they hang up", async () => {
    const current = await inCallWith("writer")
    const { call } = await place("ops")
    await wait(20 * MIN)
    expect(calls.get(call.id)?.status).toBe("later")
    calls.hangup(current.id)
    await wait(1000)
    expect(calls.get(call.id)?.status).toBe("ringing")
  })

  it("several waiting calls ring one at a time, oldest first", async () => {
    const current = await inCallWith("writer")
    const first = (await place("ops")).call
    now += 1000
    const second = (await place("scout")).call
    await wait(10 * MIN)
    calls.hangup(current.id)

    await wait(1000)
    expect(calls.get(first.id)?.status).toBe("ringing")
    expect(calls.get(second.id)?.status).toBe("later")

    // The first is missed: then the second rings.
    await wait(cfg.ringSeconds * 1000)
    expect(calls.get(first.id)?.status).toBe("missed")
    expect(calls.get(second.id)?.status).toBe("ringing")
  })

  it("the next waits while the owner is on the call that rang first", async () => {
    const current = await inCallWith("writer")
    const first = (await place("ops")).call
    const second = (await place("scout")).call
    calls.hangup(current.id)
    await wait(5 * MIN)
    expect(calls.answer(first.id).ok).toBe(true)
    await wait(10 * MIN)
    expect(calls.get(second.id)?.status).toBe("later")
  })

  it("calls.maxPerHour still applies per agent", async () => {
    await inCallWith("writer")
    await place("ops")
    calls.decline((calls.list({ status: ["later"] })[0]).id)
    await place("ops")
    calls.decline((calls.list({ status: ["later"] })[0]).id)
    const r = await calls.request({ agentId: "ops", reason: "Again" }, { taskId: "task-ops" })
    expect(r).toMatchObject({ ok: false, status: 429 })
  })

  it("a second normal call from the waiting agent is refused with the time it rings", async () => {
    await inCallWith("writer")
    await place("ops")
    const r = await calls.request({ agentId: "ops", reason: "Again" }, { taskId: "task-ops" })
    expect(r).toMatchObject({ ok: false, status: 409 })
    if (!r.ok) expect(r.error).toMatch(/rings again at/)
  })

  it("an urgent call follows the urgent rules: it rings, waiting for the widget", async () => {
    await inCallWith("writer")
    const r = await place("ops", "Server down", "urgent")
    expect(r.call.status).toBe("ringing")
    expect(r.busy).toEqual({ ringAgainAt: null })
  })

  it("a waiting call turns urgent: the same call rings now with the new reason", async () => {
    await inCallWith("writer")
    const { call } = await place("ops", "Budget")
    const r = await place("ops", "Server down", "urgent")
    expect(r.call).toMatchObject({ id: call.id, status: "ringing", urgency: "urgent", reason: "Server down", note: null })
    expect(calls.list({ limit: 10 }).filter((c) => c.agentId === "ops")).toHaveLength(1)
  })

  it("Focus still holds a normal call as missed", async () => {
    await inCallWith("writer")
    focus = true
    const r = await place("ops")
    expect(r.call.status).toBe("missed")
    expect(r.busy).toBeUndefined()
  })

  it("a widget conversation without a call keeps the #408 wait", async () => {
    const r = await place("ops")
    expect(r.call.status).toBe("ringing")
    expect(r.busy).toBeUndefined()
  })
})

describe("fill", () => {
  it("fills known placeholders and leaves the rest", () => {
    expect(fill("{agent} at {time} {nope}", { agent: "Ops", time: "10:05" })).toBe("Ops at 10:05 {nope}")
  })
})
