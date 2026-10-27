import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, decideCard, expireCards, listCards, type DecisionCard } from "../src/approvals/cards"
import { MAX_ADD_FAILURES, mirrorTally, readMirror, runMirror, tallyLine, type MirrorSettings } from "../src/approvals/mirror"
import { nextCardToPop } from "../src/approvals/popup-runner"
import { crossFieldProblems, daemonConfigSchema } from "../src/daemon/config"
import { macosTasks } from "../src/native/macos/tasks"
import { isMirrorTrailer, parseTrailer } from "../src/reminders/trailer"
import type { RequestRecord } from "../src/requests/store"
import { fakeRemindctl } from "./native/fake-remindctl"

// #1062 step 5: each waiting card and request becomes one reminder, closed
// when the item closes; a reminder the owner ticks off is never re-made.

const NOW = Date.parse("2030-03-01T08:00:00.000Z")
const SETTINGS: MirrorSettings = { enabled: true, list: "AgentX Desk", dueAfterMinutes: 5, include: ["card", "request"] }
const URL = "http://localhost:4202/approvals"

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-mirror-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function raise(extra: Record<string, unknown> = {}): DecisionCard {
  const r = createCard(root, {
    raised_by: "helper", title: "New meeting date", ask: "Which date?", recommend: "Thursday", if_silent: "keep",
    choices: ["Thursday", "Friday"], ...extra,
  }, { now: NOW })
  if (!r.ok) throw new Error(r.error)
  return r.card
}

function request(extra: Partial<RequestRecord> = {}): RequestRecord {
  return { id: "req-1", state: "waiting_owner", agentId: "coder", text: "Deploy the site", question: "Deploy now or tonight?", dueAt: null, ...extra } as RequestRecord
}

function setup(over: { requests?: RequestRecord[]; output?: ReturnType<typeof fakeRemindctl>; notify?: any; settings?: Partial<MirrorSettings> } = {}) {
  const output = over.output ?? fakeRemindctl()
  const notify = over.notify ?? vi.fn(async () => {})
  const logs: string[] = []
  const pass = (now = NOW) => runMirror({
    root,
    settings: { ...SETTINGS, ...over.settings },
    tasks: macosTasks("remindctl", output),
    cards: () => listCards(root, "pending"),
    requests: () => over.requests ?? [],
    answerUrl: URL,
    notify,
    log: (m) => logs.push(m),
    now,
  })
  return { output, notify, logs, pass }
}

describe("Reminders mirror (#1062)", () => {
  it("makes the list and one reminder per waiting card and request, once", async () => {
    const card = raise()
    const { output, pass } = setup({ requests: [request()] })
    expect(await pass()).toMatchObject({ created: 2 })
    expect(output.lists).toEqual(["AgentX Desk"])
    expect(output.items).toHaveLength(2)
    const r = output.items.find((i) => i.notes?.includes(`card=${card.id}`))!
    expect(r.title).toBe("New meeting date")
    expect(r.notes!.split("\n")).toEqual(["Which date?", "1. Thursday", "2. Friday", "Recommended: Thursday", `Answer: ${URL}`, `agentx: card=${card.id}`])
    expect(r.dueDate).toBe(new Date(NOW + 5 * 60_000).toISOString())
    const q = output.items.find((i) => i.notes?.includes("request=req-1"))!
    expect(q).toMatchObject({ title: "Deploy the site" })
    expect(q.notes!.split("\n")[0]).toBe("Deploy now or tonight?")

    expect(await pass(NOW + 60_000)).toMatchObject({ created: 0 })
    expect(output.items).toHaveLength(2)
  })

  it("is due no later than the card expires, and high priority within a day", async () => {
    raise({ expires: new Date(NOW + 2 * 60_000).toISOString() })
    const { output, pass } = setup()
    await pass()
    expect(output.items[0]).toMatchObject({ dueDate: new Date(NOW + 2 * 60_000).toISOString(), priority: "high" })
  })

  it("completes the reminder when the card is decided", async () => {
    const card = raise()
    const { output, pass } = setup()
    await pass()
    expect(decideCard(root, card.id, "yes", { by: "owner", choice: "Friday", now: NOW + 1000 }).ok).toBe(true)
    expect(await pass(NOW + 60_000)).toMatchObject({ completed: 1 })
    expect(output.items[0].isCompleted).toBe(true)
    expect(readMirror(root).items[`card:${card.id}`].state).toBe("completed")
  })

  it("completes the reminder when the card expires", async () => {
    raise({ expires: new Date(NOW + 10 * 60_000).toISOString() })
    const { output, pass } = setup()
    await pass()
    expireCards(root, NOW + 11 * 60_000)
    expect(await pass(NOW + 11 * 60_000)).toMatchObject({ completed: 1 })
    expect(output.items[0].isCompleted).toBe(true)
  })

  it("completes the request's reminder when it stops waiting on the owner", async () => {
    const reqs = [request()]
    const { output, pass } = setup({ requests: reqs })
    await pass()
    reqs[0] = request({ state: "in_progress" })
    expect(await pass(NOW + 60_000)).toMatchObject({ completed: 1 })
    expect(output.items[0].isCompleted).toBe(true)
  })

  it("never re-makes a reminder the owner ticked off, and the card stays pending", async () => {
    const card = raise()
    const { output, pass } = setup()
    await pass()
    output.items[0].isCompleted = true
    expect(await pass(NOW + 60_000)).toMatchObject({ dismissed: 1, created: 0 })
    expect(await pass(NOW + 120_000)).toMatchObject({ created: 0 })
    expect(output.items).toHaveLength(1)
    expect(listCards(root, "pending").map((c) => c.id)).toEqual([card.id])
  })

  it("closes nothing when the list can't be read", async () => {
    raise()
    const { output, pass } = setup()
    await pass()
    const broken = Object.assign(async () => { throw new Error("not allowed") }, { items: [], lists: [] }) as any
    const second = setup({ output: broken })
    expect(await second.pass(NOW + 60_000)).toMatchObject({ completed: 0, dismissed: 0 })
    expect(Object.values(readMirror(root).items)[0].state).toBe("open")
    expect(readMirror(root).lastError?.message).toMatch(/not allowed/)
    expect(output.items).toHaveLength(1)
  })

  it("tells the owner once after three failed adds, then stops trying that item", async () => {
    raise()
    raise({ title: "Another" })
    const failing = Object.assign(async (_f: string, args: string[]) => {
      if (args[0] === "list") return "[]"
      throw new Error("Reminders access denied")
    }, { items: [], lists: [] }) as any
    const { notify, pass } = setup({ output: failing })
    for (let i = 0; i < MAX_ADD_FAILURES + 2; i++) await pass(NOW + i * 60_000)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][0]).toBe("Could not add to Reminders")
    expect(notify.mock.calls[0][1]).toMatch(/and 1 more.*access denied.*Still on the Desk/)
    expect(Object.values(readMirror(root).items)[0]).toMatchObject({ state: "failed", failures: MAX_ADD_FAILURES })
    // A card raised later that fails the same way is not told again the same day.
    raise({ title: "Third" })
    for (let i = 0; i < MAX_ADD_FAILURES; i++) await pass(NOW + (10 + i) * 60_000)
    expect(notify).toHaveBeenCalledOnce()
  })

  it("falls back to the popup, and says so, when Reminders access is denied on a new install", async () => {
    const card = raise()
    const denied = Object.assign(async () => { throw new Error("remindctl list: Reminders access denied") }, { items: [], lists: [] }) as any
    const { logs, pass } = setup({ output: denied })
    expect(await pass()).toMatchObject({ created: 0, failed: 1 })
    expect(nextCardToPop({ root, now: NOW + 60_000 })?.id).toBe(card.id)
    expect(logs.join("\n")).toMatch(/1 card\(s\) could not be added to Reminders; the Mac popup shows them instead/)
  })

  it("does not try each add once the list can't be made (a prompt nobody answers times out)", async () => {
    raise()
    raise({ title: "Another" })
    const calls: string[] = []
    const hung = Object.assign(async (_f: string, args: string[]) => { calls.push(args[0]); throw new Error("remindctl list: timed out") }, { items: [], lists: [] }) as any
    const { pass } = setup({ output: hung })
    expect(await pass()).toMatchObject({ failed: 2 })
    expect(calls).toEqual(["list"])
    expect(Object.values(readMirror(root).items).every((e) => e.state === "failed" && e.lastError?.includes("timed out"))).toBe(true)
    expect(nextCardToPop({ root, now: NOW + 60_000 })).not.toBeNull()
  })

  it("mirrors only what include names", async () => {
    raise()
    const { output, pass } = setup({ requests: [request()], settings: { include: ["request"] } })
    expect(await pass()).toMatchObject({ created: 1 })
    expect(output.items[0].notes).toContain("request=req-1")
  })

  it("keeps the Mac popup off cards while the mirror runs, and gives them back when it stops", async () => {
    const card = raise()
    expect(nextCardToPop({ root, now: NOW })?.id).toBe(card.id)
    await setup().pass()
    expect(nextCardToPop({ root, now: NOW })).toBeNull()
    // A card raised after the last pass is covered too: it gets its task next pass.
    const later = raise({ title: "Second" })
    expect(nextCardToPop({ root, now: NOW + 60_000 })).toBeNull()
    // Turned off (no pass for longer than 5 minutes): the popup is back.
    expect(nextCardToPop({ root, now: NOW + 6 * 60_000 })?.id).toBeDefined()
    expect([card.id, later.id]).toContain(nextCardToPop({ root, now: NOW + 6 * 60_000 })!.id)
  })

  it("gives the popup back when the list can't be read", async () => {
    raise()
    await setup().pass()
    const broken = Object.assign(async () => { throw new Error("not allowed") }, { items: [], lists: [] }) as any
    await setup({ output: broken }).pass(NOW + 4 * 60_000)
    expect(nextCardToPop({ root, now: NOW + 6 * 60_000 })).not.toBeNull()
  })

  it("does not cover cards when only requests are mirrored", async () => {
    const card = raise()
    await setup({ settings: { include: ["request"] } }).pass()
    expect(nextCardToPop({ root, now: NOW })?.id).toBe(card.id)
  })

  it("closes nothing when what is waiting can't be read", async () => {
    raise()
    const { output, pass } = setup({ requests: [request()] })
    await pass()
    const logs: string[] = []
    const r = await runMirror({
      root, settings: SETTINGS, tasks: macosTasks("remindctl", output), cards: () => listCards(root, "pending"),
      requests: () => { throw new Error("the requests database is not open") }, answerUrl: URL, notify: async () => {}, log: (m) => logs.push(m), now: NOW + 60_000,
    })
    expect(r).toEqual({ created: 0, completed: 0, dismissed: 0, failed: 0 })
    expect(output.items.every((i) => !i.isCompleted)).toBe(true)
  })
})

describe("the trial count (#1062)", () => {
  const DAY = 24 * 3_600_000

  it("counts cards raised, Reminders created and cards missed in the window", async () => {
    const mirrored = raise()
    const { pass } = setup({ requests: [request()] })
    await pass(NOW + 60_000)
    // Closed within 5 minutes, before any pass: apart, not a miss.
    const fast = createCard(root, { raised_by: "helper", title: "Quick", ask: "?", recommend: "Yes", if_silent: "keep" }, { now: NOW + 2 * 60_000 })
    if (!fast.ok) throw new Error(fast.error)
    decideCard(root, fast.card.id, "yes", { by: "owner", now: NOW + 3 * 60_000 })
    // Still pending, never mirrored, raised long ago: a miss.
    const lost = createCard(root, { raised_by: "helper", title: "Lost", ask: "?", recommend: "Yes", if_silent: "keep" }, { now: NOW + 4 * 60_000 })
    if (!lost.ok) throw new Error(lost.error)

    const t = mirrorTally(root, listCards(root), NOW, NOW + DAY, NOW + 2 * 3_600_000)
    expect(t).toMatchObject({ raised: 3, created: { cards: 1, requests: 1 }, closedFast: 1, tooNew: 0 })
    expect(t.missed.map((m) => m.id)).toEqual([lost.card.id])
    expect(t.missed.map((m) => m.id)).not.toContain(mirrored.id)
    expect(tallyLine(t)).toBe("cards raised 3 / Reminders created 2 (1 cards, 1 requests) / missed 1 · closed within 5 min: 1")
  })

  it("does not count a card raised in the last 5 minutes as missed", () => {
    raise()
    const t = mirrorTally(root, listCards(root), NOW, NOW + DAY, NOW + 60_000)
    expect(t).toMatchObject({ raised: 1, tooNew: 1 })
    expect(t.missed).toEqual([])
  })

  it("names why a card was missed when its add failed", async () => {
    raise()
    const failing = Object.assign(async (_f: string, args: string[]) => {
      if (args[0] === "list") return "[]"
      throw new Error("Reminders access denied")
    }, { items: [], lists: [] }) as any
    await setup({ output: failing }).pass()
    const t = mirrorTally(root, listCards(root), NOW, NOW + DAY, NOW + 3_600_000)
    expect(t.missed[0].reason).toMatch(/could not be added \(1x\).*access denied/)
  })

  it("leaves out what falls outside the window", async () => {
    raise()
    await setup().pass()
    expect(mirrorTally(root, listCards(root), NOW + DAY, NOW + 2 * DAY, NOW + 2 * DAY)).toMatchObject({ raised: 0, created: { cards: 0, requests: 0 }, missed: [] })
  })
})

describe("the mirror's loop guard", () => {
  it("marks mirrored reminders so check-ins and the hand-back skip them", () => {
    expect(isMirrorTrailer("Which date?\nagentx: card=2030-03-01-x-ab12")).toBe(true)
    expect(isMirrorTrailer("agentx: request=req-1\n")).toBe(true)
    expect(isMirrorTrailer("Retry deploy\nagentx: agent=coder context=telegram:42")).toBe(false)
    expect(isMirrorTrailer("card=1 is mentioned here\nnot a trailer")).toBe(false)
    expect(parseTrailer("agentx: card=abc")).toBeNull()
  })

  it("refuses a mirror list that check-ins or the hand-back also read", () => {
    const base = { node: { id: "n", name: "n" } }
    const parse = (extra: object) => daemonConfigSchema.parse({ ...base, ...extra })
    expect(crossFieldProblems(parse({ native: { mirror: { enabled: true } } }))).toEqual([])
    expect(crossFieldProblems(parse({ native: { mirror: { enabled: true, list: "AgentX" } } })).join(" ")).toMatch(/reminders.lists/)
    expect(crossFieldProblems(parse({ native: { mirror: { enabled: true, list: "Reminders" } } })).join(" ")).toMatch(/approvals.checkin.lists/)
    expect(crossFieldProblems(parse({ native: { mirror: { enabled: false, list: "AgentX" } } }))).toEqual([])
    expect(daemonConfigSchema.safeParse({ ...base, native: { mirror: { list: "-x" } } }).success).toBe(false)
  })

  it("is off by default, on the list AgentX Desk, due after 5 minutes", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.native.mirror).toEqual({ enabled: false, list: "AgentX Desk", dueAfterMinutes: 5, include: ["card", "request"] })
  })
})
