import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { setCronEnabled } from "../src/crons/set-enabled"
import { setScheduleEnabled } from "../src/crons/schedule-ops"
import { runScheduleTool } from "../src/crons/schedule-tool"
import { retiredRefusal } from "../src/crons/retired"
import { updateJobGoalState } from "../src/crons/goal-state"
import { createCard, decideCard, expireCards, readCard } from "../src/approvals/cards"

// #863 v2.2 §4: one guard for every way a job is switched back on, and
// §1: a schedule's goal card never expires.

let dir: string
let configPath: string

const base = {
  node: { id: "t", name: "T", bind: "127.0.0.1:0" },
  agents: { helper: { name: "Helper", workspace: "./agents/helper", tier: "claude-code" } },
}

function write(crons: Record<string, unknown>) {
  writeFileSync(configPath, JSON.stringify({ ...base, crons }, null, 2) + "\n")
}
const read = () => JSON.parse(readFileSync(configPath, "utf-8"))
const caller = { agentId: "helper" }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-retired-"))
  configPath = join(dir, "agentx.json")
})

describe("retiredRefusal", () => {
  it("refuses a job with endedAt or a drop answer, and nothing else", () => {
    expect(retiredRefusal({ endedAt: "2026-11-20T10:00:00Z" }, "j")).toMatch(/retired on 2026-11-20/)
    expect(retiredRefusal({ goalCheck: { goalId: "g", since: "x", reason: "drop-answered", droppedAt: "2026-11-19T00:00:00Z" } }, "j")).toMatch(/answered drop/)
    expect(retiredRefusal({ goalCheck: { goalId: "g", since: "x", reason: "closed" } }, "j")).toBeNull()
    expect(retiredRefusal({}, "j")).toBeNull()
  })
})

describe("every enable path refuses a retired job", () => {
  const ended = { schedule: "0 9 * * *", agent: "helper", prompt: "hi", enabled: false, endedAt: "2026-11-20T10:00:00Z" }
  const paused = { schedule: "0 9 * * *", agent: "helper", prompt: "hi", enabled: false }

  it("dashboard POST /crons/:id/enabled answers 409", async () => {
    write({ ended, paused })
    expect(await setCronEnabled("ended", true, { configPath })).toMatchObject({ ok: false, status: 409 })
    expect(read().crons.ended.enabled).toBe(false)
    expect(await setCronEnabled("paused", true, { configPath })).toMatchObject({ ok: true, changed: true })
  })

  it("a drop answer in the state file is refused too", async () => {
    write({ paused })
    updateJobGoalState(dir, "paused", (s) => { s.goalCheck = { goalId: "g", since: "2026-11-01T00:00:00Z", reason: "drop-answered", droppedAt: "2026-11-02T00:00:00Z" } })
    expect(await setCronEnabled("paused", true, { configPath })).toMatchObject({ ok: false, status: 409 })
  })

  it("agentx schedule enable refuses", async () => {
    write({ ended, paused })
    expect((await setScheduleEnabled("ended", true, { configPath, reload: false })).success).toBe(false)
    expect((await setScheduleEnabled("paused", true, { configPath, reload: false })).success).toBe(true)
  })

  it("the tool's resume refuses; a paused job still resumes", async () => {
    write({ ended, paused })
    expect(await runScheduleTool({ action: "resume", id: "ended" }, caller, { configPath, reload: false })).toMatch(/retired on 2026-11-20.*operator approval/)
    expect(read().crons.ended.enabled).toBe(false)
    expect(await runScheduleTool({ action: "resume", id: "paused" }, caller, { configPath, reload: false })).toMatch(/resumed/)
  })
})

describe("a cron-goal card never expires", () => {
  it("stays pending past expires and can still be decided", () => {
    const now = Date.parse("2026-11-01T00:00:00Z")
    const made = createCard(dir, {
      title: "Schedule j: goal g closed", ask: "Keep, change or drop the job?", recommend: "Drop: the goal is done",
      if_silent: "keep", expires: "30d", raised_by: "helper", choices: ["Keep", "Change", "Drop"],
    }, { now, origin: { kind: "cron-goal", jobId: "j", goalId: "g" } })
    expect(made.ok).toBe(true)
    const id = (made as any).card.id
    const later = now + 60 * 86_400_000
    expect(expireCards(dir, later)).toEqual([])
    expect(readCard(dir, id)?.status).toBe("pending")
    const decided = decideCard(dir, id, "yes", { now: later })
    expect(decided).toMatchObject({ ok: true, card: { status: "decided", choice: "Drop", choice_suggested: true } })
  })

  it("other cards still expire", () => {
    const now = Date.parse("2026-11-01T00:00:00Z")
    createCard(dir, { title: "Plain", ask: "Do it?", recommend: "Yes", if_silent: "keep", expires: "1d", raised_by: "helper" }, { now })
    expect(expireCards(dir, now + 2 * 86_400_000)).toHaveLength(1)
  })
})
