import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"
import { createCard, listCards } from "../src/approvals/cards"
import type { ApprovalSettings } from "../src/approvals/sweep"
import { approvalsConfigSchema } from "../src/daemon/config"
import { prepareRetro, raiseRetroCard, type RetroProposal } from "../src/retro/retro"
import { rankStruggledRuns, retroCardsToday, sweepRetros } from "../src/retro/sweep"
import { sweepWindowMs } from "../src/commands/retro"

// #743 P1: the nightly sweep ranks the day's struggled runs, keeps one per
// failure, and raises cards for the worst within the daily limit.

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-retro-sweep-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

const settings = (forwardTo?: string) => ({ ...approvalsConfigSchema.parse(undefined), ...(forwardTo ? { forwardTo } : {}) }) as ApprovalSettings
const since = () => Date.now() - 86_400_000

/** A run whose Bash step (step 1) failed with `error`. */
function failedRun(taskId: string, agentId: string, error: string, opts: { chatId?: string; channel?: string; runError?: string } = {}) {
  recordTraceStart(db, { agentId, channel: opts.channel ?? "telegram", chatId: opts.chatId ?? "ops", messagePreview: "do the thing" }, taskId)
  recordTraceStep(db, taskId, { name: "preflight", status: "ok", inputSummary: "do the thing" })
  recordTraceStep(db, taskId, { name: "tool_use", action: "Bash", status: "error", inputSummary: "run it", error })
  recordTraceEnd(db, taskId, { status: "error", error: opts.runError ?? error })
  return taskId
}

function okRun(taskId: string, agentId = "builder") {
  recordTraceStart(db, { agentId, channel: "telegram", chatId: "ops", messagePreview: "fine" }, taskId)
  recordTraceStep(db, taskId, { name: "preflight", status: "ok", inputSummary: "fine" })
  recordTraceEnd(db, taskId, { status: "ok" })
}

/** The reviewer: one script fix quoting step 1's error, whatever the run. */
function reviewer() {
  const calls: string[] = []
  const propose = async (input: string) => {
    const run = JSON.parse(input) as { run: { taskId: string }; steps: Array<{ seq: number; error?: string }> }
    calls.push(run.run.taskId)
    const quote = run.steps.find((s) => s.seq === 1)?.error ?? ""
    const p: RetroProposal = {
      title: `Fix for ${run.run.taskId}`,
      context: "",
      candidates: [{ label: "Script that checks first", kind: "mechanical", fix: "script", severity: "high", step: 1, evidence: quote, spec: "A script." }],
    }
    return JSON.stringify(p)
  }
  return { calls, propose }
}

describe("rankStruggledRuns", () => {
  it("ranks failed runs worst first, one per failure, and leaves good runs out", () => {
    okRun("T-ok")
    failedRun("T-plain", "builder", "connection refused on the health check")
    failedRun("T-plain-again", "builder", "connection refused on the health check", { chatId: "other" })
    failedRun("T-restart", "ops", "permission denied writing the settings", { runError: "killed by daemon-restart during shutdown" })

    const ranked = rankStruggledRuns(db, tmp, { since: since() })
    expect(ranked.map((r) => r.task.taskId)).not.toContain("T-ok")
    // The two refused health checks are the same failure: one is kept.
    expect(ranked).toHaveLength(2)
    expect(ranked[0].task.taskId).toBe("T-restart")
    expect(ranked[0].signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["failed", "restart-killed"]))
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })

  it("never reads a run the retro itself started", async () => {
    const taskId = failedRun("T-first", "builder", "connection refused on the health check")
    const r = await prepareRetro({ root: tmp, db, taskId, propose: reviewer().propose })
    if (!r.ok) throw new Error(r.error)
    const raised = raiseRetroCard(tmp, r.card, settings())
    if (!raised.ok) throw new Error(raised.error)
    // The agent building the picked fix runs in the card's own chat.
    failedRun("T-building-fix", "builder", "lint failed in the new script file", { channel: "approvals", chatId: raised.card.id })

    expect(rankStruggledRuns(db, tmp, { since: since() }).map((r) => r.task.taskId)).toEqual(["T-first"])
  })
})

describe("sweepRetros", () => {
  it("previews without asking the reviewer or raising a card", async () => {
    failedRun("T-a", "builder", "connection refused on the health check")
    failedRun("T-b", "ops", "permission denied writing the settings")
    const { calls, propose } = reviewer()

    const r = await sweepRetros({ root: tmp, db, propose, settings: settings(), since: since(), max: 1 })
    expect(calls).toEqual([])
    expect(listCards(tmp)).toEqual([])
    expect(r.outcomes).toEqual([expect.objectContaining({ result: "would-try" })])
  })

  it("with commit, raises cards for the worst runs up to the daily limit", async () => {
    failedRun("T-a", "builder", "connection refused on the health check")
    failedRun("T-b", "ops", "permission denied writing the settings")
    failedRun("T-c", "writer", "the upload returned an unknown answer")
    const { calls, propose } = reviewer()

    const r = await sweepRetros({ root: tmp, db, propose, settings: settings(), since: since(), max: 2, commit: true })
    expect(r.outcomes.filter((o) => o.result === "raised")).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(retroCardsToday(tmp)).toBe(2)

    // The limit holds across sweeps: a second run the same day raises nothing.
    const again = await sweepRetros({ root: tmp, db, propose, settings: settings(), since: since(), max: 2, commit: true })
    expect(again.room).toBe(0)
    expect(again.outcomes).toEqual([])
  })

  it("counts cards raised by hand against the limit, but not the agent's own cards", async () => {
    const taskId = failedRun("T-hand", "builder", "connection refused on the health check")
    failedRun("T-b", "ops", "permission denied writing the settings")
    failedRun("T-c", "writer", "the upload returned an unknown answer")
    const r = await prepareRetro({ root: tmp, db, taskId, propose: reviewer().propose })
    if (!r.ok) throw new Error(r.error)
    expect(raiseRetroCard(tmp, r.card, settings()).ok).toBe(true)
    expect(createCard(tmp, { title: "An agent's own question", ask: "Go ahead?", recommend: "Yes: it is safe", if_silent: "discard", raised_by: "ops" }, { settings: settings() }).ok).toBe(true)

    const swept = await sweepRetros({ root: tmp, db, propose: reviewer().propose, settings: settings(), since: since(), max: 2, commit: true })
    expect(swept.room).toBe(1)
    expect(swept.outcomes.filter((o) => o.result === "raised")).toHaveLength(1)
  })

  it("skips a failure that already has an open card", async () => {
    const taskId = failedRun("T-open", "builder", "connection refused on the health check")
    const r = await prepareRetro({ root: tmp, db, taskId, propose: reviewer().propose })
    if (!r.ok) throw new Error(r.error)
    const raised = raiseRetroCard(tmp, r.card, settings())
    if (!raised.ok) throw new Error(raised.error)

    const swept = await sweepRetros({ root: tmp, db, propose: reviewer().propose, settings: settings(), since: since(), max: 5, commit: true })
    expect(swept.outcomes).toEqual([
      { taskId: "T-open", agentId: "builder", result: "skipped", why: `card:${raised.card.id} already asks about this failure` },
    ])
  })

  it("lets the next run try when the reviewer's answer can't be used", async () => {
    failedRun("T-a", "builder", "permission denied writing the settings", { runError: "killed by daemon-restart during shutdown" })
    failedRun("T-b", "ops", "connection refused on the health check")
    const good = reviewer()
    const propose = async (input: string) => (JSON.parse(input).run.taskId === "T-a" ? "not json" : good.propose(input))

    const swept = await sweepRetros({ root: tmp, db, propose, settings: settings(), since: since(), max: 1, commit: true })
    expect(swept.outcomes.map((o) => [o.taskId, o.result])).toEqual([["T-a", "skipped"], ["T-b", "raised"]])
  })

  it("refuses to raise cards when they would be forwarded to another machine", async () => {
    failedRun("T-a", "builder", "connection refused on the health check")
    const { calls, propose } = reviewer()

    const swept = await sweepRetros({ root: tmp, db, propose, settings: settings("other-node"), since: since(), commit: true })
    expect(swept.error).toMatch(/forwardTo is set \(other-node\)/)
    expect(calls).toEqual([])
    expect(listCards(tmp)).toEqual([])
  })
})

describe("sweepWindowMs", () => {
  it("reads hours and days only", () => {
    expect(sweepWindowMs("24h")).toBe(86_400_000)
    expect(sweepWindowMs("2d")).toBe(2 * 86_400_000)
    expect(sweepWindowMs("0h")).toBeNull()
    expect(sweepWindowMs("30m")).toBeNull()
    expect(sweepWindowMs("soon")).toBeNull()
  })
})
