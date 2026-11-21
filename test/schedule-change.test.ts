import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { runScheduleTool, type ScheduleCaller } from "../src/crons/schedule-tool"
import { approveSchedule, rejectSchedule } from "../src/crons/schedule-ops"
import { cronChanges } from "../src/crons/change-ledger"
import { goalWallLines, jobGoalState, updateJobGoalState } from "../src/crons/goal-state"

// #863: the owner's own changes (ledger rows, the 31-day "more often"
// approval), retire, and the goal-check recommendation.

const NOW = new Date("2026-11-28T08:00:00.000Z")
let dir: string
let configPath: string
let db: Database.Database

const alpha: ScheduleCaller = { agentId: "alpha" }
const beta: ScheduleCaller = { agentId: "beta" }

function writeConfig(crons: Record<string, any>) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: {
      alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" },
      beta: { name: "Beta", workspace: "./agents/beta", tier: "claude-code" },
    },
    notifications: { destination: { channel: "telegram", chatId: "1000" } },
    crons,
  }, null, 2))
}
const crons = () => JSON.parse(readFileSync(configPath, "utf-8")).crons
const notifyOperator = vi.fn(async () => {})
const deps = () => ({ configPath, reload: false, now: () => NOW, notifyOperator, ledger: () => db })
const tool = (args: Record<string, unknown>, caller = alpha) => runScheduleTool(args, caller, deps())
const monthly = { enabled: true, schedule: "0 9 1 * *", timezone: "Africa/Tunis", agent: "alpha", prompt: "report", goal: "g" }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-change-"))
  configPath = join(dir, "agentx.json")
  db = new Database(":memory:")
  notifyOperator.mockClear()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("change", () => {
  it("monthly → weekly runs more often: a request, approved by the operator, with a ledger row then", async () => {
    writeConfig({ m: monthly })
    const out = await tool({ action: "change", id: "m", when: "0 9 * * 1", reason: "weekly numbers" })
    expect(out).toMatch(/needs operator approval/)
    expect(notifyOperator).toHaveBeenCalledOnce()
    expect(crons().m).toMatchObject({ schedule: "0 9 1 * *", approval: { action: "change", schedule: "0 9 * * 1", requestedBy: "alpha" } })
    expect(cronChanges(db, "m")).toEqual([])
    const ok = await approveSchedule("m", { configPath, reload: false, ledger: () => db })
    expect(ok.success).toBe(true)
    expect(crons().m).toMatchObject({ schedule: "0 9 * * 1", approvedSchedule: "0 9 * * 1" })
    expect(crons().m.approval).toBeUndefined()
    expect(cronChanges(db, "m")).toEqual([expect.objectContaining({ field: "time", old: "0 9 1 * *", new: "0 9 * * 1", by: "alpha", reason: "weekly numbers" })])
  })

  it("a rejected time change keeps the job's time", async () => {
    writeConfig({ m: monthly })
    await tool({ action: "change", id: "m", when: "0 9 * * 1", reason: "weekly" })
    expect((await rejectSchedule("m", { configPath, reload: false })).message).toMatch(/keeps 0 9 1 \* \*/)
    expect(crons().m).toMatchObject({ schedule: "0 9 1 * *" })
    expect(crons().m.approval).toBeUndefined()
  })

  it("less often goes through, with a ledger row, and the approved time stays the bar", async () => {
    writeConfig({ d: { ...monthly, schedule: "0 9 * * *" } })
    expect(await tool({ action: "change", id: "d", when: "0 9 * * 1", reason: "less noise" })).toMatch(/Changed "d": time/)
    expect(crons().d).toMatchObject({ schedule: "0 9 * * 1", approvedSchedule: "0 9 * * *" })
    expect(cronChanges(db, "d")).toEqual([expect.objectContaining({ field: "time", old: "0 9 * * *", new: "0 9 * * 1", by: "alpha", reason: "less noise" })])
    // Back to daily: not more often than the approved daily time.
    expect(await tool({ action: "change", id: "d", when: "0 9 * * *", reason: "back" })).toMatch(/Changed/)
  })

  it("brief, goal and value each write a row; a reason is required", async () => {
    writeConfig({ m: monthly })
    expect(await tool({ action: "change", id: "m", prompt: "new brief" })).toMatch(/needs `reason`/)
    const out = await tool({ action: "change", id: "m", prompt: "new brief", goal: "g2", value: { why: "money", metric: "invoices sent" }, reason: "sharper" })
    expect(out).toMatch(/brief; goal → g2; value/)
    expect(cronChanges(db, "m").map((r) => r.field).sort()).toEqual(["brief", "goal", "value"])
  })

  it("on goal check, goal and value are refused; the brief is not", async () => {
    writeConfig({ m: monthly })
    updateJobGoalState(dir, "m", (s) => { s.goalCheck = { goalId: "g", since: "2026-11-20T00:00:00Z", reason: "closed", askedAt: "2026-11-20T00:00:00Z", cardId: "c1" } })
    expect(await tool({ action: "change", id: "m", goal: "g2", reason: "x" })).toMatch(/on goal check since 2026-11-20; only the operator's answer on card c1/)
    expect(await tool({ action: "change", id: "m", value: { why: "a", metric: "b", number: "n1" }, reason: "x" })).toMatch(/on goal check/)
    expect(await tool({ action: "change", id: "m", prompt: "p2", reason: "x" })).toMatch(/Changed/)
  })

  it("the owner's change pays off changeOwed; a non-owner's does not", async () => {
    writeConfig({ m: { ...monthly, createdBy: "beta" } })
    updateJobGoalState(dir, "m", (s) => { s.changeOwed = { since: "2026-11-27T00:00:00Z", cardId: "c1" } })
    await tool({ action: "change", id: "m", prompt: "p2", reason: "x" }, beta)
    expect(jobGoalState(dir, "m").changeOwed).toBeDefined()
    await tool({ action: "change", id: "m", prompt: "p3", reason: "as asked" })
    expect(jobGoalState(dir, "m").changeOwed).toBeUndefined()
  })

  it("copying a held job's brief shows on the Wall", async () => {
    writeConfig({ m: monthly, held: { ...monthly, prompt: "the held brief" } })
    updateJobGoalState(dir, "held", (s) => { s.goalCheck = { goalId: "g", since: "2026-11-20T00:00:00Z", reason: "closed" } })
    await tool({ action: "change", id: "m", prompt: "the held brief", reason: "x" })
    expect(goalWallLines(jobGoalState(dir, "m"), "alpha")).toEqual(["brief copied from held job held"])
  })

  it("a non-owner cannot change the job; the owner can even if it did not create it", async () => {
    writeConfig({ m: { ...monthly, createdBy: "operator-x" } })
    expect(await tool({ action: "change", id: "m", prompt: "x", reason: "y" }, beta)).toMatch(/Not allowed/)
    expect(await tool({ action: "change", id: "m", prompt: "x", reason: "y" })).toMatch(/Changed/)
  })
})

describe("retire", () => {
  it("ends the job for good with a ledger row; resume is then refused", async () => {
    writeConfig({ m: monthly })
    expect(await tool({ action: "retire", id: "m" })).toMatch(/needs `reason`/)
    expect(await tool({ action: "retire", id: "m", reason: "goal met" })).toMatch(/Retired "m"/)
    expect(crons().m).toMatchObject({ enabled: false, endedAt: NOW.toISOString() })
    expect(cronChanges(db, "m")).toEqual([expect.objectContaining({ field: "retire", by: "alpha", reason: "goal met" })])
    expect(await tool({ action: "resume", id: "m" })).toMatch(/retired on 2026-11-28.*operator approval/)
  })

  it("withdraws a pending time-change request: no open approval is left (#2065)", async () => {
    writeConfig({ m: monthly })
    await tool({ action: "change", id: "m", when: "0 9 * * 1", reason: "weekly" })
    expect(crons().m.approval).toMatchObject({ action: "change" })
    const { listInbox } = await import("../src/approvals/inbox")
    const open = () => listInbox({ root: dir, configPath }, { kinds: ["schedule"] }).items.filter((i) => i.key === "schedule:m")
    expect(open()).toHaveLength(1)
    expect(await tool({ action: "retire", id: "m", reason: "goal met" })).toMatch(/Retired "m".*time-change request \(0 9 \* \* 1\) is withdrawn/)
    expect(crons().m.approval).toBeUndefined()
    expect(crons().m).toMatchObject({ enabled: false, schedule: "0 9 1 * *" })
    expect(open()).toEqual([])
  })
})

describe("recommend", () => {
  beforeEach(() => writeConfig({ m: { ...monthly, createdBy: "beta" } }))
  const ask = () => updateJobGoalState(dir, "m", (s) => { s.goalCheck = { goalId: "g", since: "2026-11-28T07:00:00Z", reason: "closed", askedAt: "2026-11-28T07:00:00Z" } })

  it("is accepted from the owner while askedAt is set and there is no card", async () => {
    ask()
    expect(await tool({ action: "recommend", id: "m", choice: "drop", why: "the goal is met" })).toMatch(/Recorded/)
    expect(jobGoalState(dir, "m").goalCheck!.recommend).toMatchObject({ choice: "drop", why: "the goal is met" })
  })

  it("is refused from anyone but the owner, even its creator", async () => {
    ask()
    expect(await tool({ action: "recommend", id: "m", choice: "keep", why: "x" }, beta)).toMatch(/only the job's owner/)
  })

  it("is refused when not asked, or once the card is raised", async () => {
    expect(await tool({ action: "recommend", id: "m", choice: "keep", why: "x" })).toMatch(/not waiting for a recommendation/)
    ask()
    updateJobGoalState(dir, "m", (s) => { s.goalCheck!.cardId = "c9" })
    expect(await tool({ action: "recommend", id: "m", choice: "keep", why: "x" })).toMatch(/already raised \(c9\)/)
  })

  it("checks choice and why", async () => {
    ask()
    expect(await tool({ action: "recommend", id: "m", choice: "maybe", why: "x" })).toMatch(/keep", "change" or "drop/)
    expect(await tool({ action: "recommend", id: "m", choice: "keep" })).toMatch(/needs `why`/)
    expect(await tool({ action: "recommend", id: "m", choice: "keep", why: "x".repeat(201) })).toMatch(/longer than 200/)
  })
})
