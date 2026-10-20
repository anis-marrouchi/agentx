import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, readCard, saveCard, type DecisionCard } from "../src/approvals/cards"
import { popNext, type PopupRunnerSettings } from "../src/approvals/popup-runner"
import { readInboxState, recordWanted } from "../src/approvals/state"
import { cardRuleBreak, followupBudgetRefusal, noticeRuleBreak, referenceOnlyTitle, returnedText, stripReferences, withTodo } from "../src/approvals/screen-gate"
import { notify } from "../src/notify"
import { readCall, readHold, writeCallHold } from "../src/notify/hold"
import { NotificationQueue } from "../src/notify/queue"

// The screen gatekeeper (#394, plan 1b): one question, title 120, ask 300,
// at most 3 choices, 5 follow-up cards a day (3 resurface), nothing new in
// a call or in Focus, and a card that fails goes back to its author.

const NOW = new Date(2026, 9, 18, 14, 0).getTime() // 14:00 local
const BASE = { raised_by: "secretary-agent", title: "Bring back: KSI deploy", ask: "Deploy the KSI fixes 522 and 517 now?", recommend: "Yes: tested", if_silent: "keep" }
const POPUP: PopupRunnerSettings = { enabled: true, speak: false, sound: "", volume: 0, timeoutSeconds: 30 }
const off = () => ({ active: false, mode: null, reason: "test" })

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-gate-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe("card rules at write", () => {
  it("refuses a second question, a long title or ask, and a fourth choice, with the reason", () => {
    expect(createCard(root, { ...BASE, ask: "Deploy now? Or wait for Monday?" }, { now: NOW })).toEqual({ ok: false, error: "ask holds more than one question: one card asks one thing" })
    expect(createCard(root, { ...BASE, title: "x".repeat(121) }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringContaining("120") })
    expect(createCard(root, { ...BASE, ask: `${"x".repeat(300)}?` }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringContaining("300") })
    expect(createCard(root, { ...BASE, choices: ["a", "b", "c", "d"] }, { now: NOW })).toMatchObject({ ok: false, error: "at most 3 choices" })
    expect(createCard(root, { ...BASE, choices: ["a", "b", "c"] }, { now: NOW }).ok).toBe(true)
  })

  it("refuses an unknown follow-up kind", () => {
    expect(createCard(root, { ...BASE, followup: "nudge" }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringContaining("followup must be one of") })
  })
})

describe("the follow-up screen budget", () => {
  const raise = (followup: string, now = NOW) => createCard(root, { ...BASE, followup }, { now })

  it("takes 5 follow-up cards a day, at most 3 of them resurface, and opens again the next day", () => {
    expect([1, 2, 3].map(() => raise("resurface").ok)).toEqual([true, true, true])
    expect(raise("resurface")).toMatchObject({ ok: false, error: expect.stringContaining("3 resurface cards") })
    expect(raise("bring-back").ok).toBe(true)
    expect(raise("weekly").ok).toBe(true)
    expect(raise("bring-back")).toMatchObject({ ok: false, error: expect.stringContaining("budget is used up today") })
    expect(createCard(root, BASE, { now: NOW }).ok).toBe(true) // not a follow-up card: not counted
    expect(raise("resurface", NOW + 24 * 3_600_000).ok).toBe(true)
  })

  it("counts answered cards too: they were on screen", () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({ followup: "weekly" as const, created_at: new Date(NOW - i * 60_000).toISOString() }))
    expect(followupBudgetRefusal(cards, "weekly", NOW)).toContain("used up")
    expect(followupBudgetRefusal(cards, "weekly", NOW + 12 * 3_600_000)).toBeNull()
  })
})

describe("gate 1: the popup", () => {
  /** A card written before the gate, bypassing createCard. */
  function oldCard(extra: Partial<DecisionCard>): DecisionCard {
    const card: DecisionCard = {
      id: "2026-10-18-old-card-ab12", title: "Old card", ask: "Ship it?", recommend: "Yes", if_silent: "keep",
      expires: new Date(NOW + 86_400_000).toISOString(), raised_by: "coder-agent", created_at: new Date(NOW - 60_000).toISOString(),
      status: "pending", ...extra,
    }
    saveCard(root, card)
    return card
  }

  it("does not show a card that breaks a rule: it stays pending and its author is told why, once", async () => {
    const card = oldCard({ ask: "Ship it? And post it?" })
    const shown: string[] = []
    const told: Array<[string, string]> = []
    const deps = {
      ctx: { root, now: NOW }, settings: POPUP, log: () => {}, platform: "darwin" as const, focus: off,
      show: async (c: DecisionCard) => { shown.push(c.id); return { action: "dismiss" as const } },
      returnToAuthor: (c: DecisionCard, text: string) => { told.push([c.raised_by, text]) },
    }
    expect(await popNext(deps)).toBe("returned")
    expect(await popNext(deps)).toBe("none")
    expect(shown).toEqual([])
    expect(told).toEqual([["coder-agent", returnedText(card, "ask holds more than one question: one card asks one thing")]])
    expect(readCard(root, card.id)?.status).toBe("pending")
    expect(readInboxState(root).popped?.[`card:${card.id}`]).toBeTruthy()
  })

  it("shows a card the owner asked for himself, rules or not", async () => {
    const card = oldCard({ choices: ["a", "b", "c", "d"] })
    recordWanted(root, `card:${card.id}`)
    const shown: string[] = []
    await popNext({
      ctx: { root, now: NOW }, settings: POPUP, log: () => {}, platform: "darwin", focus: off,
      show: async (c) => { shown.push(c.id); return { action: "dismiss" } },
    })
    expect(shown).toEqual([card.id])
  })

  it("holds in a call like in Focus: nothing shown, nothing marked", async () => {
    const card = oldCard({})
    const callFile = join(root, "call.json")
    writeFileSync(callFile, JSON.stringify({ active: true, source: "bridge", reason: "WhatsApp call" }))
    const r = await popNext({
      ctx: { root, now: NOW }, settings: POPUP, log: () => {}, platform: "darwin",
      focus: () => readHold(off, () => readCall(callFile, NOW)),
      show: async () => { throw new Error("must not show") },
    })
    expect(r).toBe("held")
    expect(readInboxState(root).popped?.[`card:${card.id}`]).toBeFalsy()
  })
})

describe("gate 2: notices", () => {
  it("holds a notice while the owner is in a call, and sends it when the call is over", async () => {
    const callFile = join(root, "call.json")
    const queue = new NotificationQueue(join(root, "held.json"))
    const sent: string[] = []
    const send = async (m: { message: string }) => { sent.push(m.message) }
    writeCallHold("on a call with Sam", 60_000, callFile, NOW)
    const held = await notify({ message: "Deploy done" }, send, { queue, alert: false, focus: readHold(off, () => readCall(callFile, NOW)) })
    expect(held).toMatchObject({ held: true, reason: "held — in a call" })
    expect(sent).toEqual([])
    const later = await notify({ message: "Deploy done" }, send, { queue, alert: false, focus: readHold(off, () => readCall(callFile, NOW + 61_000)) })
    expect(later.delivered).toBe(true)
  })

  it("an agent's notice over 120 / 300 characters is refused with the reason", () => {
    expect(noticeRuleBreak("AgentX", "short")).toBeNull()
    expect(noticeRuleBreak("x".repeat(121), "short")).toContain("title")
    expect(noticeRuleBreak("AgentX", "x".repeat(301))).toContain("300")
  })
})

describe("the call hold file", () => {
  it("the daemon writes and clears its own hold, and leaves another source's alone", () => {
    const f = join(root, "call.json")
    writeCallHold("the widget is busy", 60_000, f, NOW)
    expect(readCall(f, NOW)).toMatchObject({ active: true, mode: "call", reason: "in a call: the widget is busy" })
    writeCallHold(null, 60_000, f, NOW)
    expect(readCall(f, NOW).active).toBe(false)
    writeFileSync(f, JSON.stringify({ active: true, source: "bridge" }))
    writeCallHold(null, 60_000, f, NOW)
    expect(JSON.parse(readFileSync(f, "utf-8")).source).toBe("bridge")
  })

  it("a hold past its until is over", () => {
    const f = join(root, "call.json")
    writeCallHold("on a call", 60_000, f, NOW)
    expect(readCall(f, NOW + 60_001).active).toBe(false)
  })
})

describe("the rules themselves", () => {
  it("one question, lengths, choices", () => {
    expect(cardRuleBreak({ title: "t", ask: "Ship it?" })).toBeNull()
    expect(cardRuleBreak({ title: "t", ask: "Ship it, or wait until Monday?" })).toBeNull()
    expect(cardRuleBreak({ title: "t", ask: "Ship? Post?" })).toContain("one question")
  })
})

describe("a title says what it is in words", () => {
  const bare = [
    "#402", "PR #402", "group/project#402", "!57", "Merge !57",
    "https://git.example.com/group/project/-/issues/402",
    "01HZX3Q4V8K2M6N9P0R5S7T1W2", "req-lx2k9", "dlg-abc-1234", "snd-01HZX3Q4V8K2M6N9P0R5S7T1W2",
    "3f2a9c1", "Deploy 3f2a9c1d", "#402 #403", "#402: ok",
  ]
  it.each(bare)("refuses %j", (title) => {
    const why = referenceOnlyTitle(title)
    expect(why).toContain("title is only a reference")
    expect(why).toContain("plain words")
    expect(cardRuleBreak({ title, ask: "Ship it?" })).toBe(why)
    expect(noticeRuleBreak(title, "short")).toBe(why)
  })

  it("names the title and says how to fix it", () => {
    expect(referenceOnlyTitle("#402")).toBe('title is only a reference ("#402"); say what it is in plain words, and put the link in the body or source')
  })

  it.each([
    "Approve the login fix (#123)",
    "Core change waiting: group/project#12",
    "Deploy the fixes at 3f2a9c1",
    "Request req-lx2k9 is waiting",
    "AgentX", // no reference: a short plain title is left alone
    "Plan step 2: build",
    "Defaced effaced", // a-f words are not hashes
  ])("lets %j through", (title) => {
    expect(referenceOnlyTitle(title)).toBeNull()
    expect(cardRuleBreak({ title, ask: "Ship it?" })).toBeNull()
  })

  it("takes out only the references", () => {
    expect(stripReferences("Fix login (#12) at 3f2a9c1").replace(/\s+/g, " ").trim()).toBe("Fix login ( ) at")
  })

  it("refuses such a card when it is written", () => {
    expect(createCard(root, { ...BASE, title: "#402" }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringContaining("only a reference") })
  })
})

describe("the To do line on an agent's notice", () => {
  it("comes first, and says FYI when there is nothing to do", () => {
    expect(withTodo("Backups ran.")).toBe("To do: nothing, FYI\nBackups ran.")
    expect(withTodo("Backups ran.", "  ")).toBe("To do: nothing, FYI\nBackups ran.")
    expect(withTodo("The disk is full.", "free  some\nspace")).toBe("To do: free some space\nThe disk is full.")
  })

  it("counts toward the 300 characters", () => {
    const msg = "x".repeat(290)
    expect(noticeRuleBreak("Disk space", msg)).toBeNull()
    expect(noticeRuleBreak("Disk space", withTodo(msg))).toContain("300")
  })
})
