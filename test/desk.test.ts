import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Readable } from "stream"
import Database from "better-sqlite3"
import { createCard, readCard } from "../src/approvals/cards"
import { readInboxState } from "../src/approvals/state"
import type { InboxItem } from "../src/approvals/inbox"
import { RequestStore } from "../src/requests/store"
import { buildDesk, inboxOptions, figures, type DeskRequest, type DeskSource, type DeskTask } from "../src/desk/card"
import { deskAct, parseDeskAct } from "../src/desk/act"
import { readDeskSource } from "../src/desk/read"
import { handleAppDesk, resetDeskCache, withLastGood, deskTasks, type AppDeskDeps } from "../src/daemon/app-desk"
import { handleDeskPanel, callMessage } from "../src/daemon/desk-panel"
import { CallStore } from "../src/calls/store"
import { CallService } from "../src/calls/service"
import { handleCalls } from "../src/daemon/calls-api"
import { callsSchema } from "../src/daemon/config"

// The owner's desk (#959): one card shape over every source, a column
// computed from the source each time, four actions, and the phone routes.

const NOW = Date.parse("2026-01-05T12:00:00Z")
const HOUR = 3_600_000
const A = "http://node-a:18800"

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    key: "card:c1", kind: "card", title: "Spring newsletter is ready", ask: "Send it to the subscribers?",
    yes: "tell writer yes", no: "tell writer no", raised_by: "writer", created_at: "2026-01-05T09:00:00Z",
    expires: "2026-01-08T09:00:00Z", ...over,
  }
}

function req(over: Partial<DeskRequest> = {}): DeskRequest {
  return {
    id: "req-1", state: "in_progress", agentId: "coder", summary: "Build the weekly report", question: null,
    attentionReason: null, createdAt: NOW - 10 * HOUR, updatedAt: NOW - 10 * HOUR, closedAt: null, evidence: null,
    closeReason: null, runs: ["t-1"], cards: [], lastAnswer: null, plan: null, ...over,
  }
}

function source(over: Partial<DeskSource> = {}): DeskSource {
  return { items: [], requests: [], closedCards: [], deferred: {}, ...over }
}

const task = (id: string, over: Partial<DeskTask> = {}): DeskTask =>
  ({ node: A, nodeName: "studio", taskId: id, agentId: "coder", preview: "working on it", startedAt: "2026-01-05T11:50:00Z", ...over })

const desk = (src: DeskSource, tasks: DeskTask[] = [], extra: Partial<Parameters<typeof buildDesk>[0][number]> = {}) =>
  buildDesk([{ node: A, nodeName: "studio", source: src, ...extra }], tasks, { now: NOW, quietHours: 3 })

describe("cards and columns", () => {
  it("puts every pending inbox item in Your turn, each option with its effect", () => {
    const d = desk(source({ items: [item({ choices: ["Send today", "Send Monday"], draft: "Going out {choice}" })] }))
    const c = d.cards[0]
    expect(c).toMatchObject({ key: "card:c1", column: "yours", actor: "owner", agent: "writer", expiresAt: "2026-01-08T09:00:00Z" })
    expect(c.options.map((o) => o.id)).toEqual(["1", "2", "no"])
    expect(c.options[0].means).toBe('writer is told yes, with "Send today", and gets the message below.')
    expect(c.options[2].means).toBe("Tell writer no.")
    expect(c.text?.draft).toBe("Going out {choice}")
    expect(c.actions).toEqual(["answer", "defer", "call"])
  })

  it("offers yes and no in the source's own words when there are no choices", () => {
    expect(inboxOptions(item({ kind: "schedule", yes: "create the schedule", no: "drop the request" })))
      .toEqual([{ id: "yes", label: "Yes", means: "Create the schedule." }, { id: "no", label: "No", means: "Drop the request." }])
  })

  it("shows a request With an agent only with proof of work", () => {
    const live = desk(source({ requests: [req()] }), [task("t-1")])
    expect(live.cards).toHaveLength(1)
    expect(live.cards[0]).toMatchObject({ key: "request:req-1", column: "agent", actor: "agent" })
    // The run that proves it is not shown again as its own card.
    const recent = desk(source({ requests: [req({ runs: [], updatedAt: NOW - HOUR })] }))
    expect(recent.cards[0].column).toBe("agent")
    const quiet = desk(source({ requests: [req({ runs: ["t-old"] })] }), [task("t-other")])
    expect(quiet.cards.find((c) => c.key === "request:req-1")).toMatchObject({ column: "quiet", actor: "nobody" })
    expect(quiet.cards.find((c) => c.key === "task:t-other")).toMatchObject({ column: "agent" })
  })

  it("uses the quiet limit it is given", () => {
    const r = req({ runs: [], updatedAt: NOW - 2 * HOUR })
    expect(buildDesk([{ node: A, nodeName: "studio", source: source({ requests: [r] }) }], [], { now: NOW, quietHours: 1 }).cards[0].column).toBe("quiet")
    expect(buildDesk([{ node: A, nodeName: "studio", source: source({ requests: [r] }) }], [], { now: NOW, quietHours: 3 }).cards[0].column).toBe("agent")
  })

  it("shows a question asked through a decision card once, as that card", () => {
    const d = desk(source({ items: [item()], requests: [req({ state: "waiting_owner", question: "Send it?", cards: ["c1"] })] }))
    expect(d.cards.map((c) => c.key)).toEqual(["card:c1"])
  })

  it("makes an agent's open question a card the owner writes an answer to", () => {
    const c = desk(source({ requests: [req({ state: "waiting_owner", question: "Which week?" })] })).cards[0]
    expect(c).toMatchObject({ column: "yours", ask: "Which week?", options: [], actions: ["write", "defer", "call"] })
    expect(c.text?.required).toBe(true)
  })

  it("replaces the inbox's request item with the request's own card", () => {
    const d = desk(source({
      items: [item({ key: "request:req-1", kind: "request", raised_by: "coder" })],
      requests: [req({ state: "needs_attention", attentionReason: "Task timed out" })],
    }))
    expect(d.cards).toHaveLength(1)
    expect(d.cards[0]).toMatchObject({ key: "request:req-1", column: "yours", attention: true })
    expect(d.cards[0].options.map((o) => o.id)).toEqual(["yes", "no"])
    expect(d.cards[0].facts).toContain("Task timed out")
  })

  it("keeps finished sources in Done for seven days, with the outcome", () => {
    const d = desk(source({
      requests: [
        req({ id: "req-2", state: "done", closedAt: NOW - HOUR, evidence: "https://example.com/pr/1" }),
        req({ id: "req-3", state: "dropped", closedAt: NOW - 8 * 24 * HOUR }),
      ],
      closedCards: [{ id: "c9", title: "Old card", raisedBy: "writer", status: "expired", outcome: "discard", createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-01-04T00:00:00Z" }],
    }))
    expect(d.cards.map((c) => c.key)).toEqual(["request:req-2", "card:c9"])
    expect(d.cards[0]).toMatchObject({ column: "done", outcome: { word: "done", detail: "https://example.com/pr/1" } })
    expect(d.cards[1].outcome).toEqual({ word: "expired", detail: "nobody answered; default: discard" })
  })

  it("never shows running work from a machine it could not read", () => {
    const d = desk(source({ requests: [req({ runs: [], updatedAt: NOW - HOUR })] }), [], { staleSince: "2026-01-05T11:00:00Z" })
    expect(d.cards[0]).toMatchObject({ column: "quiet", staleSince: "2026-01-05T11:00:00Z" })
  })

  it("folds deferred cards until they come due", () => {
    const d = desk(source({
      items: [item(), item({ key: "card:c2", created_at: "2026-01-05T08:00:00Z" }), item({ key: "card:c3" })],
      deferred: { "card:c2": "2026-01-06T00:00:00Z", "card:c3": "2026-01-05T11:00:00Z" },
    }))
    const byKey = Object.fromEntries(d.cards.map((c) => [c.key, c]))
    expect(byKey["card:c2"].deferredUntil).toBe("2026-01-06T00:00:00Z")
    expect(byKey["card:c3"].deferredUntil).toBeUndefined()
    expect(d.cards.at(-1)!.key).toBe("card:c2")
    expect(d.figures.yours.count).toBe(2)
    expect(d.figures.deferred).toBe(1)
  })

  it("counts and names the main blockers", () => {
    const d = desk(source({
      items: [item(), item({ key: "card:c0", title: "Oldest question", created_at: "2026-01-02T00:00:00Z" })],
      requests: [req({ id: "req-q", summary: "Gone quiet", updatedAt: NOW - 30 * HOUR, runs: [] }), req({ id: "req-a", state: "needs_attention", updatedAt: NOW - 2 * HOUR })],
    }), [task("t-free")])
    expect(d.figures.yours).toMatchObject({ count: 3, oldest: { key: "card:c0", title: "Oldest question" } })
    expect(d.figures.agent.count).toBe(1)
    expect(d.figures.stuck).toMatchObject({ count: 2, oldest: { key: "request:req-q" } })
    expect(figures([]).yours.oldest).toBeUndefined()
  })

  it("reports a machine that failed and keeps the rest", () => {
    const d = buildDesk([
      { node: A, nodeName: "studio", source: source({ items: [item()] }) },
      { node: "http://node-b:18800", nodeName: "attic", source: null, error: "unreachable" },
    ], [], { now: NOW })
    expect(d.cards).toHaveLength(1)
    expect(d.errors).toEqual([{ node: "http://node-b:18800", nodeName: "attic", error: "unreachable" }])
  })
})

describe("actions", () => {
  let root: string
  let db: Database.Database
  let store: RequestStore
  let requestsOn: boolean
  const calls: Array<{ agent: string; reason: string }> = []

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agentx-desk-"))
    db = new Database(":memory:")
    store = new RequestStore(db)
    requestsOn = true
    calls.length = 0
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const ctx = () => {
    const configPath = path.join(root, "agentx.json")
    writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: { writer: {}, coder: {} }, requests: { enabled: requestsOn } }))
    return { root, requests: store, now: NOW, configPath }
  }
  const deps = { by: "operator (phone: Test phone)", laterHours: 24, callAgent: async (agent: string, reason: string) => { calls.push({ agent, reason }); return { ok: true as const, message: `${agent} is calling` } } }
  const newCard = (extra: Record<string, unknown> = {}) => {
    const r = createCard(root, { title: "Spring newsletter", ask: "Send it?", recommend: "Send it: the offer ends Friday", if_silent: "keep", raised_by: "writer", ...extra }, { now: NOW })
    if (!r.ok) throw new Error(r.error)
    return r.card
  }
  const request = (state: "waiting_owner" | "needs_attention" | "in_progress") => {
    store.addCandidate({ id: "req-t1", runId: "t1", channel: "app", chatId: "me", agentId: "coder", text: "Build the weekly report", now: NOW - HOUR })
    store.progress("req-t1", NOW - HOUR)
    if (state === "waiting_owner") store.waitOnOwner("req-t1", "Which week?", NOW - HOUR)
    if (state === "needs_attention") store.needsAttention("req-t1", "Task timed out", NOW - HOUR)
    return "req-t1"
  }

  it("answers a card with one of its choices, recorded in the card", async () => {
    const c = newCard({ choices: ["Send today", "Send Monday"], draft: "Going out {choice}" })
    const r = await deskAct(ctx(), { key: `card:${c.id}`, action: "answer", option: "2", text: "Going out Monday, 9:00" }, deps)
    expect(r).toMatchObject({ ok: true })
    expect(readCard(root, c.id)).toMatchObject({ status: "decided", verdict: "yes", choice: "Send Monday", text: "Going out Monday, 9:00", decided_by: "operator (phone: Test phone)" })
  })

  it("keeps the owner's words with a plain answer as a note", async () => {
    const c = newCard()
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "answer", option: "no", text: "Not this month" }, deps)).toMatchObject({ ok: true })
    expect(readCard(root, c.id)).toMatchObject({ verdict: "no", note: "Not this month" })
  })

  it("refuses a card that is no longer waiting, and an option it does not have", async () => {
    const c = newCard()
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "answer", option: "maybe" }, deps)).toMatchObject({ ok: false, status: 400 })
    await deskAct(ctx(), { key: `card:${c.id}`, action: "answer", option: "yes" }, deps)
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "answer", option: "no" }, deps)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("not waiting any more") })
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "defer" }, deps)).toMatchObject({ ok: false, status: 409 })
  })

  it("writes an answer to a request: its agent goes on with it", async () => {
    const id = request("waiting_owner")
    expect(await deskAct(ctx(), { key: `request:${id}`, action: "write", text: "The week of the 12th" }, deps)).toMatchObject({ ok: true })
    expect(store.get(id)).toMatchObject({ state: "in_progress", ownerNote: "The week of the 12th", question: null })
  })

  it("says nothing is passed on while requests are off", async () => {
    const id = request("waiting_owner")
    requestsOn = false
    expect(await deskAct(ctx(), { key: `request:${id}`, action: "write", text: "Yes" }, deps)).toMatchObject({ ok: false, status: 409 })
    expect(store.get(id)!.state).toBe("waiting_owner")
  })

  it("refuses a written answer on a card with options", async () => {
    const c = newCard()
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "write", text: "hmm" }, deps)).toMatchObject({ ok: false, status: 400 })
  })

  it("hands a request that needs attention back, or drops it", async () => {
    const id = request("needs_attention")
    expect(await deskAct(ctx(), { key: `request:${id}`, action: "answer", option: "yes", text: "Use last week's numbers" }, deps)).toMatchObject({ ok: true })
    expect(store.get(id)).toMatchObject({ state: "in_progress", ownerNote: "Use last week's numbers" })
    store.needsAttention(id, "Quiet again", NOW)
    expect(await deskAct(ctx(), { key: `request:${id}`, action: "answer", option: "no" }, deps)).toMatchObject({ ok: true })
    expect(store.get(id)!.state).toBe("dropped")
  })

  it("defers a card and an agent's open question into the same Later state", async () => {
    const c = newCard()
    const id = request("waiting_owner")
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "defer" }, deps)).toMatchObject({ ok: true })
    expect(await deskAct(ctx(), { key: `request:${id}`, action: "defer" }, deps)).toMatchObject({ ok: true })
    const snoozed = readInboxState(root).snoozed
    expect(Object.keys(snoozed).sort()).toEqual([`card:${c.id}`, `request:${id}`])
    expect(readCard(root, c.id)!.status).toBe("pending")
    const src = readDeskSource(ctx())
    const d = buildDesk([{ node: A, nodeName: "studio", source: src }], [], { now: NOW })
    expect(d.cards.filter((x) => x.column === "yours").every((x) => !!x.deferredUntil)).toBe(true)
  })

  it("calls the agent that owns the card, with the card in the reason", async () => {
    const c = newCard()
    expect(await deskAct(ctx(), { key: `card:${c.id}`, action: "call" }, deps)).toMatchObject({ ok: true })
    expect(calls[0]).toEqual({ agent: "writer", reason: `The owner asks about card:${c.id}: Spring newsletter` })
    expect(await deskAct(ctx(), { key: "task:t9", action: "call" }, deps)).toMatchObject({ ok: false, status: 400 })
    expect(await deskAct(ctx(), { key: "task:t9", action: "call", agent: "coder" }, deps)).toMatchObject({ ok: true })
    expect(calls[1].agent).toBe("coder")
  })

  it("reads this machine's sources in bounded form", () => {
    newCard()
    request("in_progress")
    const src = readDeskSource(ctx())
    expect(src.items).toHaveLength(1)
    expect(src.requests[0]).toMatchObject({ id: "req-t1", state: "in_progress", runs: ["t1"], summary: "Build the weekly report" })
  })

  it("parses the act body", () => {
    expect(parseDeskAct({ key: "card:a", action: "answer", option: 2, text: "  hi " })).toEqual({ key: "card:a", action: "answer", option: "2", text: "hi" })
    expect(parseDeskAct({ key: "card:a", action: "approve" })).toMatch(/send \{ key, action/)
  })

  it("serves the desk and its actions on the admin route, naming the phone", async () => {
    const c = newCard()
    const got = await handleDeskPanel("GET", "/api/admin/approvals/desk", {}, ctx())
    expect((got.body as DeskSource).items[0].key).toBe(`card:${c.id}`)
    const r = await handleDeskPanel("POST", "/api/admin/approvals/desk/act", { key: `card:${c.id}`, action: "answer", option: "yes", by: "operator (phone: Test phone)" }, ctx())
    expect(r.status).toBe(200)
    expect(readCard(root, c.id)!.decided_by).toBe("operator (phone: Test phone)")
    const c2 = newCard({ title: "Second" })
    await handleDeskPanel("POST", "/api/admin/approvals/desk/act", { key: `card:${c2.id}`, action: "answer", option: "yes", by: "agent pretending" }, ctx())
    expect(readCard(root, c2.id)!.decided_by).toBe("operator (dashboard)")
  })
})

describe("phone routes", () => {
  beforeEach(() => resetDeskCache())

  async function call(d: AppDeskDeps, method: string, p: string, body?: unknown) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
    req.url = p
    let status = 0
    let out = ""
    const res: any = { writeHead: (s: number) => { status = s }, end: (b: string) => { out = b } }
    const handled = await handleAppDesk(req, res, p, method, "Test phone", d)
    return { handled, status, body: out ? JSON.parse(out) : undefined }
  }

  const deps = (over: Partial<AppDeskDeps> = {}): AppDeskDeps => ({
    snapshot: vi.fn(async () => ({ ts: "", nodes: [] })),
    sources: vi.fn(async () => [{ node: A, nodeName: "studio", source: source({ items: [item()] }) }]),
    act: vi.fn(async () => ({ status: 200, body: { ok: true, message: "done" } })),
    quietHours: () => 3,
    now: () => NOW,
    ...over,
  })

  it("serves one desk with figures", async () => {
    const r = await call(deps(), "GET", "/api/app/desk")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ quietHours: 3, figures: { yours: { count: 1 } }, errors: [] })
    expect(r.body.cards[0].key).toBe("card:c1")
  })

  it("keeps a machine's last known cards when it stops answering", async () => {
    const d = deps()
    await call(d, "GET", "/api/app/desk")
    d.sources = vi.fn(async () => [{ node: A, nodeName: "studio", error: "timeout" }])
    const r = await call(d, "GET", "/api/app/desk")
    expect(r.body.cards[0]).toMatchObject({ key: "card:c1", staleSince: new Date(NOW).toISOString() })
    expect(r.body.errors).toEqual([{ node: A, nodeName: "studio", error: "timeout" }])
    expect(withLastGood({ node: "http://never:1", nodeName: "x", error: "down" }, NOW)).toMatchObject({ source: null, error: "down" })
  })

  it("takes running turns only from machines with live data", () => {
    const running = [{ id: "t1", messagePreview: "x", channel: "app", startedAt: "2026-01-05T11:00:00Z" }]
    const agents = [{ id: "coder", name: "Coder", active: 1, errors: 0, runningTasks: running }]
    expect(deskTasks([
      { id: A, name: "studio", url: A, reachable: true, agents },
      { id: "b", name: "attic", url: "http://b", reachable: true, stale: true, agents },
    ])).toEqual([{ node: A, nodeName: "studio", taskId: "t1", agentId: "coder", agentName: "Coder", preview: "x", startedAt: "2026-01-05T11:00:00Z" }])
  })

  it("acts on the machine the card lives on, as the phone", async () => {
    const d = deps()
    const r = await call(d, "POST", "/api/app/desk/act", { node: A, key: "card:c1", action: "answer", option: "yes" })
    expect(r.status).toBe(200)
    expect(d.act).toHaveBeenCalledWith(A, { key: "card:c1", action: "answer", option: "yes" }, "operator (phone: Test phone)")
    expect((await call(d, "POST", "/api/app/desk/act", { key: "card:c1", action: "answer" })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/desk/act", { node: A, key: "card:c1", action: "approve" })).status).toBe(400)
    expect((await call(d, "GET", "/api/app/other")).handled).toBe(false)
  })
})

describe("the owner asks an agent to call", () => {
  let calls: CallService
  let notices: string[]
  beforeEach(() => {
    notices = []
    calls = new CallService({
      store: new CallStore(new Database(":memory:")),
      config: () => callsSchema.parse({ allow: ["writer"] }),
      agentName: (id) => ({ writer: "Writer", ops: "Ops" } as Record<string, string>)[id] ?? null,
      isRunningTurn: () => false,
      alert: async (n) => { notices.push(n.title) },
      focus: () => ({ active: false, mode: null, reason: "off" }),
      now: () => NOW,
    })
  })

  it("rings without a running turn, once for the same ask", async () => {
    const first = await calls.ownerAsks({ agentId: "writer", reason: "The owner asks about card:c1: Newsletter" })
    expect(first).toMatchObject({ ok: true, rang: "notify" })
    const again = await calls.ownerAsks({ agentId: "writer", reason: "The owner asks about card:c1: Newsletter" })
    expect(again).toMatchObject({ ok: true, again: true })
    expect(notices).toHaveLength(1)
  })

  it("keeps the calls allow list", async () => {
    expect(await calls.ownerAsks({ agentId: "ops", reason: "x" })).toMatchObject({ ok: false, status: 403 })
    expect(await calls.ownerAsks({ agentId: "nobody", reason: "x" })).toMatchObject({ ok: false, status: 404 })
  })

  it("answers on /calls/owner only for the owner's own surface", async () => {
    const body = { agentId: "writer", reason: "About a card" }
    const denied = await handleCalls(calls, () => callsSchema.parse({ allow: ["writer"] }), "POST", "/calls/owner", new URLSearchParams(), body, {}, false)
    expect(denied.status).toBe(403)
    const ok = await handleCalls(calls, () => callsSchema.parse({ allow: ["writer"] }), "POST", "/calls/owner", new URLSearchParams(), body, {}, true)
    expect(ok.status).toBe(201)
    const again = await handleCalls(calls, () => callsSchema.parse({ allow: ["writer"] }), "POST", "/calls/owner", new URLSearchParams(), body, {}, true)
    expect(again).toMatchObject({ status: 200, body: { again: true } })
  })

  it("says what happened to the call", () => {
    expect(callMessage("writer", { again: true })).toBe("writer is already calling you about this")
    expect(callMessage("writer", { rang: false, call: { note: "Focus: work" } })).toBe("writer will call you: Focus: work, so it waits as a missed call")
  })
})
