import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore } from "../src/calls/store"
import { CallService, WIDGET_FRESH_MS, openerPrompt, type CallDeps, type PhoneRing } from "../src/calls/service"
import { askedByOwner, attachCallbacks, callbackBrief, wantsCallback, OWNER_CHANNELS } from "../src/calls/callback"
import { callsSchema, type CallsConfig } from "../src/daemon/config"
import { OWNER_BY, RequestStore, type RequestRecord } from "../src/requests/store"
import { handleCalls } from "../src/daemon/calls-api"

// The agent calls the owner back when a long request he asked for is
// done, waits on him or needs him (#2265).

type Notice = { title: string; message: string; urgent: boolean; from: string; ring?: PhoneRing }

const MIN = 60_000
let now: number
let cfg: CallsConfig
let notices: Notice[]
let inFocus: boolean
let logs: string[]
let callStore: CallStore
let calls: CallService
let requests: RequestStore

beforeEach(() => {
  now = 10_000_000
  cfg = callsSchema.parse({})
  notices = []
  inFocus = false
  logs = []
  const db = new Database(":memory:")
  callStore = new CallStore(db)
  requests = new RequestStore(db)
  const deps: CallDeps = {
    store: callStore,
    config: () => cfg,
    agentName: (id) => ({ coder: "Coder", ops: "Ops" } as Record<string, string>)[id] ?? null,
    isRunningTurn: () => false,
    alert: async (n) => { notices.push(n) },
    focus: () => ({ active: inFocus, mode: null, reason: inFocus ? "on" : "off" }),
    callbackBrief: (ref) => {
      const r = requests.get(ref.id)
      return r ? callbackBrief(r, ref.state) : null
    },
    callbackAnswered: (call) => { for (const ref of call.about ?? []) requests.markNotified(ref.id, now) },
    now: () => now,
    log: (m) => logs.push(m),
  }
  calls = new CallService(deps)
  attachCallbacks(requests, { calls: () => calls, config: () => cfg, now: () => now, log: (m) => logs.push(m) })
})

let seq = 0
/** An open request, asked `ago` minutes before now. */
function ask(opts: { channel?: string; text?: string; ago?: number; agentId?: string; sender?: string } = {}): string {
  const id = `req-${++seq}`
  const at = now - (opts.ago ?? 10) * MIN
  requests.addCandidate({
    id, runId: `run-${seq}`, channel: opts.channel ?? "voice", chatId: `chat-${seq}`, sender: opts.sender ?? "Anis",
    agentId: opts.agentId ?? "coder", text: opts.text ?? "Fix the login page", now: at,
  })
  requests.progress(id, at)
  return id
}

/** Hooks fire the call without waiting: let it settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))
const callbacks = () => callStore.list({ limit: 200 }).filter((c) => c.origin === "callback")
const rings = () => notices.filter((n) => n.ring?.state === "ringing")

describe("call-back settings", () => {
  it("defaults: on, 3 minutes, quiet in Focus", () => {
    expect(callsSchema.parse({}).callback).toEqual({ enabled: true, afterMinutes: 3, quietWhenFocus: true })
  })
})

describe("who asked (C4)", () => {
  const rec = (channel: string, extra: Partial<RequestRecord> = {}) =>
    ({ channel, sender: "Anis", promise: false, standing: null, ...extra }) as RequestRecord

  it.each(["voice", "dashboard", "app", "webrtc", "telegram", "whatsapp"])("the owner's own %s counts", (ch) => {
    expect(OWNER_CHANNELS.has(ch)).toBe(true)
    expect(askedByOwner(rec(ch))).toBe(true)
  })

  it.each(["a2a", "cron", "schedule", "github", "gitlab", "requests", "mesh"])("%s never calls back", (ch) => {
    expect(askedByOwner(rec(ch))).toBe(false)
  })

  it("an agent's promise, a standing order and the daemon's camera sender are not his asks", () => {
    expect(askedByOwner(rec("voice", { promise: true }))).toBe(false)
    expect(askedByOwner(rec("voice", { standing: { number: "n" } as any }))).toBe(false)
    expect(askedByOwner(rec("app", { sender: "camera" }))).toBe(false)
  })

  it("a channel with an account suffix still counts (telegram@work)", () => {
    expect(askedByOwner(rec("telegram@work"))).toBe(true)
  })
})

describe("when it calls back", () => {
  it("a short request does not call", async () => {
    const id = ask({ ago: 1 })
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks()).toEqual([])
  })

  it("a long request the owner asked for calls once, as a voice call that rings the phone", async () => {
    await calls.ringing()
    const id = ask({ ago: 10 })
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    const [c] = callbacks()
    expect(c).toMatchObject({ agentId: "coder", kind: "voice", status: "ringing", origin: "callback", about: [{ id, state: "done" }] })
    expect(c.reason).toBe("Done: Fix the login page")
    expect(c.placedBy ?? null).toBe(null)
    expect(rings().map((n) => n.from)).toEqual(["coder"])
    // The widget's poll lists it like any voice call (C1).
    expect((await calls.ringing()).map((x) => x.id)).toEqual([c.id])
  })

  it('"call me when it\'s done" calls even when it was short', async () => {
    const id = ask({ ago: 1, text: "Deploy CX and call me when it's done" })
    requests.close(id, "done", "https://example.com/deploy", now, null, "coder")
    await settle()
    expect(callbacks()).toHaveLength(1)
  })

  it("an agent-to-agent request never calls back", async () => {
    const id = ask({ channel: "a2a" })
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks()).toEqual([])
  })

  it("the owner closing it himself does not call", async () => {
    const id = ask()
    requests.close(id, "done", "done by me", now, null, OWNER_BY)
    await settle()
    expect(callbacks()).toEqual([])
  })

  it("calls.callback.enabled off: nothing", async () => {
    cfg = callsSchema.parse({ callback: { enabled: false } })
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks()).toEqual([])
  })

  it("is not bound by calls.allow: the owner asked for the work", async () => {
    expect(cfg.allow).toEqual([])
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks()).toHaveLength(1)
  })

  it("the agent the owner handed it to is the one who calls", async () => {
    const id = ask()
    const r = requests.get(id)!
    expect(wantsCallback({ ...r, askedAgent: "ops" }, "done", cfg.callback, now)).toBe(true)
  })
})

describe("every path that changes the state (C4)", () => {
  it("closeVerified (a check met) calls", async () => {
    const id = ask()
    requests.closeVerified(id, "the PR is merged", now)
    await settle()
    expect(callbacks().map((c) => c.about)).toEqual([[{ id, state: "done" }]])
  })

  it("settle (a hand-back closed it) calls", async () => {
    const id = ask()
    expect(requests.settle(id, "https://example.com/pr/2", "handed back", now)).toBe(true)
    await settle()
    expect(callbacks().map((c) => c.about)).toEqual([[{ id, state: "done" }]])
  })

  it("waiting on the owner calls once with the question; asking again does not ring again", async () => {
    const id = ask()
    requests.waitOnOwner(id, "Which branch should I deploy?", now)
    await settle()
    requests.waitOnOwner(id, "Which branch should I deploy?", now + 1)
    await settle()
    const list = callbacks()
    expect(list.map((c) => [c.reason, c.about])).toEqual([["Waits on you: Fix the login page", [{ id, state: "waiting_owner" }]]])
  })

  it("needing attention (a blocked step) calls", async () => {
    const id = ask()
    requests.needsAttention(id, "plan step 2 is blocked: no deploy key", now)
    await settle()
    expect(callbacks().map((c) => c.reason)).toEqual(["Needs you: Fix the login page"])
  })

  // B1 (Hakim, #2274): the once-per-request-and-state check must hold for
  // the states with "_" in them, after the first call has ended.
  it.each([
    { state: "waiting_owner" as const, enter: (id: string, at: number) => requests.waitOnOwner(id, "Which branch?", at) },
    { state: "needs_attention" as const, enter: (id: string, at: number) => { requests.needsAttention(id, "plan step 2 is blocked", at) } },
  ])("$state → in_progress → $state again rings once", async ({ state, enter }) => {
    const id = ask()
    enter(id, now)
    await settle()
    const first = callbacks()[0]
    expect(first.about).toEqual([{ id, state }])
    calls.answer(first.id)
    calls.hangup(first.id)
    requests.progress(id, now + 1)
    enter(id, now + 2)
    await settle()
    expect(callbacks()).toHaveLength(1)
    expect(rings()).toHaveLength(1)
    expect(callStore.hasCallback({ id, state })).toBe(true)
  })

  it("the once check matches the state exactly, not as a LIKE pattern", () => {
    callStore.insert({
      id: "call-x", agentId: "coder", kind: "voice", reason: "r", urgency: "normal", status: "ended", createdAt: now,
      ringingSince: null, answeredAt: null, endedAt: now, ringAgainAt: null, note: null, summary: null, channel: null, chatId: null,
      origin: "callback", about: [{ id: "req-a", state: "waiting_owner" }],
    })
    expect(callStore.hasCallback({ id: "req-a", state: "waiting_owner" })).toBe(true)
    expect(callStore.hasCallback({ id: "req-a", state: "needs_attention" })).toBe(false)
    expect(callStore.hasCallback({ id: "req-b", state: "waiting_owner" })).toBe(false)
  })

  // B2 (Hakim, #2274): settle closes unverified, so it fires only the
  // call-back hook, never onDone (a promise's fact).
  it("settle does not fire onDone hooks", () => {
    const done: string[] = []
    const settled: string[] = []
    requests.onDone((r) => done.push(r.id))
    requests.onSettled((r) => settled.push(r.id))
    const id = ask()
    expect(requests.settle(id, "https://example.com/pr/2", "handed back", now)).toBe(true)
    expect(done).toEqual([])
    expect(settled).toEqual([id])
  })

  it("a request that later finishes calls again, for done", async () => {
    const id = ask()
    requests.waitOnOwner(id, "Which branch?", now)
    await settle()
    // He answers on the first call; it ends.
    const first = callbacks()[0]
    calls.answer(first.id)
    calls.hangup(first.id)
    requests.progress(id, now)
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks().map((c) => c.about![0].state).sort()).toEqual(["done", "waiting_owner"])
  })
})

describe("Focus (C2)", () => {
  it("in Focus it does not ring: kept as a missed call, its notice held by notify", async () => {
    inFocus = true
    await calls.ringing()
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    const [c] = callbacks()
    expect(c.status).toBe("missed")
    expect(rings()).toEqual([])
    expect(notices.map((n) => [n.title, n.urgent])).toEqual([["Missed call from Coder", false]])
  })

  it("quietWhenFocus off: it rings through Focus, widget and phone", async () => {
    inFocus = true
    cfg = callsSchema.parse({ callback: { quietWhenFocus: false } })
    await calls.ringing()
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(callbacks()[0].status).toBe("ringing")
    expect(rings()).toHaveLength(1)
  })

  it("a normal agent call is still held in Focus, and an owner call still rings", async () => {
    inFocus = true
    cfg = callsSchema.parse({ allow: ["*"], callback: { quietWhenFocus: false } })
    const agentCalls = new CallService({
      store: callStore, config: () => cfg, agentName: () => "Coder", isRunningTurn: () => true,
      alert: async (n) => { notices.push(n) }, focus: () => ({ active: true, mode: null, reason: "on" }), now: () => now,
    })
    const r = await agentCalls.request({ agentId: "coder", reason: "Need you" }, { taskId: "t" })
    expect(r.ok && r.call.status).toBe("missed")
  })
})

describe("never lost (C5)", () => {
  it("five done in an hour from one agent: five reach the owner", async () => {
    await calls.ringing()
    const ids = [ask(), ask(), ask(), ask(), ask()]
    for (const [i, id] of ids.entries()) {
      requests.close(id, "done", `https://example.com/pr/${i}`, now, null, "coder")
      await settle()
      // The owner lets each ring out before the next.
      now += cfg.ringSeconds * 1000
      await calls.sweep()
      now += 5 * MIN
    }
    const about = callbacks().flatMap((c) => c.about!.map((r) => r.id))
    expect(about.sort()).toEqual([...ids].sort())
    // Past calls.maxPerHour (3) they are kept as missed, each with its notice.
    const held = callbacks().filter((c) => c.note === "over calls.maxPerHour")
    expect(held).toHaveLength(2)
    for (const c of held) expect(notices.some((n) => n.title === "Coder: your request is done" && n.message === c.reason)).toBe(true)
  })

  it("while that agent's call-back still rings, the next one joins it", async () => {
    await calls.ringing()
    const a = ask()
    const b = ask({ text: "Update the docs" })
    requests.close(a, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    requests.close(b, "done", "https://example.com/pr/2", now, null, "coder")
    await settle()
    const list = callbacks()
    expect(list).toHaveLength(1)
    expect(list[0].about!.map((r) => r.id)).toEqual([a, b])
    expect(list[0].reason).toBe("2 of your requests need you or are done")
  })

  it("while the agent is on another call, it is kept as missed with its notice", async () => {
    await calls.ringing()
    const a = ask()
    requests.close(a, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    calls.answer(callbacks()[0].id)
    const b = ask({ text: "Update the docs" })
    requests.close(b, "done", "https://example.com/pr/2", now, null, "coder")
    await settle()
    const missed = callbacks().find((c) => c.about![0].id === b)!
    expect(missed).toMatchObject({ status: "missed", note: "the agent is on another call" })
    expect(notices.at(-1)).toMatchObject({ title: "Coder: your request is done", message: "Done: Update the docs" })
  })

  it("an agent not on this computer: no call, nothing thrown", async () => {
    const id = ask({ agentId: "ghost" })
    requests.close(id, "done", "https://example.com/pr/1", now, null, "ghost")
    await settle()
    expect(callbacks()).toEqual([])
  })
})

describe("answering a call-back", () => {
  it("the opener gives the result, and the request counts as told", async () => {
    await calls.ringing()
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    const r = calls.answer(callbacks()[0].id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.opener).toContain(`"Fix the login page" (${id}) is done. Proof: https://example.com/pr/1`)
    expect(r.opener).toContain("give the result in two or three sentences")
    expect(requests.get(id)!.notifiedAt).toBe(now)
  })

  it("the opener of a plain agent call is unchanged", () => {
    expect(openerPrompt({ reason: "x", placedBy: null })).toContain("say why you called")
  })
})

describe("a locked Mac counts as away", () => {
  it('"away": a locked screen rings the phone with the widget', async () => {
    cfg = callsSchema.parse({ phone: { ring: "away" } })
    await handleCalls(calls, () => cfg, "GET", "/calls/ringing", new URLSearchParams("locked=1"), {}, {}, false)
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(rings()).toHaveLength(1)
    expect(rings()[0].ring?.widget).toBe(true)
  })

  it('"away": unlocked, only the widget rings', async () => {
    cfg = callsSchema.parse({ phone: { ring: "away" } })
    await calls.ringing({ locked: false })
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(rings()).toEqual([])
    expect(callbacks()[0].status).toBe("ringing")
  })

  it("no widget polling: the phone rings", async () => {
    await calls.ringing()
    now += WIDGET_FRESH_MS
    const id = ask()
    requests.close(id, "done", "https://example.com/pr/1", now, null, "coder")
    await settle()
    expect(rings().map((n) => n.ring?.widget)).toEqual([undefined])
  })
})
