import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"
import { createCard, decideCard, readCard, verdictMessage } from "../src/approvals/cards"
import { RETRO_NONE } from "../src/approvals/origin"
import { groundCandidates, parseProposal, prepareRetro, RETRO_ASK, type RetroProposal } from "../src/retro/retro"

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-retro-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

/** A deploy run that stopped the daemon job and never started it again. */
function failedDeploy(taskId = "T-deploy", chatId = "ops") {
  recordTraceStart(db, { agentId: "builder", channel: "telegram", chatId, messagePreview: "deploy the new release" }, taskId)
  recordTraceStep(db, taskId, { name: "tool_use", action: "Bash", status: "ok", inputSummary: "launchctl bootout gui/501/com.example.daemon" })
  recordTraceStep(db, taskId, { name: "tool_use", action: "Bash", status: "error", inputSummary: "curl localhost:18800/health", error: "connection refused on the health check" })
  recordTraceEnd(db, taskId, { status: "error", error: "health check failed: connection refused" })
  return taskId
}

const PROPOSAL: RetroProposal = {
  title: "Daemon job left unloaded after a deploy",
  context: "The deploy stopped the daemon job (step 1) and never started it again; the health check was refused (step 2).",
  candidates: [
    { label: "Guard rule: warn on stopping the daemon job without starting it", kind: "mechanical", fix: "guard-rule", severity: "medium", step: 1, evidence: "launchctl bootout", spec: "Warn mode first." },
    { label: "Deploy script: repoint, wait for unload, start, verify /health", kind: "mechanical", fix: "script", severity: "high", step: 2, evidence: "connection refused", spec: "One script; CI runs it in a dry run." },
    { label: "Note in CLAUDE.md to restart the daemon", kind: "mechanical", fix: "pointer", severity: "low", step: 1, evidence: "launchctl bootout", spec: "" },
    { label: "Watchdog on the daemon job", kind: "infra", fix: "watchdog", severity: "medium", step: 99, evidence: "something that never happened", spec: "" },
  ],
}

const propose = (p: RetroProposal = PROPOSAL) => async () => JSON.stringify(p)

describe("groundCandidates", () => {
  it("keeps grounded fixes in the right place, most severe first", () => {
    const { kept, dropped } = groundCandidates(PROPOSAL, { error: "boom" } as any, [
      { seq: 1, inputSummary: "launchctl bootout", outputSummary: null, error: null } as any,
      { seq: 2, inputSummary: null, outputSummary: null, error: "connection refused" } as any,
    ])
    expect(kept.map((c) => c.fix)).toEqual(["script", "guard-rule"])
    expect(dropped).toEqual([
      { label: "Note in CLAUDE.md to restart the daemon", why: "a mechanical problem is not fixed with a pointer" },
      { label: "Watchdog on the daemon job", why: "does not point to a moment in the run" },
    ])
  })

  it("accepts an exact quote from the run's error when there is no step", () => {
    const p = parseProposal(JSON.stringify({ title: "t", candidates: [{ label: "Watchdog", kind: "infra", fix: "watchdog", step: null, evidence: "Health check FAILED" }] }))
    expect(groundCandidates(p, { error: "health check failed: refused" } as any, []).kept).toHaveLength(1)
  })
})

describe("prepareRetro", () => {
  it("builds one discard-if-silent card for the agent that ran the task", async () => {
    const taskId = failedDeploy()
    const r = await prepareRetro({ root: tmp, db, taskId, propose: propose() })
    if (!r.ok) throw new Error(r.error)
    expect(r.signals.map((s) => s.kind)).toContain("failed")
    expect(r.card).toMatchObject({
      title: PROPOSAL.title,
      ask: RETRO_ASK,
      if_silent: "discard",
      raised_by: "builder",
      source: `agentx trace show ${taskId}`,
      origin: { kind: "retro", taskId },
    })
    expect(r.card.choices).toEqual([PROPOSAL.candidates[1].label, PROPOSAL.candidates[0].label, RETRO_NONE])
    expect(String(r.card.recommend).startsWith(`${PROPOSAL.candidates[1].label}: the most severe (high)`)).toBe(true)
    expect(r.card.draft).toContain("Build: {choice}")
    expect(r.card.draft).toContain("\n   One script; CI runs it in a dry run.")
    expect(createCard(tmp, r.card, { origin: r.card.origin }).ok).toBe(true)
  })

  it("refuses runs that did not struggle, unless forced", async () => {
    recordTraceStart(db, { agentId: "builder", channel: "telegram", chatId: "ops" }, "T-ok")
    recordTraceEnd(db, "T-ok", { status: "ok" })
    const r = await prepareRetro({ root: tmp, db, taskId: "T-ok", propose: propose() })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no sign of struggling/) })
    const forced = await prepareRetro({ root: tmp, db, taskId: "T-ok", propose: propose({ ...PROPOSAL, candidates: [] }), force: true })
    expect(forced).toMatchObject({ ok: false, error: expect.stringMatching(/no candidate fix/) })
  })

  it("never reads the run that builds a picked fix", async () => {
    const first = await prepareRetro({ root: tmp, db, taskId: failedDeploy(), propose: propose() })
    if (!first.ok) throw new Error(first.error)
    const c = createCard(tmp, first.card, { origin: first.card.origin })
    if (!c.ok) throw new Error(c.error)
    recordTraceStart(db, { agentId: "builder", channel: "approvals", chatId: c.card.id }, "T-build")
    recordTraceEnd(db, "T-build", { status: "error", error: "lint failed" })
    expect(await prepareRetro({ root: tmp, db, taskId: "T-build", propose: propose() }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/started by a retro/) })
  })

  it("keeps one open card per failure, and does not offer a turned-down fix again", async () => {
    const first = await prepareRetro({ root: tmp, db, taskId: failedDeploy("T-1", "a"), propose: propose() })
    if (!first.ok) throw new Error(first.error)
    const c = createCard(tmp, first.card, { origin: first.card.origin })
    if (!c.ok) throw new Error(c.error)

    const again = await prepareRetro({ root: tmp, db, taskId: failedDeploy("T-2", "b"), propose: propose() })
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining(`card:${c.card.id}`) })

    // The operator picks the guard rule: the script was turned down.
    expect(decideCard(tmp, c.card.id, "yes", { choice: 2 }).ok).toBe(true)
    const third = await prepareRetro({ root: tmp, db, taskId: failedDeploy("T-3", "c"), propose: propose() })
    if (!third.ok) throw new Error(third.error)
    expect(third.card.choices).toEqual([PROPOSAL.candidates[0].label, RETRO_NONE])
    expect(third.signals.map((s) => s.kind)).toContain("recurring")
  })
})

describe("the result the agent gets", () => {
  it("says to build the pick for review, or to change nothing", async () => {
    const r = await prepareRetro({ root: tmp, db, taskId: failedDeploy(), propose: propose() })
    if (!r.ok) throw new Error(r.error)
    const c = createCard(tmp, r.card, { origin: r.card.origin })
    if (!c.ok) throw new Error(c.error)
    const picked = decideCard(tmp, c.card.id, "yes", { choice: 1 })
    if (!picked.ok) throw new Error(picked.error)
    const msg = verdictMessage(picked.card)
    expect(msg).toContain(`Chosen: ${PROPOSAL.candidates[1].label}`)
    expect(msg).toMatch(/pull request, or a guard rule in warn mode/)
    expect(msg).toContain("retro:T-deploy")

    const none = { ...readCard(tmp, c.card.id)!, choice: RETRO_NONE }
    expect(verdictMessage(none)).toMatch(/Change nothing/)
  })
})
