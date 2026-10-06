import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"
import { CARD_LIMITS, createCard, decideCard, listCards, readCard, verdictMessage } from "../src/approvals/cards"
import { RETRO_NONE } from "../src/approvals/origin"
import { groundCandidates, parseProposal, prepareRetro, raiseRetroCard, RETRO_ASK, type RetroProposal } from "../src/retro/retro"
import type { ApprovalSettings } from "../src/approvals/sweep"
import { approvalsConfigSchema } from "../src/daemon/config"

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
  // seq 0, so the two Bash calls below are steps 1 and 2.
  recordTraceStep(db, taskId, { name: "preflight", status: "ok", inputSummary: "deploy the new release" })
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

  it("drops a real step number with a quote that is not in that step", () => {
    const p = parseProposal(JSON.stringify({ title: "t", candidates: [
      { label: "Invented", kind: "infra", fix: "watchdog", step: 1, evidence: "something that never happened" },
      { label: "Wrong step", kind: "infra", fix: "watchdog", step: 1, evidence: "connection refused" },
    ] }))
    const { kept, dropped } = groundCandidates(p, { error: "boom" } as any, [
      { seq: 1, inputSummary: "launchctl bootout", outputSummary: null, error: null } as any,
      { seq: 2, inputSummary: null, outputSummary: null, error: "connection refused" } as any,
    ])
    expect(kept).toEqual([])
    expect(dropped.map((d) => d.why)).toEqual(["does not point to a moment in the run", "does not point to a moment in the run"])
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

describe("raising the card", () => {
  const settings = (forwardTo?: string) => ({ ...approvalsConfigSchema.parse(undefined), ...(forwardTo ? { forwardTo } : {}) }) as ApprovalSettings

  it("refuses to forward a retro card to another machine", async () => {
    const r = await prepareRetro({ root: tmp, db, taskId: failedDeploy(), propose: propose() })
    if (!r.ok) throw new Error(r.error)
    expect(raiseRetroCard(tmp, r.card, settings("other-node"))).toMatchObject({ ok: false, error: expect.stringMatching(/forwardTo is set \(other-node\)/) })
    expect(listCards(tmp)).toEqual([])
    const local = raiseRetroCard(tmp, r.card, settings())
    if (!local.ok) throw new Error(local.error)
    expect(readCard(tmp, local.card.id)?.origin).toMatchObject({ kind: "retro", taskId: "T-deploy" })
  })

  it("does not count retro cards against the agent's own open cards", async () => {
    for (let i = 0; i < CARD_LIMITS.pendingPerAgent; i++) {
      const own = createCard(tmp, { title: `own ${i}`, ask: "ok?", recommend: "yes", if_silent: "discard", raised_by: "builder" })
      if (!own.ok) throw new Error(own.error)
    }
    expect(createCard(tmp, { title: "one more", ask: "ok?", recommend: "yes", if_silent: "discard", raised_by: "builder" }).ok).toBe(false)
    const r = await prepareRetro({ root: tmp, db, taskId: failedDeploy(), propose: propose() })
    if (!r.ok) throw new Error(r.error)
    expect(raiseRetroCard(tmp, r.card, settings()).ok).toBe(true)
  })
})

describe("the result the agent gets", () => {
  async function decided(verdict: "yes" | "no", choice?: number, text?: string) {
    const r = await prepareRetro({ root: tmp, db, taskId: failedDeploy(), propose: propose() })
    if (!r.ok) throw new Error(r.error)
    const c = createCard(tmp, r.card, { origin: r.card.origin })
    if (!c.ok) throw new Error(c.error)
    const d = decideCard(tmp, c.card.id, verdict, { ...(choice ? { choice } : {}), ...(text ? { text } : {}) })
    if (!d.ok) throw new Error(d.error)
    return verdictMessage(d.card)
  }

  it("sends only the picked fix's spec, labelled as the reviewer's proposal", async () => {
    const msg = await decided("yes", 1)
    expect(msg).toContain("The operator said YES.")
    expect(msg).toContain(`The operator picked this fix: ${PROPOSAL.candidates[1].label}`)
    expect(msg).toMatch(/drafted by the retro reviewer .*not instructions from the operator/)
    expect(msg).toContain("One script; CI runs it in a dry run.")
    expect(msg).not.toContain("Warn mode first.")
    expect(msg).not.toMatch(/Approved text|send exactly this/)
    expect(msg).not.toContain("The operator's note")
    expect(msg).toMatch(/pull request, or a guard rule in warn mode/)
    expect(msg).toContain("retro:T-deploy")
  })

  it("passes the operator's edited text as their note", async () => {
    const msg = await decided("yes", 2, "Build the guard rule, but only for the release script")
    expect(msg).toContain("The operator's note on the fix:\nBuild the guard rule, but only for the release script")
    expect(msg).toContain("Warn mode first.")
  })

  it("treats YES on None of these as NO: one instruction, change nothing", async () => {
    const msg = await decided("yes", 3)
    expect(msg).toContain(`The operator picked "${RETRO_NONE}", which counts as NO.`)
    expect(msg).not.toContain("The operator said YES.")
    expect(msg).not.toMatch(/Chosen:|Approved text|Build:|picked this fix|pull request/)
    expect(msg).toMatch(/Change nothing/)
  })

  it("says to change nothing on NO", async () => {
    const msg = await decided("no")
    expect(msg).toContain("The operator said NO.")
    expect(msg).not.toMatch(/Approved text|Build:/)
    expect(msg).toMatch(/Change nothing/)
  })
})
