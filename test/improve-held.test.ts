import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"
import { createCard, decideCard, listCards, readCard, saveCard } from "../src/approvals/cards"
import type { ApprovalSettings } from "../src/approvals/sweep"
import { approvalsConfigSchema, improveConfigSchema } from "../src/daemon/config"
import type { RetroProposal } from "../src/retro/retro"
import { recordSignal } from "../src/improve/signals"
import { groupKey, groupSignals, normalizeDetail, readRanking, saveRanking } from "../src/improve/rank"
import { problemSignature } from "../src/improve/handoff"
import { checkHeld, notHeldNote, pickedFixes } from "../src/improve/held"
import { improvePass } from "../src/improve/nightly"

// #1783 stage 4: a picked fix is held when its problem's count in the 7 days
// after the pick is lower than in the 7 before. One that did not hold says
// so on the problem's next card, not on a card of its own.

const DAY = 86_400_000
let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-held-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

const approvals = approvalsConfigSchema.parse(undefined) as ApprovalSettings
const ON = { ...improveConfigSchema.parse(undefined), enabled: true, dailyUsd: 10 }
const DETAIL = "went quiet after 10 minutes"
const KEY = groupKey("request_stalled", "builder", normalizeDetail("request_stalled", DETAIL))

/** `n` stalls of builder, each on its own request, starting at `from`. */
function stalls(n: number, from: number, tag: string) {
  for (let i = 0; i < n; i++) recordSignal(db, { kind: "request_stalled", agentId: "builder", ref: `${tag}${i}`, detail: DETAIL }, from + i * 60_000)
}

/** A self-improvement card for the problem, its first fix picked at `pickedAt`. */
function picked(pickedAt: number, choice: 1 | 2 = 1, key = KEY) {
  const r = createCard(tmp, {
    title: "Builder requests go quiet", ask: "What should change so this can't happen again?", recommend: "A watchdog",
    choices: ["Watchdog on quiet requests", "None of these"], if_silent: "discard", raised_by: "builder",
  }, { settings: approvals, origin: { kind: "retro", taskId: "T-x", signature: problemSignature(key) } })
  if (!r.ok) throw new Error(r.error)
  const d = decideCard(tmp, r.card.id, "yes", { choice, now: pickedAt })
  if (!d.ok) throw new Error(d.error)
  // Raised the day it was picked, not today: today's card limit stays free.
  saveCard(tmp, { ...readCard(tmp, r.card.id)!, created_at: new Date(pickedAt - 3_600_000).toISOString() })
  return r.card.id
}

describe("checkHeld", () => {
  it("is held when the 7 days after the pick have fewer rows than the 7 before", () => {
    const now = Date.now()
    const pick = now - 8 * DAY
    stalls(5, pick - 3 * DAY, "b")
    stalls(1, pick + 2 * DAY, "a")
    const id = picked(pick)
    expect(checkHeld(db, tmp, now)).toMatchObject([{ cardId: id, key: KEY, agentId: "builder", before: 5, after: 1, verdict: "held" }])
  })

  it("did not hold when the count did not go down, and waits until the 7 days are over", () => {
    const now = Date.now()
    stalls(2, now - 12 * DAY, "b")
    stalls(3, now - 9 * DAY, "a")
    picked(now - 10 * DAY)
    expect(checkHeld(db, tmp, now)[0]).toMatchObject({ before: 2, after: 3, verdict: "not-held" })

    stalls(1, now - 2 * DAY, "c")
    const late = checkHeld(db, tmp, now).find((h) => h.verdict === "waiting")
    expect(late).toBeUndefined() // only one card so far
    picked(now - 3 * DAY)
    expect(checkHeld(db, tmp, now)[0]).toMatchObject({ verdict: "waiting", daysLeft: 4 })
  })

  it("ignores cards answered None of these, and other retro cards", () => {
    picked(Date.now() - 9 * DAY, 2)
    createCard(tmp, { title: "Plain retro", ask: "Which fix?", recommend: "A", choices: ["A", "None of these"], if_silent: "discard", raised_by: "ops" }, { settings: approvals, origin: { kind: "retro", taskId: "T", signature: "sig" } })
    expect(pickedFixes(tmp)).toEqual([])
    expect(checkHeld(db, tmp)).toEqual([])
  })
})

describe("notHeldNote", () => {
  it("names the card and the counts for a problem whose fix did not hold, by any of its keys", () => {
    const now = Date.now()
    stalls(2, now - 12 * DAY, "b")
    stalls(2, now - 9 * DAY, "a")
    const id = picked(now - 10 * DAY)
    const checks = checkHeld(db, tmp, now)
    expect(notHeldNote(checks, ["other", KEY])).toMatch(new RegExp(`^The fix picked on card:${id} \\(.+"Watchdog on quiet requests"\\) did not lower this: 2 in the 7 days before, 2 in the 7 after\\.$`))
    expect(notHeldNote(checks, ["other"])).toBeUndefined()
  })
})

describe("the nightly pass", () => {
  it("puts the not-held note on the problem's next card instead of raising a card about it", async () => {
    const now = Date.now()
    stalls(2, now - 12 * DAY, "b")
    stalls(2, now - 9 * DAY, "a")
    const first = picked(now - 10 * DAY)
    // Tonight the problem is back on three runs.
    for (let i = 0; i < 3; i++) {
      recordTraceStart(db, { agentId: "builder", channel: "telegram", chatId: "ops", messagePreview: "close it" }, `T${i}`)
      recordTraceStep(db, `T${i}`, { name: "preflight", status: "ok", inputSummary: "close it" })
      recordTraceStep(db, `T${i}`, { name: "tool_use", action: "Bash", status: "ok", inputSummary: "wait", outputSummary: "no answer from the builder for ten minutes" })
      recordTraceEnd(db, `T${i}`, { status: "ok" })
      recordSignal(db, { kind: "request_stalled", agentId: "builder", ref: `T${i}`, detail: DETAIL }, now - 3_600_000 + i)
    }
    const propose = async () => {
      const p: RetroProposal = { title: "Builder still goes quiet", context: "again", candidates: [{ label: "Alert after five quiet minutes", kind: "infra", fix: "watchdog", severity: "high", step: 1, evidence: "no answer from the builder", spec: "An alert." }] }
      return { text: JSON.stringify(p), usd: 0.4 }
    }
    const r = await improvePass({ db, since: now - DAY, commit: true, settings: ON, now, retro: { root: tmp, approvals, propose, retroMax: 3 } })
    expect(r.held).toMatchObject([{ cardId: first, verdict: "not-held" }])
    expect(r.handoff?.outcomes).toMatchObject([{ result: "raised" }])
    const next = listCards(tmp, "pending")
    expect(next).toHaveLength(1)
    expect(next[0].context).toMatch(new RegExp(`^The fix picked on card:${first} .* did not lower this: 2 in the 7 days before, 2 in the 7 after\\. again$`))
  })
})

// #1995: a fix picked on a cost problem holds only when tokens per run of
// the problem's job types went down AND the owner's reopens did not go up.

const REWRITE = "job workflow release-notes: rewrite 60k of 61k"
const COST_KEY = groupKey("context_rewrite", "builder", normalizeDetail("context_rewrite", REWRITE))

/** A finished run of `workflowId` with `total` tokens, started at `at`. */
function run(workflowId: string, total: number, at: number): string {
  const id = recordTraceStart(db, { agentId: "builder", channel: "workflow", chatId: `workflow:run-${at}`, workflowId })
  recordTraceEnd(db, id, { status: "ok", inputTokens: 10, outputTokens: 0, cacheReadTokens: total - 10, cacheCreateTokens: 0 })
  db.prepare("UPDATE task_traces SET started_at = ?, finished_at = ? WHERE task_id = ?").run(at, at + 60_000, id)
  return id
}

function rewrites(refs: string[], from: number) {
  refs.forEach((ref, i) => recordSignal(db, { kind: "context_rewrite", agentId: "builder", ref, detail: REWRITE }, from + i * 60_000))
}

function reopens(n: number, from: number) {
  for (let i = 0; i < n; i++) recordSignal(db, { kind: "owner_reopened", agentId: "builder", ref: `req-o${from}-${i}`, detail: "not done" }, from + i)
}

describe("checkHeld for a cost problem", () => {
  it("holds when tokens per run went down and reopens went from 0 to 1", () => {
    const now = Date.now()
    const pick = now - 8 * DAY
    const before = [0, 1, 2].map((i) => run("release-notes", 200_000, pick - (3 + i) * DAY))
    for (let i = 0; i < 3; i++) run("release-notes", 100_000, pick + (1 + i) * DAY)
    rewrites(before, pick - 2 * DAY)
    reopens(1, pick + DAY)
    picked(pick, 1, COST_KEY)
    const [h] = checkHeld(db, tmp, now)
    expect(h).toMatchObject({ verdict: "held", cost: { jobTypes: 1, tokensBefore: 200_000, tokensAfter: 100_000, reopensBefore: 0, reopensAfter: 1, failed: [] } })
  })

  it("does not hold when tokens went down but reopens went up, and the note says which", () => {
    const now = Date.now()
    const pick = now - 8 * DAY
    const before = [0, 1, 2].map((i) => run("release-notes", 200_000, pick - (3 + i) * DAY))
    for (let i = 0; i < 3; i++) run("release-notes", 100_000, pick + (1 + i) * DAY)
    rewrites(before, pick - 2 * DAY)
    reopens(1, pick - DAY)
    reopens(3, pick + DAY)
    const id = picked(pick, 1, COST_KEY)
    const checks = checkHeld(db, tmp, now)
    expect(checks[0]).toMatchObject({ verdict: "not-held", cost: { reopensBefore: 1, reopensAfter: 3, failed: ["reopens"] } })
    expect(notHeldNote(checks, [COST_KEY])).toMatch(new RegExp(`^The fix picked on card:${id} .* did not lower this: tokens per run 200k before, 100k after; owner reopens 1 before, 3 after \\(reopens went up\\)\\.$`))
  })

  it("does not hold when tokens per run did not go down", () => {
    const now = Date.now()
    const pick = now - 8 * DAY
    const before = [0, 1, 2].map((i) => run("release-notes", 100_000, pick - (3 + i) * DAY))
    for (let i = 0; i < 3; i++) run("release-notes", 120_000, pick + (1 + i) * DAY)
    rewrites(before, pick - 2 * DAY)
    picked(pick, 1, COST_KEY)
    expect(checkHeld(db, tmp, now)[0]).toMatchObject({ verdict: "not-held", cost: { failed: ["tokens"] } })
  })

  it("finds the job types from every signal row in the before window, not only the saved sample (C1)", () => {
    const now = Date.now()
    const pick = now - 8 * DAY
    // Five newest refs: release-notes, flat. Oldest ref: weekly-digest, which fell a lot.
    const flat = [0, 1, 2, 3, 4].map((i) => run("release-notes", 100_000, pick - (2 + i * 0.1) * DAY))
    for (let i = 0; i < 5; i++) run("release-notes", 100_000, pick + (1 + i * 0.1) * DAY)
    const old = run("weekly-digest", 700_000, pick - 6 * DAY)
    run("weekly-digest", 100_000, pick + 2 * DAY)
    rewrites([old], pick - 5 * DAY)
    rewrites(flat, pick - DAY)
    // The night before the pick saved the group with its five newest refs.
    saveRanking(db, groupSignals(db, pick - 7 * DAY, pick), pick - 2 * 3_600_000)
    const [saved] = readRanking(db)
    expect(saved.refs).toBe(6)
    expect(saved.sampleRefs).toHaveLength(5)
    expect(saved.sampleRefs).not.toContain(old)
    picked(pick, 1, COST_KEY)
    const [h] = checkHeld(db, tmp, now)
    expect(h).toMatchObject({ verdict: "held", cost: { jobTypes: 2, failed: [] } })
    expect(h.cost!.tokensAfter).toBeLessThan(h.cost!.tokensBefore)
  })
})
