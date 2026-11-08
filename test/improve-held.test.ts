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
import { groupKey, normalizeDetail } from "../src/improve/rank"
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
function picked(pickedAt: number, choice: 1 | 2 = 1) {
  const r = createCard(tmp, {
    title: "Builder requests go quiet", ask: "What should change so this can't happen again?", recommend: "A watchdog",
    choices: ["Watchdog on quiet requests", "None of these"], if_silent: "discard", raised_by: "builder",
  }, { settings: approvals, origin: { kind: "retro", taskId: "T-x", signature: problemSignature(KEY) } })
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
