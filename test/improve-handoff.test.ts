import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"
import { createCard, listCards } from "../src/approvals/cards"
import type { ApprovalSettings } from "../src/approvals/sweep"
import { approvalsConfigSchema, improveConfigSchema } from "../src/daemon/config"
import type { RetroProposal } from "../src/retro/retro"
import { recordSignal } from "../src/improve/signals"
import { rankSignals } from "../src/improve/rank"
import { spentToday } from "../src/improve/budget"
import { handWorstToRetro, problemSignature, representativeRun } from "../src/improve/handoff"
import { improvePass } from "../src/improve/nightly"

// #1783 stage 3: the worst recurring problem goes to the retro, one card,
// within improve.maxCardsPerDay, the retro's own limit and improve.dailyUsd.

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-handoff-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

const approvals = approvalsConfigSchema.parse(undefined) as ApprovalSettings
const ON = { ...improveConfigSchema.parse(undefined), enabled: true, dailyUsd: 10 }

/** A finished run of `agentId` whose step 1 says `text`. */
function run(taskId: string, agentId: string, text: string, opts: { channel?: string; chatId?: string } = {}) {
  recordTraceStart(db, { agentId, channel: opts.channel ?? "telegram", chatId: opts.chatId ?? "ops", messagePreview: "close the request" }, taskId)
  recordTraceStep(db, taskId, { name: "preflight", status: "ok", inputSummary: "close the request" })
  recordTraceStep(db, taskId, { name: "tool_use", action: "Bash", status: "ok", inputSummary: "close it", outputSummary: text })
  recordTraceEnd(db, taskId, { status: "ok" })
}

/** Three stalls of builder, each on its own run, the last one newest. */
function problem() {
  for (let i = 0; i < 3; i++) {
    run(`T${i}`, "builder", `closed as done without the invoice number ${i}`)
    recordSignal(db, { kind: "request_stalled", agentId: "builder", ref: `T${i}`, detail: `went quiet after ${10 + i} minutes` }, Date.now() - 1000 + i)
  }
}

function reviewer(usd: number | null = 0.5) {
  const inputs: any[] = []
  const propose = async (input: string) => {
    const parsed = JSON.parse(input)
    inputs.push(parsed)
    const p: RetroProposal = {
      title: "Builder closes without the invoice",
      context: "it closed early",
      candidates: [{ label: "Check the invoice before a close", kind: "mechanical", fix: "hook", severity: "high", step: 1, evidence: "closed as done without the invoice", spec: "A hook." }],
    }
    return { text: JSON.stringify(p), usd }
  }
  return { inputs, propose }
}

async function ranked() {
  return (await rankSignals(db, { since: 0 })).groups
}

describe("representativeRun", () => {
  it("finds the run of a request and of a hand-off, the group's agent first", () => {
    run("R1", "builder", "x")
    // The request store makes this table; its shape is all the lookup needs.
    db.exec("CREATE TABLE IF NOT EXISTS request_links (request_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, ref))")
    db.prepare("INSERT INTO request_links (request_id, kind, ref, at) VALUES (?, 'run', ?, ?)").run("req-1", "R1", Date.now())
    run("D1", "helper", "y", { channel: "a2a", chatId: "a2a:builder:helper:dlg-abc-1" })
    expect(representativeRun(db, tmp, ["req-1"], "builder")).toBe("R1")
    expect(representativeRun(db, tmp, ["dlg-abc-1"], "builder")).toBe("D1")
    expect(representativeRun(db, tmp, ["nothing"], "builder")).toBeNull()
  })
})

describe("handWorstToRetro", () => {
  it("raises one card for the worst problem, with its signal rows, and books the cost", async () => {
    problem()
    const r = reviewer(0.5)
    const out = await handWorstToRetro({ root: tmp, db, groups: await ranked(), since: 0, settings: ON, approvals, propose: r.propose, retroMax: 3, commit: true })
    expect(out.room).toBe(1)
    expect(out.outcomes).toMatchObject([{ result: "raised", taskId: "T2", usd: 0.5 }])
    expect(r.inputs[0].recurringProblem).toMatchObject({ kind: "request_stalled", agent: "builder", separateRefs: 3 })
    expect(r.inputs[0].recurringProblem.signals).toHaveLength(3)
    const card = listCards(tmp)[0]
    expect(card.origin).toMatchObject({ kind: "retro", taskId: "T2", signature: expect.stringMatching(/^improve:/) })
    expect(card.raised_by).toBe("builder")
    expect(spentToday(db).usd).toBe(0.5)
  })

  it("previews without a call, and keeps one open card per problem", async () => {
    problem()
    const r = reviewer()
    const groups = await ranked()
    const preview = await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: ON, approvals, propose: r.propose, retroMax: 3 })
    expect(preview.outcomes).toMatchObject([{ result: "would-try", taskId: "T2" }])
    expect(r.inputs).toHaveLength(0)
    await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: { ...ON, maxCardsPerDay: 3 }, approvals, propose: r.propose, retroMax: 3, commit: true })
    const again = await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: { ...ON, maxCardsPerDay: 3 }, approvals, propose: r.propose, retroMax: 3, commit: true })
    expect(again.outcomes).toMatchObject([{ result: "skipped", why: expect.stringContaining("already asks about this problem") }])
    expect(r.inputs).toHaveLength(1)
  })

  it("holds improve.maxCardsPerDay and the retro's own daily limit", async () => {
    problem()
    const r = reviewer()
    const groups = await ranked()
    expect((await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: { ...ON, maxCardsPerDay: 0 }, approvals, propose: r.propose, retroMax: 3, commit: true })).room).toBe(0)
    // Three retro cards already today: the retro's limit is full.
    for (let i = 0; i < 3; i++) {
      const made = createCard(tmp, { title: `Earlier retro ${i}`, ask: "Which fix?", recommend: "A check: it is cheap", if_silent: "discard", raised_by: "ops" }, { settings: approvals, origin: { kind: "retro", taskId: `X${i}`, signature: `sig${i}` } })
      expect(made.ok).toBe(true)
    }
    expect((await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: ON, approvals, propose: r.propose, retroMax: 3, commit: true })).room).toBe(0)
    expect(r.inputs).toHaveLength(0)
  })

  it("starts no call past improve.dailyUsd, and books a call whose cost is unknown", async () => {
    problem()
    const r = reviewer(null)
    const groups = await ranked()
    const poor = await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: { ...ON, dailyUsd: 1 }, approvals, propose: r.propose, retroMax: 3, commit: true })
    expect(poor.outcomes).toMatchObject([{ result: "skipped", why: expect.stringContaining("daily budget") }])
    expect(r.inputs).toHaveLength(0)
    await handWorstToRetro({ root: tmp, db, groups, since: 0, settings: ON, approvals, propose: r.propose, retroMax: 3, commit: true })
    expect(spentToday(db).usd).toBe(2) // the retro estimate
  })

  it("never runs with improve.enabled off, even with --commit", async () => {
    problem()
    const r = reviewer()
    const out = await improvePass({ db, since: 0, commit: true, settings: { ...ON, enabled: false }, retro: { root: tmp, approvals, propose: r.propose, retroMax: 3 } })
    expect(out.handoff).toMatchObject({ why: "improve.enabled is off" })
    expect(r.inputs).toHaveLength(0)
    expect(listCards(tmp)).toHaveLength(0)
  })

  it("puts stage 4's note first in the card's context", async () => {
    problem()
    const r = reviewer()
    await handWorstToRetro({ root: tmp, db, groups: await ranked(), since: 0, settings: ON, approvals, propose: r.propose, retroMax: 3, commit: true, noteFor: () => "The fix picked on card:x did not lower it." })
    expect(listCards(tmp)[0].context).toMatch(/^The fix picked on card:x did not lower it\. it closed early/)
    expect(problemSignature("k")).toBe("improve:k")
  })
})
