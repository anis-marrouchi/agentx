import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { createCard, decideCard, listCards, readCard, verdictMessage } from "../src/approvals/cards"
import { checkinDue, checkinTick, runCheckinPass, type CheckinDeps, type CheckinSettings } from "../src/approvals/checkin"
import { composePrompt, parseCompose } from "../src/approvals/checkin-compose"
import { readCheckinState } from "../src/approvals/checkin-state"
import { handleApprovalsApi } from "../src/approvals/daemon-api"
import { nextCardToPop } from "../src/approvals/popup-runner"
import { readInboxState, recordPopped } from "../src/approvals/state"
import { daemonConfigSchema } from "../src/daemon/config"
import type { Reminder, ReminderSource } from "../src/reminders/source"

// Check-ins. What must hold:
//   - a pass runs once per slot; the daily pass runs once a day; missed
//     slots are not replayed one by one
//   - a normal pass takes reminders due soon; the daily pass takes all
//   - the owning agent writes the card; the daemon raises it for that
//     agent, linked to the reminder, and nothing is sent to anyone
//   - one card per reminder at a time; claimed reminders are left alone
//   - every waiting card is put back in line for the Mac card

const HOUR = 3_600_000
// 10:30 UTC; the tests pin the timezone to UTC.
const NOW = Date.parse("2026-09-30T10:30:00.000Z")

const SETTINGS: CheckinSettings = {
  enabled: true, times: ["11:00", "14:00", "17:00"], dailyAt: "09:00", timezone: "UTC",
  lists: ["Reminders"], agent: "secretary", dueWithinHours: 24, maxAsksPerPass: 5, composeTimeoutSeconds: 60,
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-checkin-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function source(items: Reminder[]): ReminderSource {
  return { listOpen: async () => items.map((r) => ({ ...r })), complete: async () => {} }
}

const CARD_JSON = JSON.stringify({
  needs_operator: true, title: "New meeting date", context: "He said: pick one", ask: "Which date?",
  recommend: "Thursday", choices: ["Thu 12:00", "Sun 11:00"], draft: "Ok for {choice}", if_silent: "keep", expires: "2d",
})

function deps(items: Reminder[], reply: string | ((agent: string) => string) = CARD_JSON, extra: Partial<CheckinDeps> = {}) {
  const asked: { agent: string; message: string }[] = []
  const logs: string[] = []
  const d: CheckinDeps = {
    root, settings: SETTINGS, source: source(items),
    hasAgent: (id) => ["secretary", "helper"].includes(id),
    ask: async (agent, message) => { asked.push({ agent, message }); return typeof reply === "function" ? reply(agent) : reply },
    log: (m) => logs.push(m), now: NOW, ...extra,
  }
  return { d, asked, logs }
}

const r = (id: string, extra: Partial<Reminder> = {}): Reminder => ({ id, title: `Reminder ${id}`, isCompleted: false, ...extra })

describe("the schedule", () => {
  const at = (hhmm: string) => Date.parse(`2026-09-30T${hhmm}:00.000Z`)
  it("runs the daily pass first, then each slot once", () => {
    expect(checkinDue(SETTINGS, {}, at("08:59"))).toBeNull()
    expect(checkinDue(SETTINGS, {}, at("09:00"))).toEqual({ kind: "daily", slot: "2026-09-30 09:00" })
    const afterDaily = { lastDaily: "2026-09-30", lastSlot: "2026-09-30 09:00" }
    expect(checkinDue(SETTINGS, afterDaily, at("10:59"))).toBeNull()
    expect(checkinDue(SETTINGS, afterDaily, at("11:00"))).toEqual({ kind: "check", slot: "2026-09-30 11:00" })
    expect(checkinDue(SETTINGS, { ...afterDaily, lastSlot: "2026-09-30 11:00" }, at("13:59"))).toBeNull()
  })
  it("a daemon started late runs the daily pass, not every missed slot", () => {
    expect(checkinDue(SETTINGS, { lastDaily: "2026-09-29", lastSlot: "2026-09-29 17:00" }, at("15:00")))
      .toEqual({ kind: "daily", slot: "2026-09-30 09:00" })
    expect(checkinDue(SETTINGS, { lastDaily: "2026-09-30", lastSlot: "2026-09-30 09:00" }, at("15:00")))
      .toEqual({ kind: "check", slot: "2026-09-30 14:00" })
  })
})

describe("composing", () => {
  it("tells the agent what the reminder is, and not to send anything", () => {
    const p = composePrompt(r("a", { dueDate: "2026-09-30T12:00:00Z", notes: "Call back about the quote\nagentx: agent=helper context=whatsapp:216" }),
      { agent: "helper", context: "whatsapp:216", detail: "Call back about the quote" }, "Wednesday")
    expect(p).toContain('Reminder: "Reminder a"')
    expect(p).toContain("Notes: Call back about the quote")
    expect(p).toContain("It came from: whatsapp:216")
    expect(p).toContain("Do not message anyone")
    expect(p).not.toContain("agentx: agent=")
  })
  it("reads the card from a reply with prose or fences around it", () => {
    const got = parseCompose("Checked the calendar.\n```json\n" + CARD_JSON + "\n```")
    expect(got.kind).toBe("card")
    expect(parseCompose('{"needs_operator": false, "why": "already done"}')).toEqual({ kind: "skip", why: "already done" })
  })
  it("refuses a reply that isn't a card", () => {
    expect(parseCompose("I'll handle it").kind).toBe("error")
    expect(parseCompose('{"title":"x"}').kind).toBe("error")
    expect(parseCompose(JSON.stringify({ needs_operator: true, choices: ["one"] })).kind).toBe("error")
    expect(parseCompose(JSON.stringify({ needs_operator: true, choices: ["1", "2", "3", "4", "5"] })).kind).toBe("error")
  })
})

describe("a pass", () => {
  it("raises the card for the owning agent, linked to the reminder", async () => {
    const { d, asked } = deps([r("a", { dueDate: "2026-09-30T12:00:00Z", notes: "agentx: agent=helper" }), r("b", { dueDate: "2026-09-30T13:00:00Z" })])
    const res = await runCheckinPass(d, "check")
    expect(res.carded).toHaveLength(2)
    expect(asked.map((a) => a.agent)).toEqual(["helper", "secretary"])
    const cards = listCards(root, "pending")
    expect(cards.map((c) => c.raised_by).sort()).toEqual(["helper", "secretary"])
    const a = cards.find((c) => c.raised_by === "helper")!
    expect(a).toMatchObject({ context: "He said: pick one", choices: ["Thu 12:00", "Sun 11:00"], origin: { kind: "reminder", id: "a", list: "Reminders" } })
    expect(readCheckinState(root).items.a).toMatchObject({ status: "carded", card: a.id, owner: "helper" })
  })

  it("the answer goes back to the owner with the reminder to tick off", async () => {
    const { d } = deps([r("a", { dueDate: "2026-09-30T12:00:00Z" })])
    const [id] = (await runCheckinPass(d, "check")).carded
    const decided = decideCard(root, id, "yes", { choice: 1, now: NOW })
    expect(decided.ok).toBe(true)
    const msg = verdictMessage(readCard(root, id)!)
    expect(msg).toContain("Chosen: Thu 12:00")
    expect(msg).toContain("Ok for Thu 12:00")
    expect(msg).toContain("remindctl complete a")
  })

  it("a normal pass takes what is due soon; the daily pass takes everything", async () => {
    const items = [r("soon", { dueDate: "2026-09-30T20:00:00Z" }), r("late", { dueDate: "2026-10-09T09:00:00Z" }), r("undated")]
    const check = deps(items)
    expect((await runCheckinPass(check.d, "check")).carded).toHaveLength(1)
    rmSync(join(root, ".agentx"), { recursive: true, force: true })
    const daily = deps(items)
    expect((await runCheckinPass(daily.d, "daily")).carded).toHaveLength(3)
  })

  it("one card per reminder at a time, and skipped ones wait for tomorrow", async () => {
    const items = [r("a", { dueDate: "2026-09-30T12:00:00Z" }), r("b", { dueDate: "2026-09-30T12:00:00Z" })]
    const first = deps(items)
    first.d.ask = async (_agent, message) => (message.includes("Reminder a") ? CARD_JSON : '{"needs_operator": false, "why": "done"}')
    await runCheckinPass(first.d, "check")
    const again = deps(items)
    expect((await runCheckinPass({ ...again.d, now: NOW + HOUR }, "daily")).carded).toHaveLength(0)
    expect(again.asked).toHaveLength(0)
    const tomorrow = deps(items)
    // a's card is still waiting; b, skipped yesterday, is asked again.
    expect((await runCheckinPass({ ...tomorrow.d, now: NOW + 24 * HOUR }, "daily")).carded).toHaveLength(1)
    expect(tomorrow.asked.map((a) => a.message.includes("Reminder b"))).toEqual([true])
  })

  it("leaves claimed and ownerless reminders alone", async () => {
    const claims = join(root, ".agentx", "reminders", "claims.json")
    mkdirSync(dirname(claims), { recursive: true })
    writeFileSync(claims, JSON.stringify({ c: { agent: "helper", status: "claimed", at: new Date(NOW).toISOString() } }))
    const due = "2026-09-30T12:00:00Z"
    const items = [r("c", { dueDate: due }), r("x", { dueDate: due, notes: "agentx: agent=ghost" })]
    const { d, asked, logs } = deps(items, "not json", { claimsPath: claims, settings: { ...SETTINGS, agent: undefined } })
    const res = await runCheckinPass(d, "check")
    expect(asked).toHaveLength(0)
    expect(res.carded).toEqual([])
    expect(logs.join("\n")).toContain("no agent owns it")
  })

  it("retries a failed reminder only at the next daily pass", async () => {
    const items = [r("y", { dueDate: "2026-09-30T12:00:00Z" })]
    const failing = deps(items, "not json")
    expect((await runCheckinPass(failing.d, "check")).failed).toBe(1)
    expect(readCheckinState(root).items.y.status).toBe("failed")
    // Not at the later check-ins of the same day, nor at that day's daily pass.
    const later = deps(items)
    expect((await runCheckinPass({ ...later.d, now: NOW + 3 * HOUR }, "check")).carded).toHaveLength(0)
    expect((await runCheckinPass({ ...later.d, now: NOW + 4 * HOUR }, "daily")).carded).toHaveLength(0)
    expect(later.asked).toHaveLength(0)
    const tomorrow = deps(items)
    expect((await runCheckinPass({ ...tomorrow.d, now: NOW + 24 * HOUR }, "daily")).carded).toHaveLength(1)
  })

  it("stops at maxAsksPerPass, soonest due first", async () => {
    const items = ["3", "1", "2"].map((n) => r(n, { dueDate: `2026-09-30T1${n}:00:00Z` }))
    const { d } = deps(items, CARD_JSON, { settings: { ...SETTINGS, maxAsksPerPass: 2 } })
    await runCheckinPass(d, "check")
    expect(Object.keys(readCheckinState(root).items).sort()).toEqual(["1", "2"])
  })

  it("counts every ask toward maxAsksPerPass, not only the cards", async () => {
    const items = ["1", "2", "3", "4"].map((n) => r(n, { dueDate: `2026-09-30T1${n}:00:00Z` }))
    // 1 is not needed, 2 fails, 3 would be a card: the cap of 2 stops before it.
    const reply = (_agent: string, message: string) =>
      message.includes("Reminder 1") ? '{"needs_operator": false, "why": "done"}' : message.includes("Reminder 2") ? "not json" : CARD_JSON
    const { d, asked } = deps(items, CARD_JSON, { settings: { ...SETTINGS, maxAsksPerPass: 2 } })
    d.ask = async (agent, message) => { asked.push({ agent, message }); return reply(agent, message) }
    const res = await runCheckinPass(d, "daily")
    expect(asked).toHaveLength(2)
    expect(res).toMatchObject({ carded: [], skipped: 1, failed: 1 })
  })

  it("puts every waiting card back in line for the Mac card, old or not", async () => {
    const old = createCard(root, { raised_by: "helper", title: "Old", ask: "?", recommend: "yes", if_silent: "keep", expires: "20d" }, { now: NOW - 5 * 24 * HOUR })
    if (!old.ok) throw new Error(old.error)
    const ctx = { root, now: NOW }
    expect(nextCardToPop(ctx)).toBeNull()
    await runCheckinPass(deps([]).d, "check")
    expect(nextCardToPop(ctx)?.id).toBe(old.card.id)
    recordPopped(root, `card:${old.card.id}`, [`card:${old.card.id}`], NOW)
    expect(nextCardToPop(ctx)).toBeNull()
    expect(readInboxState(root).passAt).toBe(new Date(NOW).toISOString())
  })
})

describe("the tick and the trigger", () => {
  it("records the slot before the pass, and runs nothing when off", async () => {
    const { d } = deps([])
    expect(await checkinTick({ ...d, settings: { ...SETTINGS, enabled: false } })).toBeNull()
    expect((await checkinTick(d))?.kind).toBe("daily")
    expect(readCheckinState(root)).toMatchObject({ lastDaily: "2026-09-30", lastSlot: "2026-09-30 09:00" })
    expect(await checkinTick(d)).toBeNull()
    expect((await checkinTick(d, "check"))?.kind).toBe("check")
  })

  it("POST /approvals/checkin starts a pass; deciding stays refused", () => {
    const started: string[] = []
    const api = (path: string, body?: Record<string, unknown>) => handleApprovalsApi("POST", path, body, new URLSearchParams(), {
      ctx: { root }, settings: { defaultExpiryDays: 3, maxExpiryDays: 30 }, hasAgent: () => true, runCheckin: (k) => started.push(k),
    })
    expect(api("/approvals/checkin", { daily: true })).toEqual({ status: 202, body: { started: "daily" } })
    expect(api("/approvals/checkin")).toEqual({ status: 202, body: { started: "check" } })
    expect(started).toEqual(["daily", "check"])
    expect(api("/approvals/some-card", { verdict: "yes" }).status).toBe(403)
  })

  it("is off by default", () => {
    const c = daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).approvals.checkin
    expect(c).toMatchObject({ enabled: false, dailyAt: "09:00", lists: ["Reminders"], maxAsksPerPass: 5 })
  })
})
