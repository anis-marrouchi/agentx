import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { createCard, decideCard, expireCards, listCards, readCard } from "../src/approvals/cards"
import { goalCheckAtFire, goalCheckTick, type GoalCheckDeps, type GoalRecordView } from "../src/crons/goal-check"
import { applyGoalAnswer } from "../src/crons/goal-answer"
import { jobGoalState, goalWallLines } from "../src/crons/goal-state"
import { recordCronChange } from "../src/crons/change-ledger"
import { retiredRefusalAt } from "../src/crons/retired"
import { MovementCache } from "../src/crons/goal-movement"
import type { MovementRead } from "../src/requests/checkers/issue-movement"

// #863 v2 + v2.1 + v2.2: the schedule goal check. The owner is woken once,
// the daemon raises one keep / change / drop card, and the operator's
// answer is applied on decision or, failing that, at the next fire.

const DAY = 86_400_000
const HOUR = 3_600_000
const T0 = Date.parse("2026-11-01T08:00:00Z")
const JOB = { id: "j", agent: "helper", goal: "g" }

let dir: string
let configPath: string
let now: number
let goal: GoalRecordView | null
let read: MovementRead
let wakes: Array<{ agent: string; text: string; done: () => void }>
let operatorNode: string | null
let db: Database.Database
let logs: string[]

function writeConfig(job: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: { helper: { name: "Helper", workspace: "./agents/helper", tier: "claude-code" } },
    crons: { j: { schedule: "0 9 * * *", agent: "helper", prompt: "work", goal: "g", enabled: true, ...job } },
  }, null, 2) + "\n")
}

function deps(over: Partial<GoalCheckDeps> = {}): GoalCheckDeps {
  return {
    root: dir, configPath, runsDir: join(dir, ".agentx", "cron", "runs"), now: () => now, log: (m) => logs.push(m),
    goal: () => goal,
    movement: async () => read,
    operatorNode: () => operatorNode,
    wake: (agent, text) => new Promise<void>((done) => wakes.push({ agent, text, done })),
    ledger: () => db,
    ...over,
  }
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }
const state = () => jobGoalState(dir, "j")
const cronGoalCards = () => listCards(dir).filter((c) => c.origin?.kind === "cron-goal")
const answerDeps = () => ({ root: dir, configPath, now: () => now, log: (m: string) => logs.push(m), ledger: () => db })

/** Put the job on goal check (goal closed), the owner recommends, its turn ends. */
async function heldWithCard(choice?: "keep" | "change" | "drop") {
  goal = { state: "done", check: null, createdAt: T0 - 90 * DAY }
  expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ hold: expect.stringMatching(/on goal check/) })
  if (choice) {
    const { updateJobGoalState } = await import("../src/crons/goal-state")
    updateJobGoalState(dir, "j", (s) => { s.goalCheck!.recommend = { choice, why: "the goal is met", at: new Date(now).toISOString() } })
  }
  wakes[0].done()
  await flush()
  return state().goalCheck!.cardId!
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-goal-check-"))
  configPath = join(dir, "agentx.json")
  writeConfig()
  now = T0
  goal = { state: "active", check: { kind: "issue", provider: "gitlab", ref: "g/p#1" }, createdAt: T0 - 90 * DAY }
  read = { ok: true, state: "open", times: [T0 - DAY] }
  wakes = []
  operatorNode = null
  db = new Database(":memory:")
  logs = []
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("a closed goal holds the job and wakes the owner once", () => {
  it("raises one card when the owner's turn ends, with its recommendation", async () => {
    const cardId = await heldWithCard("drop")
    expect(wakes).toHaveLength(1)
    expect(wakes[0].agent).toBe("helper")
    expect(wakes[0].text).toMatch(/action:"recommend", id:"j"/)
    const card = readCard(dir, cardId)!
    expect(card).toMatchObject({ raised_by: "helper", choices: ["Keep", "Change", "Drop"], recommend: "Drop: the goal is met", origin: { kind: "cron-goal", jobId: "j", goalId: "g" } })
    expect(card.popup_only).toBeFalsy()
    // Later fires: held, no second wake, no second card.
    for (let i = 1; i <= 3; i++) {
      now = T0 + i * DAY
      expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ hold: expect.stringMatching(/waiting on the operator/) })
    }
    expect(wakes).toHaveLength(1)
    expect(cronGoalCards()).toHaveLength(1)
  })

  it("the owner run never starts: card at 2 h on the minute tick, owner woken once only", async () => {
    goal = { state: "done", check: null, createdAt: T0 }
    await goalCheckAtFire(JOB, deps())
    now = T0 + 2 * HOUR - 60_000
    goalCheckTick([JOB], deps())
    expect(cronGoalCards()).toHaveLength(0)
    now = T0 + 2 * HOUR
    goalCheckTick([JOB], deps())
    const cards = cronGoalCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].recommend).toBe("No recommendation from helper.")
    expect(cards[0].ask).toMatch(/Pick Keep, Change or Drop\. No keeps the job\./)
    expect(state().goalCheck!.cardId).toBe(cards[0].id)
    goalCheckTick([JOB], deps())
    now += DAY
    await goalCheckAtFire(JOB, deps())
    expect(wakes).toHaveLength(1)
    expect(cronGoalCards()).toHaveLength(1)
  })

  it("a refused card: one Wall line, retried at the next fire, no second wake", async () => {
    for (let i = 0; i < 25; i++) {
      expect(createCard(dir, { title: `Other ${i}`, ask: `Do thing ${i}?`, recommend: "Yes", if_silent: "keep", expires: "7d", raised_by: "helper" }, { now }).ok).toBe(true)
    }
    goal = { state: "done", check: null, createdAt: T0 }
    await goalCheckAtFire(JOB, deps())
    wakes[0].done()
    await flush()
    expect(state().goalCheck!.refused?.error).toMatch(/already has 25 cards waiting/)
    const wall = goalWallLines(state(), "helper")
    expect(wall.filter((l) => /goal card for j refused/.test(l))).toHaveLength(1)
    // The tick does not retry a refusal; the next fire does.
    now = T0 + 3 * HOUR
    goalCheckTick([JOB], deps())
    expect(cronGoalCards()).toHaveLength(0)
    const first = listCards(dir, "pending")[0]
    decideCard(dir, first.id, "no", { now })
    now = T0 + DAY
    await goalCheckAtFire(JOB, deps())
    expect(cronGoalCards()).toHaveLength(1)
    expect(state().goalCheck!.refused).toBeUndefined()
    expect(goalWallLines(state(), "helper").some((l) => /refused/.test(l))).toBe(false)
    expect(wakes).toHaveLength(1)
  })

  it("a pending card with the same origin is taken over, never doubled", async () => {
    goal = { state: "done", check: null, createdAt: T0 }
    const twin = createCard(dir, { title: "Schedule j", ask: "Keep, change or drop?", recommend: "Keep: x", if_silent: "keep", expires: "30d", raised_by: "helper", choices: ["Keep", "Change", "Drop"] }, { now, origin: { kind: "cron-goal", jobId: "j", goalId: "g" } })
    await goalCheckAtFire(JOB, deps())
    wakes[0].done()
    await flush()
    expect(state().goalCheck!.cardId).toBe((twin as any).card.id)
    expect(cronGoalCards()).toHaveLength(1)
  })

  it("a restart with goalCheck set: no new card, no run, no wake", async () => {
    const cardId = await heldWithCard()
    now = T0 + DAY
    const fresh = deps()
    expect(await goalCheckAtFire(JOB, fresh)).toMatchObject({ hold: expect.stringContaining(cardId) })
    expect(wakes).toHaveLength(1)
    expect(cronGoalCards()).toHaveLength(1)
  })

  it("a card past its expiry stays pending, and the next 3 fires raise no card and set no goalKeptAt", async () => {
    const cardId = await heldWithCard("keep")
    now = T0 + 40 * DAY
    expect(expireCards(dir, now)).toEqual([])
    for (let i = 0; i < 3; i++) {
      now += DAY
      await goalCheckAtFire(JOB, deps())
    }
    expect(readCard(dir, cardId)!.status).toBe("pending")
    expect(cronGoalCards()).toHaveLength(1)
    expect(state().goalKeptAt).toBeUndefined()
  })
})

describe("the operator's answer", () => {
  it("keep on a closed goal: the job runs and no new card for 30 days", async () => {
    const cardId = await heldWithCard("keep")
    const decided = decideCard(dir, cardId, "yes", { now })
    expect(decided).toMatchObject({ ok: true, card: { choice: "Keep" } })
    expect(await applyGoalAnswer((decided as any).card, answerDeps())).toBe("applied")
    expect(state()).toMatchObject({ goalKeptAt: expect.any(String) })
    expect(state().goalCheck).toBeUndefined()
    // Idempotent.
    expect(await applyGoalAnswer((decided as any).card, answerDeps())).toBe("skip")
    for (const d of [1, 10, 29]) {
      now = T0 + d * DAY
      expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: true })
    }
    expect(cronGoalCards()).toHaveLength(1)
    now = T0 + 31 * DAY
    expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ hold: expect.stringMatching(/on goal check/) })
    expect(wakes).toHaveLength(2)
  })

  it("a plain no counts as keep", async () => {
    const cardId = await heldWithCard("drop")
    const decided = decideCard(dir, cardId, "no", { now })
    await applyGoalAnswer((decided as any).card, answerDeps())
    expect(state().goalKeptAt).toBeDefined()
    expect(JSON.parse(readFileSync(configPath, "utf-8")).crons.j.endedAt).toBeUndefined()
  })

  it("decided card whose write never happened: applied at the next fire", async () => {
    const cardId = await heldWithCard("keep")
    decideCard(dir, cardId, "yes", { now })
    // The notice loop's write failed: nothing applied yet.
    expect(state().goalCheck).toBeDefined()
    now = T0 + DAY
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: true })
    expect(state().goalKeptAt).toBeDefined()
  })

  it("a drop whose agentx.json write fails: Wall line, then applied at the next fire", async () => {
    const cardId = await heldWithCard("drop")
    const decided = decideCard(dir, cardId, "yes", { choice: "Drop", now })
    const missing = join(dir, "nowhere", "agentx.json")
    expect(await applyGoalAnswer((decided as any).card, { ...answerDeps(), configPath: missing })).toBe("failed")
    expect(goalWallLines(state(), "helper").some((l) => /not yet written to agentx.json/.test(l))).toBe(true)
    now = T0 + DAY
    expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ retired: true })
    const job = JSON.parse(readFileSync(configPath, "utf-8")).crons.j
    expect(job).toMatchObject({ enabled: false, endedAt: expect.any(String) })
    expect(goalWallLines(state(), "helper").some((l) => /not yet written/.test(l))).toBe(false)
  })

  it("drop: the daemon retires the job, writes a ledger row, and it cannot be switched back on", async () => {
    const cardId = await heldWithCard("drop")
    const decided = decideCard(dir, cardId, "yes", { now })
    expect((decided as any).card).toMatchObject({ choice: "Drop", choice_suggested: true })
    expect(await applyGoalAnswer((decided as any).card, answerDeps())).toBe("applied")
    const job = JSON.parse(readFileSync(configPath, "utf-8")).crons.j
    expect(job).toMatchObject({ enabled: false, endedAt: expect.any(String) })
    const rows = db.prepare("SELECT field, by FROM cron_changes WHERE job = 'j'").all()
    expect(rows).toEqual([{ field: "retire", by: "operator" }])
    expect(retiredRefusalAt(dir, "j", job)).toMatch(/retired on/)
    expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ retired: true })
  })

  it("change: no run until the owner's change row (a pause row does not count); 7 days late: one Wall line, one wake", async () => {
    const cardId = await heldWithCard("change")
    const decided = decideCard(dir, cardId, "yes", { now, note: "run it weekly" })
    await applyGoalAnswer((decided as any).card, answerDeps())
    expect(state().changeOwed).toMatchObject({ cardId, note: "run it weekly" })
    now = T0 + DAY
    expect(await goalCheckAtFire(JOB, deps())).toMatchObject({ hold: "change owed by helper since 2026-11-01" })
    recordCronChange(db, { job: "j", field: "pause", old: "on", new: "paused", by: "helper", reason: "x", at: now })
    expect((await goalCheckAtFire(JOB, deps())).hold).toMatch(/change owed/)
    // 7 days on: one escalation.
    now = T0 + 8 * DAY
    await goalCheckAtFire(JOB, deps())
    goalCheckTick([JOB], deps())
    await goalCheckAtFire(JOB, deps())
    expect(wakes).toHaveLength(2)
    expect(wakes[1].text).toMatch(/still not made after 7 days/)
    expect(goalWallLines(state(), "helper").filter((l) => /7\+ days/.test(l))).toHaveLength(1)
    recordCronChange(db, { job: "j", field: "time", old: "0 9 * * *", new: "0 9 * * 1", by: "helper", reason: "weekly", at: now })
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: true })
    expect(state().changeOwed).toBeUndefined()
  })
})

describe("movement on the goal's issue", () => {
  it("no movement for 30 days puts the job on goal check", async () => {
    read = { ok: true, state: "open", times: [T0 - 40 * DAY] }
    expect((await goalCheckAtFire(JOB, deps())).hold).toMatch(/on goal check/)
    expect(state().goalCheck).toMatchObject({ reason: "no-movement", days: 40, askedAt: new Date(T0).toISOString() })
  })

  it("another agent's note counts; a note inside the job's own run window does not", async () => {
    const runs = join(dir, ".agentx", "cron", "runs", "j")
    mkdirSync(runs, { recursive: true })
    const start = T0 - 5 * DAY
    writeFileSync(join(runs, `${new Date(start).toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt: new Date(start).toISOString(), completedAt: new Date(start + 10 * 60_000).toISOString() }))
    read = { ok: true, state: "open", times: [T0 - 40 * DAY, start + 11 * 60_000] }
    expect((await goalCheckAtFire(JOB, deps())).hold).toMatch(/on goal check/)
    rmSync(join(dir, ".agentx", "state"), { recursive: true, force: true })
    read = { ok: true, state: "open", times: [T0 - 40 * DAY, start + 13 * 60_000] }
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: false })
  })

  it("a failed forge read never counts as no movement: the job runs, one Wall line", async () => {
    read = { ok: false, error: "HTTP 502" }
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: false })
    await goalCheckAtFire(JOB, deps())
    expect(goalWallLines(state(), "helper")).toEqual(["goal check could not read g: HTTP 502"])
    read = { ok: true, state: "open", times: [T0 - DAY] }
    await goalCheckAtFire(JOB, deps())
    expect(goalWallLines(state(), "helper")).toEqual([])
  })

  it("a goal record with no issue check: no movement check, one Wall line", async () => {
    goal = { state: "active", check: { kind: "url" }, createdAt: T0 - 90 * DAY }
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: false })
    await goalCheckAtFire(JOB, deps())
    expect(goalWallLines(state(), "helper")).toEqual(["goal g has no issue to watch"])
  })

  it("a new goal with no notes yet is not still for years: the clock starts at the record", async () => {
    goal = { state: "active", check: { kind: "issue", provider: "gitlab", ref: "g/p#1" }, createdAt: T0 - 3 * DAY }
    read = { ok: true, state: "open", times: [] }
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: false })
  })

  it("only on the operator's node; elsewhere one Wall line and the job runs", async () => {
    operatorNode = "mac"
    goal = { state: "done", check: null, createdAt: T0 }
    expect(await goalCheckAtFire(JOB, deps())).toEqual({ hold: null, kept: false })
    expect(goalWallLines(state(), "helper")).toEqual(["goal check runs on mac only"])
    expect(wakes).toHaveLength(0)
  })

  describe("cached reads (#2065)", () => {
    const counted = () => {
      const calls: string[] = []
      return { calls, movement: async (p: string, ref: string) => { calls.push(`${p}:${ref}`); return read } }
    }

    it("two runs inside the TTL make one tracker call; after it, a fresh one", async () => {
      const cache = new MovementCache(HOUR)
      const m = counted()
      expect(await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))).toEqual({ hold: null, kept: false })
      now = T0 + HOUR - 60_000
      expect(await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))).toEqual({ hold: null, kept: false })
      expect(m.calls).toEqual(["gitlab:g/p#1"])
      now = T0 + HOUR
      await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))
      expect(m.calls).toHaveLength(2)
    })

    it("jobs on the same issue share one read", async () => {
      const cache = new MovementCache(HOUR)
      const m = counted()
      await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))
      await goalCheckAtFire({ ...JOB, id: "k" }, deps({ movement: m.movement, movementCache: cache }))
      expect(m.calls).toHaveLength(1)
    })

    it("a hold is never decided on a cached read: the tracker is read again first", async () => {
      const cache = new MovementCache(60 * DAY)
      read = { ok: true, state: "open", times: [T0 - 29 * DAY] }
      const m = counted()
      expect(await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))).toEqual({ hold: null, kept: false })
      // Two days on, the cached read would say 31 days still; a fresh read shows a new note.
      now = T0 + 2 * DAY
      read = { ok: true, state: "open", times: [T0 + DAY] }
      expect(await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))).toEqual({ hold: null, kept: false })
      expect(m.calls).toHaveLength(2)
      expect(state().goalCheck).toBeUndefined()
    })

    it("a failed read is not cached", async () => {
      const cache = new MovementCache(HOUR)
      read = { ok: false, error: "HTTP 502" }
      const m = counted()
      await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))
      await goalCheckAtFire(JOB, deps({ movement: m.movement, movementCache: cache }))
      expect(m.calls).toHaveLength(2)
    })
  })

  it("a job with no goal is never checked", async () => {
    expect(await goalCheckAtFire({ id: "j", agent: "helper" }, deps())).toEqual({ hold: null, kept: false })
    expect(state()).toEqual({})
  })
})

describe("in the scheduler", () => {
  async function scheduler() {
    const { CronScheduler } = await import("../src/crons/scheduler")
    const execute = vi.fn(async () => ({ content: "done", duration: 1 }))
    const s: any = new CronScheduler({
      crons: { j: { enabled: true, schedule: "0 9 * * *", timezone: "UTC", agent: "helper", prompt: "work", goal: "g", timeout: 60, onError: ["log"] } },
      agents: {}, notifications: {},
    } as any, { execute } as any, undefined, () => {})
    s.running = true
    s.armTimer = vi.fn()
    s.saveLastRuns = vi.fn()
    s.logRun = vi.fn()
    s.setGoalSource(() => (goal ? { state: goal.state, brief: `[Goal] g is ${goal.state}` } : null))
    s.setGoalCheck(deps())
    return { s, execute }
  }

  it("a held job does not run its brief, and the Wall shows why", async () => {
    goal = { state: "done", check: null, createdAt: T0 }
    const { s, execute } = await scheduler()
    await s.executeJob("j")
    expect(execute).not.toHaveBeenCalled()
    expect(wakes).toHaveLength(1)
    expect(s.list()[0].goalLines).toEqual([expect.stringMatching(/^on goal check since 2026-11-01: goal g closed/)])
    await s.stop()
  })

  it("kept by the operator: runs even though its goal is closed", async () => {
    goal = { state: "done", check: null, createdAt: T0 }
    const { updateJobGoalState } = await import("../src/crons/goal-state")
    updateJobGoalState(dir, "j", (st) => { st.goalKeptAt = new Date(T0 - DAY).toISOString() })
    const { s, execute } = await scheduler()
    await s.executeJob("j")
    expect(execute).toHaveBeenCalledOnce()
    await s.stop()
  })

  it("a drop answer switches the in-memory job off", async () => {
    const { updateJobGoalState } = await import("../src/crons/goal-state")
    updateJobGoalState(dir, "j", (st) => { st.goalCheck = { goalId: "g", since: "2026-10-01T00:00:00Z", reason: "drop-answered", droppedAt: "2026-10-02T00:00:00Z" } })
    const { s, execute } = await scheduler()
    await s.executeJob("j")
    expect(execute).not.toHaveBeenCalled()
    expect(s.jobs.get("j").enabled).toBe(false)
    await s.stop()
  })
})

// Review n158092 item 3: a cron-goal card never expires, so retiring or
// deleting the job must withdraw it, or it asks the operator forever.
describe("retire or delete withdraws the open goal card", () => {
  const pendingGoalCards = () => cronGoalCards().filter((c) => c.status === "pending")

  it("the owner's retire: card withdrawn (resolved by the daemon, no verdict), goal check cleared", async () => {
    const cardId = await heldWithCard("drop")
    const { retireAction } = await import("../src/crons/schedule-change")
    const job = JSON.parse(readFileSync(configPath, "utf-8")).crons.j
    const out = await retireAction({ reason: "goal met" }, {
      id: "j", job, caller: { agentId: "helper" }, root: dir, configPath, reload: false, now: new Date(now), ledger: () => db,
      notifyApproval: async () => "",
    })
    expect(out).toMatch(/^Retired "j"/)
    expect(readCard(dir, cardId)).toMatchObject({ status: "resolved", decided_by: "daemon", resolution: expect.stringMatching(/Withdrawn: the schedule j was retired/), agent_notified_at: expect.any(String) })
    expect(readCard(dir, cardId)!.verdict).toBeUndefined()
    expect(pendingGoalCards()).toHaveLength(0)
    expect(state().goalCheck).toBeUndefined()
  })

  it("ended by its until: card withdrawn", async () => {
    const cardId = await heldWithCard()
    const { endByUntil } = await import("../src/crons/job-end")
    expect(await endByUntil("j", new Date(now).toISOString(), { root: dir, configPath, log: (m) => logs.push(m), ledger: () => db })).toBe(true)
    expect(readCard(dir, cardId)!.status).toBe("resolved")
  })

  it("an approved delete request: card withdrawn", async () => {
    const cardId = await heldWithCard()
    writeConfig({ approval: { action: "delete", requestedBy: "helper", requestedAt: new Date(now).toISOString() } })
    const { approveSchedule } = await import("../src/crons/schedule-ops")
    const r = await approveSchedule("j", { configPath, reload: false })
    expect(r.success).toBe(true)
    expect(readCard(dir, cardId)).toMatchObject({ status: "resolved", resolution: expect.stringMatching(/was deleted/) })
  })

  it("retired while the owner's recommendation turn runs: no card when the turn ends", async () => {
    goal = { state: "done", check: null, createdAt: T0 - 90 * DAY }
    await goalCheckAtFire(JOB, deps())
    expect(wakes).toHaveLength(1)
    const { endJobInConfig } = await import("../src/crons/retired")
    expect(await endJobInConfig("j", new Date(now).toISOString(), { configPath, root: dir })).toMatchObject({ ok: true, changed: true })
    wakes[0].done()
    await flush()
    expect(cronGoalCards()).toHaveLength(0)
  })

  it("the minute tick withdraws a card whose job is gone or retired, and leaves a live job's card", async () => {
    const cardId = await heldWithCard()
    goalCheckTick([{ ...JOB }], deps())
    expect(readCard(dir, cardId)!.status).toBe("pending")
    goalCheckTick([{ ...JOB, ended: true }], deps())
    expect(readCard(dir, cardId)).toMatchObject({ status: "resolved", resolution: expect.stringMatching(/was retired/) })
  })

  it("the minute tick withdraws the card of a job removed by hand", async () => {
    const cardId = await heldWithCard()
    goalCheckTick([], deps())
    expect(readCard(dir, cardId)).toMatchObject({ status: "resolved", resolution: expect.stringMatching(/no longer exists/) })
    // A retired job raises no new card at the 2 h mark either.
    now += 3 * HOUR
    goalCheckTick([{ ...JOB, ended: true }], deps())
    expect(pendingGoalCards()).toHaveLength(0)
  })

  it("a drop answer keeps its drop state (the retired guard reads it)", async () => {
    const cardId = await heldWithCard("drop")
    const decided = decideCard(dir, cardId, "yes", { now })
    expect(await applyGoalAnswer((decided as any).card, answerDeps())).toBe("applied")
    expect(state().goalCheck).toMatchObject({ reason: "drop-answered" })
    expect(readCard(dir, cardId)!.status).toBe("decided")
  })
})
