import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { RequestStore } from "../src/requests/store"
import { PlanStore, latestWait } from "../src/requests/plan-store"
import { runRequestsSweep, type RequestSweepDeps } from "../src/requests/sweep"
import type { RequestSettings } from "../src/requests/tracker"

// #2544 (retro:01M8FPNNPQ9M0QZ7FPCKZR5TVY): a request whose active plan
// step waits until a later time is not woken by the requests check before
// it. Warn logs and still wakes; enforce holds and moves the due time.

const HOUR = 3_600_000
const ID = "req-wait"
const DUE = Date.parse("2026-11-27T18:08:00Z")
const WAIT = Date.parse("2026-11-28T23:15:00Z")
let tmp: string
let cwd: string
let store: RequestStore
let plans: PlanStore
let db: NonNullable<ReturnType<typeof openDb>>

const settings = (mode: "warn" | "enforce"): RequestSettings => ({
  enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90,
  settleHandedBack: false, stepWaitHold: mode,
})

beforeEach(() => {
  cwd = process.cwd()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "agentx-2544-")))
  process.chdir(tmp)
  writeFileSync(path.join(tmp, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, agents: {} }))
  db = openDb()!
  store = new RequestStore(db)
  plans = new PlanStore(db)
  const start = DUE - 2 * HOUR
  store.addCandidate({ id: ID, runId: "run-1", channel: "telegram", chatId: "chat-1", sender: "4242", agentId: "coder", text: "Ship the fix", now: start })
  store.progress(ID, start)
  store.setLoop(ID, { dueAt: DUE }, start)
  plans.create(ID, "coder", [{ name: "Wait for review", kind: "agent", agentId: "coder", doneWhen: "review in", needsApproval: false }], start)
  plans.updateStep(ID, 1, { state: "active", waitUntil: WAIT, updatedAt: start })
})
afterEach(() => {
  closeDb()
  process.chdir(cwd)
  rmSync(tmp, { recursive: true, force: true })
})

/** One check at `now`; what it woke or raised. */
async function sweep(mode: "warn" | "enforce", now: number, extra: Partial<RequestSweepDeps> = {}) {
  const lines: string[] = []
  const wakes: string[] = []
  await runRequestsSweep({
    store, settings: settings(mode), now, log: (l) => { lines.push(l) },
    wakeJob: (id) => { wakes.push(`job:${id}`); return true },
    waitsUntil: (id, at) => plans.get(id)?.state === "active" ? latestWait(plans.steps(id), at) : null,
    ...extra,
  })
  const raised = store.get(ID)!.state === "needs_attention"
  return { lines, wakes, raised }
}

describe("latestWait", () => {
  const now = Date.parse("2026-11-28T00:00:00Z")
  it("is the latest wait of the active steps still ahead, or null", () => {
    expect(latestWait([
      { idx: 1, state: "active", waitUntil: now + 1000 },
      { idx: 2, state: "active", waitUntil: now + 5000 },
      { idx: 3, state: "pending", waitUntil: now + 9000 },
      { idx: 4, state: "active", waitUntil: now - 1 },
      { idx: 5, state: "active", waitUntil: null },
    ], now)).toEqual({ idx: 2, until: now + 5000 })
    expect(latestWait([{ idx: 1, state: "active", waitUntil: now }], now)).toBeNull()
    expect(latestWait([], now)).toBeNull()
  })
})

describe("overdue request with an active step waiting", () => {
  it("enforce: no wake before the wait, due moved to it", async () => {
    const r = await sweep("enforce", DUE + HOUR)
    expect(r.wakes).toEqual([])
    expect(r.raised).toBe(false)
    expect(store.get(ID)!.dueAt).toBe(WAIT)
    expect(r.lines).toContain(`[requests] retro:01M8FPNNPQ9M0QZ7FPCKZR5TVY ${ID} wake held: step 1 waits until 2026-11-28T23:15:00.000Z`)
  })

  it("warn: logs the tagged line and still wakes", async () => {
    const r = await sweep("warn", DUE + HOUR)
    expect(r.lines).toContain(`[requests] retro:01M8FPNNPQ9M0QZ7FPCKZR5TVY ${ID} wake suppressed (warn mode): step 1 waits until 2026-11-28T23:15:00.000Z`)
    expect(r.wakes).toEqual([`job:${ID}`])
    expect(r.raised).toBe(true)
    expect(store.get(ID)!.dueAt).toBe(DUE)
  })

  it("after the wait: exactly one wake", async () => {
    await sweep("enforce", DUE + HOUR)
    const after = await sweep("enforce", WAIT + 60_000)
    expect(after.wakes).toEqual([`job:${ID}`])
    expect(after.raised).toBe(true)
    const again = await sweep("enforce", WAIT + 2 * 60_000)
    expect(again.wakes).toEqual([])
  })
})

describe("quiet request with an active step waiting", () => {
  beforeEach(() => { store.setLoop(ID, { dueAt: null }, DUE - 2 * HOUR) })

  it("enforce: not raised as quiet, its due set to the wait", async () => {
    const r = await sweep("enforce", DUE + 25 * HOUR)
    expect(r.raised).toBe(false)
    expect(store.get(ID)!.dueAt).toBe(WAIT)
  })

  it("warn: logged and raised as before", async () => {
    const r = await sweep("warn", DUE + 25 * HOUR)
    expect(r.raised).toBe(true)
    expect(r.lines.some((l) => l.includes("wake suppressed (warn mode): step 1"))).toBe(true)
  })
})

describe("promise with an active step waiting", () => {
  it("enforce: not pushed at its due time, pushed once the wait is over", async () => {
    db.prepare("UPDATE requests SET promise = 1 WHERE id = ?").run(ID)
    const opts = { settings: { ...settings("enforce"), promises: { leadMinutes: 0, graceMinutes: 0 } } } as any
    const lines: string[] = []
    const wakes: string[] = []
    const run = (now: number) => runRequestsSweep({
      store, now, log: (l) => { lines.push(l) }, ...opts,
      wakeJob: (id: string) => { wakes.push(id); return true },
      waitsUntil: (id: string, at: number) => latestWait(plans.steps(id), at),
    })
    await run(DUE + 60_000)
    expect(wakes).toEqual([])
    expect(store.get(ID)!.dueAt).toBe(WAIT)
    await run(WAIT + 60_000)
    expect(wakes).toEqual([ID])
  })
})

describe("replay of the 27–28 Nov signal", () => {
  it("enforce: no wake from 27 Nov 18:08Z to 28 Nov 23:15Z, one after", async () => {
    const wakes: number[] = []
    for (let now = DUE; now <= WAIT + 2 * HOUR; now += 15 * 60_000) {
      const r = await sweep("enforce", now)
      for (const _ of r.wakes) wakes.push(now)
    }
    expect(wakes.length).toBe(1)
    expect(wakes[0]).toBeGreaterThan(WAIT)
  })
})
