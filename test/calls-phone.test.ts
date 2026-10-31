import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { CallStore } from "../src/calls/store"
import { CallService, WIDGET_FRESH_MS, type CallDeps, type PhoneRing } from "../src/calls/service"
import { appSession, handleCalls } from "../src/daemon/calls-api"
import { callsSchema, type CallsConfig } from "../src/daemon/config"
import { ringHeaders } from "../src/channels/ntfy"
import { buildPushPayload } from "../src/channels/push"
import { callAppPath } from "../src/channels/types"
import { phoneCall, ringingForPhone } from "../src/daemon/app-calls"
import { CALLS_SCRIPT } from "../src/daemon/ui/pages/app-calls.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_SERVICE_WORKER } from "../src/daemon/ui/pages/app-sw"

// An agent's call rings the owner's phone like a real call (#1605).

type Notice = { title: string; message: string; urgent: boolean; from: string; ring?: PhoneRing }

let now: number
let cfg: CallsConfig
let notices: Notice[]
let inFocus: boolean
let summarizedIn: Array<{ channel: string | null; chatId: string | null }>
let calls: CallService

beforeEach(() => {
  now = 1_000_000
  cfg = callsSchema.parse({ allow: ["*"] })
  notices = []
  inFocus = false
  summarizedIn = []
  const deps: CallDeps = {
    store: new CallStore(new Database(":memory:")),
    config: () => cfg,
    agentName: (id) => ({ writer: "Writer", ops: "Ops" } as Record<string, string>)[id] ?? null,
    isRunningTurn: (id, p) => p.taskId === `task-${id}`,
    alert: async (n) => { notices.push(n) },
    summarize: async (call) => { summarizedIn.push({ channel: call.channel, chatId: call.chatId }); return "Summary." },
    focus: () => ({ active: inFocus, mode: null, reason: inFocus ? "on" : "off" }),
    now: () => now,
  }
  calls = new CallService(deps)
})

const place = (agentId: string, urgency?: string) =>
  calls.request({ agentId, reason: "The deploy needs you", urgency }, { taskId: `task-${agentId}` })
const rings = () => notices.filter((n) => n.ring?.state === "ringing")

describe("the phone rings (CallService)", () => {
  it("defaults: the phone rings with the widget, no app address", () => {
    const d = callsSchema.parse(undefined)
    expect(d.phone).toEqual({ ring: "always" })
    expect(() => callsSchema.parse({ phone: { appUrl: "https://my-mac.example.ts.net/app" } })).toThrow()
    expect(callsSchema.parse({ phone: { appUrl: "https://my-mac.example.ts.net" } }).phone.appUrl).toBe("https://my-mac.example.ts.net")
  })

  it("rings the phone with the widget, as a call that names itself", async () => {
    await calls.ringing()
    const r = await place("writer", "urgent")
    expect(r.ok && r.rang).toBe("widget")
    if (!r.ok) return
    expect(rings()).toEqual([{
      title: "Writer is calling",
      message: "The deploy needs you\nAnswer on your phone or in AgentX Voice within 45 s.",
      urgent: true, from: "writer",
      ring: { callId: r.call.id, state: "ringing", since: now, widget: true },
    }])
  })

  it('"away": the widget alone rings while it runs; the phone rings when it is not running', async () => {
    cfg = callsSchema.parse({ allow: ["*"], phone: { ring: "away" } })
    await calls.ringing()
    expect((await place("writer")).ok).toBe(true)
    expect(notices).toEqual([])
    now += WIDGET_FRESH_MS
    const r = await place("ops")
    expect(r.ok && r.rang).toBe("notify")
    expect(rings().map((n) => [n.from, n.message.split("\n")[1]])).toEqual([["ops", "Answer on your phone within 45 s."]])
  })

  it("a normal call in Focus does not ring the phone: it is a missed call, held by notify", async () => {
    inFocus = true
    const r = await place("writer")
    expect(r.ok && r.rang).toBe(false)
    expect(rings()).toEqual([])
    expect(notices.map((n) => n.title)).toEqual(["Missed call from Writer"])
  })

  it("an urgent call in Focus rings the phone, marked urgent", async () => {
    inFocus = true
    const r = await place("writer", "urgent")
    expect(r.ok && r.rang).toBe("notify")
    expect(rings().map((n) => n.urgent)).toEqual([true])
  })

  it("a call nobody answers is marked missed, so the phone can replace its ring", async () => {
    const r = await place("writer")
    if (!r.ok) throw new Error(r.error)
    now += cfg.ringSeconds * 1000
    await calls.sweep()
    expect(notices.map((n) => n.ring?.state)).toEqual(["ringing", "missed"])
    expect(notices[1].ring?.callId).toBe(r.call.id)
  })

  it("a call back rings the phone again, as a new ring", async () => {
    const r = await place("writer")
    if (!r.ok) throw new Error(r.error)
    calls.later(r.call.id, 1)
    now += 60_000
    await calls.sweep()
    const both = rings()
    expect(both).toHaveLength(2)
    expect(both[0].ring!.since).not.toBe(both[1].ring!.since)
  })

  it("the first to answer takes the call: the widget stops ringing", async () => {
    await calls.ringing()
    const r = await place("writer")
    if (!r.ok) throw new Error(r.error)
    expect(calls.answer(r.call.id).ok).toBe(true)
    expect(await calls.ringing()).toEqual([])
    expect(calls.answer(r.call.id)).toMatchObject({ ok: false, status: 409 })
  })

  it("a call that waited for a busy widget rings the phone when the widget shows it", async () => {
    await calls.ringing({ busy: true })
    const r = await place("writer")
    if (!r.ok) throw new Error(r.error)
    expect(r.rang).toBe("waiting")
    expect(rings()).toEqual([])
    await calls.ringing({ busy: false, showing: r.call.id })
    expect(rings().map((n) => n.ring!.callId)).toEqual([r.call.id])
  })

  it("a call the owner placed rings the widget only", async () => {
    await calls.ringing()
    const r = await calls.ownerCall({ agentId: "writer", reason: "Catch up" })
    expect(r.ok && r.rang).toBe("widget")
    expect(notices).toEqual([])
  })

  it("hung up from the phone, the agent summarises the conversation it was answered in", async () => {
    const r = await place("writer")
    if (!r.ok) throw new Error(r.error)
    calls.answer(r.call.id)
    const h = await handleCalls(calls, () => cfg, "POST", `/calls/${r.call.id}/hangup`, new URLSearchParams(), { channel: "app", chatId: "app:cabcdef1234" })
    expect(h.status).toBe(200)
    // The summary runs in the background; give it a turn.
    await new Promise((res) => setTimeout(res, 0))
    expect(summarizedIn).toEqual([{ channel: "app", chatId: "app:cabcdef1234" }])
  })
})

describe("appSession", () => {
  it("takes only an app chat id", () => {
    expect(appSession({ channel: "app", chatId: "app:cabcdef1234" })).toEqual({ channel: "app", chatId: "app:cabcdef1234" })
    expect(appSession({ channel: "telegram", chatId: "app:cabcdef1234" })).toBeUndefined()
    expect(appSession({ channel: "app", chatId: "voice:writer" })).toBeUndefined()
    expect(appSession({})).toBeUndefined()
  })
})

describe("ntfy: a ringing call", () => {
  it("is priority 5 when urgent, 4 otherwise, with a phone tag and a tap that opens the call", () => {
    expect(ringHeaders({ callId: "call-1", state: "ringing", urgent: true, url: "https://my-mac.example.ts.net/app#call=call-1" }))
      .toEqual({ Priority: "5", Tags: "telephone_receiver", Click: "https://my-mac.example.ts.net/app#call=call-1" })
    expect(ringHeaders({ callId: "call-1", state: "ringing", urgent: false })).toEqual({ Priority: "4", Tags: "telephone_receiver" })
  })

  it("adds nothing for a missed call or a plain notice", () => {
    expect(ringHeaders({ callId: "call-1", state: "missed", urgent: true })).toEqual({})
    expect(ringHeaders(undefined)).toEqual({})
  })
})

describe("Web Push: a call", () => {
  it("opens the call in the app and tells the service worker it is a call", () => {
    const p = buildPushPayload({ channel: "push", chatId: "default", text: "Writer is calling\nThe deploy needs you", ring: { callId: "call-1", state: "ringing", urgent: false } })
    expect(p.url).toBe("/app#call=call-1")
    expect(p.call).toEqual({ id: "call-1", state: "ringing", urgent: false })
  })

  it("a missed call keeps the usual link", () => {
    const p = buildPushPayload({ channel: "push", chatId: "default", text: "Missed call from Writer\nThe deploy", ring: { callId: "call-1", state: "missed", urgent: false } })
    expect(p.url).toBe("/app#alerts")
    expect(p.call?.state).toBe("missed")
  })

  it("the service worker keeps a ringing call on screen and offers Decline", () => {
    expect(APP_SERVICE_WORKER).toContain("requireInteraction")
    expect(APP_SERVICE_WORKER).toContain("call-decline")
    expect(() => new Function(APP_SERVICE_WORKER)).not.toThrow()
  })

  it("callAppPath escapes the id", () => {
    expect(callAppPath("call-1a2b")).toBe("/app#call=call-1a2b")
  })
})

describe("phone app", () => {
  it("lists only agents' voice calls that ring, oldest first, as a bounded summary", () => {
    const list = ringingForPhone([
      { id: "call-3", kind: "voice", status: "ringing", agentId: "ops", reason: "New", urgency: "urgent", ringingSince: 3, summary: "secret" },
      { id: "call-2", kind: "voice", status: "ringing", agentId: "writer", reason: "Owner's", urgency: "normal", ringingSince: 2, placedBy: "owner" },
      { id: "call-1", kind: "voice", status: "ringing", agentId: "writer", reason: "Old", urgency: "normal", ringingSince: 1 },
      { id: "call-0", kind: "camera", status: "ringing", agentId: "writer", reason: "See", urgency: "normal", ringingSince: 0 },
      { id: "call-9", kind: "voice", status: "ringing", agentId: "writer", reason: "Waiting", urgency: "normal", ringingSince: null },
    ])
    expect(list.map((c) => c.id)).toEqual(["call-1", "call-3"])
    expect(Object.keys(list[1]).sort()).toEqual(["agentId", "id", "reason", "ringingSince", "status", "urgency"])
  })

  it("phoneCall cuts the reason and defaults the urgency", () => {
    expect(phoneCall({ id: "call-1", agentId: "w", reason: "x".repeat(500), status: "missed" })).toMatchObject({ urgency: "normal", ringingSince: null })
    expect(phoneCall({ reason: "x".repeat(500) }).reason).toHaveLength(200)
  })

  it("the page carries the call bar and a script that compiles", () => {
    const html = renderAppPage()
    expect(html).toContain('id="call-bar"')
    expect(html).toContain('id="call-answer"')
    expect(() => new Function(CALLS_SCRIPT)).not.toThrow()
  })
})

describe("the phone's conversation for a call", () => {
  it("is titled by the call's reason, not by the opener", async () => {
    const { titleFrom } = await import("../src/daemon/app-chat-store")
    const { openerPrompt } = await import("../src/calls/service")
    expect(titleFrom(openerPrompt({ reason: "The deploy needs you", placedBy: null }))).toBe("Call: The deploy needs you")
    expect(titleFrom("Hello there")).toBe("Hello there")
  })
})
