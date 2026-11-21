import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, decideCard, readCard, verdictMessage, type DecisionCard } from "../src/approvals/cards"
import { runApprovalsSweep } from "../src/approvals/sweep"
import { listInbox } from "../src/approvals/inbox"
import { goalCardInput } from "../src/crons/goal-card"
import { applyGoalAnswer } from "../src/crons/goal-answer"
import { jobGoalState, updateJobGoalState, type GoalCheckState } from "../src/crons/goal-state"

// #863 v2.2 §3: the goal card says what a plain yes does, is not
// popup-only, and offers exactly Keep / Change / Drop. The answer is
// applied when the card is decided, through the notice loop.

const T0 = Date.parse("2026-11-01T08:00:00Z")
const JOB = { id: "j", agent: "helper" }
let dir: string

function held(recommend?: GoalCheckState["recommend"]): GoalCheckState {
  return { goalId: "g", since: new Date(T0).toISOString(), reason: "closed", askedAt: new Date(T0).toISOString(), ...(recommend ? { recommend } : {}) }
}

function raise(g: GoalCheckState): DecisionCard {
  updateJobGoalState(dir, "j", (s) => { s.goalCheck = g })
  const made = createCard(dir, goalCardInput(JOB, g), { now: T0, origin: { kind: "cron-goal", jobId: "j", goalId: "g" } })
  if (!made.ok) throw new Error(made.error)
  updateJobGoalState(dir, "j", (s) => { s.goalCheck!.cardId = made.card.id })
  return made.card
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-goal-card-"))
  writeFileSync(join(dir, "agentx.json"), JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: { helper: { name: "Helper", workspace: "./agents/helper", tier: "claude-code" } },
    crons: { j: { schedule: "0 9 * * *", agent: "helper", prompt: "work", goal: "g", enabled: true } },
  }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("the goal card", () => {
  it("plain yes on a drop recommendation → drop, and the text says so", () => {
    const card = raise(held({ choice: "drop", why: "the goal is met", at: "x" }))
    expect(card.choices).toEqual(["Keep", "Change", "Drop"])
    expect(card.ask).toMatch(/A plain yes takes the recommendation shown\. No keeps the job\./)
    expect(card.context).toMatch(/No expiry: the job stays held until you answer/)
    const r = decideCard(dir, card.id, "yes", { now: T0 + 1 })
    expect(r).toMatchObject({ ok: true, card: { choice: "Drop", choice_suggested: true } })
  })

  it("shows no expiry date on the Desk, and says the job stays held", () => {
    raise(held({ choice: "keep", why: "x", at: "x" }))
    const item = listInbox({ root: dir }, { kinds: ["card"] }).items[0]
    expect(item.expires).toBeUndefined()
    expect(item.if_silent).toBeUndefined()
    expect(item.detail).toMatch(/No expiry: the job stays held until you answer/)
  })

  it("plain yes with no recommendation → refused, asks for a choice", () => {
    const card = raise(held())
    expect(card.recommend).toBe("No recommendation from helper.")
    expect(card.ask).toMatch(/Pick Keep, Change or Drop\./)
    const r = decideCard(dir, card.id, "yes", { now: T0 + 1 })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/pick one of 1\. Keep, 2\. Change, 3\. Drop/) })
    expect(readCard(dir, card.id)!.status).toBe("pending")
  })

  it("is not popup-only: a yes from the phone (not the popup) is applied", async () => {
    const card = raise(held({ choice: "keep", why: "still useful", at: "x" }))
    expect(card.popup_only).toBeFalsy()
    const r = decideCard(dir, card.id, "yes", { choice: "Change", note: "weekly is enough", now: T0 + 1, by: "phone" })
    expect(r.ok).toBe(true)
    expect(await applyGoalAnswer((r as any).card, { root: dir, configPath: join(dir, "agentx.json"), log: () => {} })).toBe("applied")
    expect(jobGoalState(dir, "j").changeOwed).toMatchObject({ cardId: card.id, note: "weekly is enough" })
  })

  it("the owner's result lines say what the answer did; no generic default line", () => {
    const card = raise(held({ choice: "drop", why: "done", at: "x" }))
    const drop = (decideCard(dir, card.id, "yes", { now: T0 + 1 }) as any).card as DecisionCard
    const text = verdictMessage(drop)
    expect(text).toMatch(/The operator said drop for your schedule j/)
    expect(text).toMatch(/retired the job/)
    expect(text).toMatch(/plain yes, taken as the recommended option/)
    expect(text).not.toMatch(/default applied/)
    expect(verdictMessage({ ...drop, status: "expired" })).toMatch(/No answer yet: the job stays held\./)
  })
})

describe("applied on decision, through the notice loop", () => {
  it("applies before the owner is told, once", async () => {
    const card = raise(held({ choice: "keep", why: "x", at: "x" }))
    decideCard(dir, card.id, "yes", { now: T0 + 1 })
    const told: Array<{ agent: string; text: string; heldThen: boolean }> = []
    const sweep = () => runApprovalsSweep({
      ctx: { root: dir, now: T0 + 60_000 },
      settings: { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 4, notifyAgent: true, digest: { enabled: false, time: "09:00" } },
      applyCronGoal: (c) => applyGoalAnswer(c, { root: dir, configPath: join(dir, "agentx.json"), log: () => {} }),
      tellAgent: async (agent, text) => { told.push({ agent, text, heldThen: !!jobGoalState(dir, "j").goalCheck }) },
      log: () => {},
    })
    await sweep()
    await sweep()
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ agent: "helper", heldThen: false })
    expect(told[0].text).toMatch(/The operator said keep/)
    expect(jobGoalState(dir, "j").goalKeptAt).toBe(new Date(T0 + 1).toISOString())
  })
})
