import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// #1892 phase 3: "who left" adapters, built, not assumed. WhatsApp groups
// (Baileys `group-participants.update`), Telegram (`chat_member` updates,
// only sent to admin bots, and the `left_chat_member` service message),
// and calls (the call store). Neutral ids only.

const handlers: Record<string, (arg: any) => any> = {}
const ME = "15550001111"
const LID = "214990000000001"
let groupMetadata: (jid: string) => Promise<any>

vi.mock("@whiskeysockets/baileys", () => {
  const makeWASocket = () => ({
    ev: { on: (name: string, fn: (arg: any) => any) => { handlers[name] = fn } },
    user: { id: `${ME}:3@s.whatsapp.net`, lid: `${LID}:3@lid` },
    groupMetadata: (jid: string) => groupMetadata(jid),
    end: () => {},
  })
  return {
    default: makeWASocket,
    makeWASocket,
    useMultiFileAuthState: async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds: () => {} }),
    fetchLatestBaileysVersion: async () => { throw new Error("offline") },
    DisconnectReason: {},
    makeCacheableSignalKeyStore: undefined,
    downloadMediaMessage: async () => null,
  }
})

import { WhatsAppAdapter } from "../src/channels/whatsapp"
import { TELEGRAM_ALLOWED_UPDATES, TelegramAdapter, telegramLeaveOf } from "../src/channels/telegram"
import { SituationStore } from "../src/situations/store"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { onSignal, setSignalInterest } from "../src/situations/sources/hub"
import { applySignal } from "../src/situations/sources/apply"
import { whatsappLeaveSignals } from "../src/situations/sources/whatsapp-groups"
import { callEndedSignal, callsSource } from "../src/situations/sources/calls"
import { TELEGRAM_MEMBERS_SOURCE } from "../src/situations/sources/telegram-members"
import { SignalSources } from "../src/situations/sources/registry"
import { isUnknown, type Signal } from "../src/situations/sources/types"
import { CallStore } from "../src/calls/store"
import { CallService, type CallDeps } from "../src/calls/service"
import { callsSchema } from "../src/daemon/config"

const GROUP = "120363000000000001@g.us"
const CANDIDATE = "15550002222@s.whatsapp.net"
const OTHER = "15550003333@s.whatsapp.net"
const active: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active" }

let dir: string
let signals: Signal[]
let offs: Array<() => void>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-leave-"))
  signals = []
  offs = [onSignal((s) => signals.push(s))]
  groupMetadata = async () => ({ participants: [{ id: `${ME}@s.whatsapp.net` }] })
})
afterEach(() => {
  for (const off of offs) off()
  setSignalInterest(null)
  rmSync(dir, { recursive: true, force: true })
})

async function whatsapp() {
  const wa = new WhatsAppAdapter({ sessionDir: join(dir, "s"), defaultAgent: "main", allowFrom: ["*"] }, () => {})
  wa.onMessage(async () => {})
  await wa.start()
  return wa
}

describe("whatsappLeaveSignals (pure)", () => {
  const me = { id: `${ME}:3@s.whatsapp.net`, lid: `${LID}:3@lid` }
  it("one `left` signal per participant who left, keyed on the group's situation", () => {
    const out = whatsappLeaveSignals({ id: GROUP, action: "remove", participants: [CANDIDATE, { id: OTHER }] }, { me, remaining: 1, now: 5 })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: "whatsapp-groups", kind: "left", subject: "15550002222", value: true, checkedAt: 5,
      scope: situationKey("whatsapp", "default", GROUP), remaining: 1,
    })
    expect(out[1].subject).toBe("15550003333")
  })
  it("adds, promotions, a DM, and our own leave give nothing", () => {
    expect(whatsappLeaveSignals({ id: GROUP, action: "add", participants: [CANDIDATE] }, { me, remaining: 0, now: 5 })).toEqual([])
    expect(whatsappLeaveSignals({ id: GROUP, action: "demote", participants: [CANDIDATE] }, { me, remaining: 0, now: 5 })).toEqual([])
    expect(whatsappLeaveSignals({ id: CANDIDATE, action: "remove", participants: [CANDIDATE] }, { me, remaining: 0, now: 5 })).toEqual([])
    expect(whatsappLeaveSignals({ id: GROUP, action: "remove", participants: [`${ME}@s.whatsapp.net`, `${LID}@lid`] }, { me, remaining: 0, now: 5 })).toEqual([])
    expect(whatsappLeaveSignals(null as any, { me, remaining: 0, now: 5 })).toEqual([])
  })
})

describe("WhatsApp group: a leave event moves a test meeting to ending (phase 3 proof of done)", () => {
  it("us and a candidate in a group; the candidate leaves → the talk is in `ending`", async () => {
    const store = new SituationStore(new Database(":memory:"))
    const key = situationKey("whatsapp", "default", GROUP)
    store.create(key, "during", "first message on this chat")
    // The daemon's wiring: interest in chats in `during`, signals applied to the record.
    setSignalInterest((k) => store.get(k)?.phase === "during")
    offs.push(onSignal((s) => { applySignal(store, () => active, s) }))
    await whatsapp()
    // After the leave, only we are left in the group.
    groupMetadata = async () => ({ participants: [{ id: `${ME}@s.whatsapp.net` }] })
    await handlers["group-participants.update"]({ id: GROUP, author: CANDIDATE, participants: [CANDIDATE], action: "remove" })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: "left", remaining: 0 })
    expect(store.get(key)!.phase).toBe("ending")
    expect(store.get(key)!.why).toBe("the last other party left (whatsapp-groups)")
  })

  it("someone else still in the group: a signal, no phase move", async () => {
    const store = new SituationStore(new Database(":memory:"))
    const key = situationKey("whatsapp", "default", GROUP)
    store.create(key, "during", "first")
    setSignalInterest((k) => store.get(k)?.phase === "during")
    offs.push(onSignal((s) => { applySignal(store, () => active, s) }))
    await whatsapp()
    groupMetadata = async () => ({ participants: [{ id: `${ME}@s.whatsapp.net` }, { id: OTHER }] })
    await handlers["group-participants.update"]({ id: GROUP, participants: [CANDIDATE], action: "remove" })
    expect(signals[0]).toMatchObject({ remaining: 1 })
    expect(store.get(key)!.phase).toBe("during")
  })

  it("the group cannot be read: remaining is unknown (null), nothing moves (fail open)", async () => {
    const store = new SituationStore(new Database(":memory:"))
    const key = situationKey("whatsapp", "default", GROUP)
    store.create(key, "during", "first")
    setSignalInterest(() => true)
    offs.push(onSignal((s) => { applySignal(store, () => active, s) }))
    await whatsapp()
    groupMetadata = async () => { throw new Error("rate-overlimit") }
    await handlers["group-participants.update"]({ id: GROUP, participants: [CANDIDATE], action: "remove" })
    expect(signals[0]).toMatchObject({ kind: "left", remaining: null })
    expect(store.get(key)!.phase).toBe("during")
  })

  it("a group no talk is open in: no live read, no signal (no extra WhatsApp traffic)", async () => {
    const read = vi.fn(async () => ({ participants: [] }))
    groupMetadata = read
    await whatsapp()
    await handlers["group-participants.update"]({ id: GROUP, participants: [CANDIDATE], action: "remove" })
    expect(read).not.toHaveBeenCalled()
    expect(signals).toEqual([])
  })
})

describe("Telegram: chat_member updates and the leave service message", () => {
  it("still asks for everything it asked for, plus chat_member", () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toEqual(["message", "my_chat_member", "chat_member"])
  })

  it("telegramLeaveOf reads a chat_member leave or kick, and a left_chat_member message", () => {
    const chat = { id: -100123, type: "supergroup", title: "Demo" }
    const user = { id: 42, first_name: "Sam", is_bot: false }
    expect(telegramLeaveOf({ update_id: 1, chat_member: { chat, from: user, old_chat_member: { user, status: "member" }, new_chat_member: { user, status: "left" } } } as any, 7))
      .toEqual({ chatId: "-100123", userId: "42" })
    expect(telegramLeaveOf({ update_id: 1, chat_member: { chat, from: user, old_chat_member: { user, status: "administrator" }, new_chat_member: { user, status: "kicked" } } } as any, 7))
      .toEqual({ chatId: "-100123", userId: "42" })
    expect(telegramLeaveOf({ update_id: 1, message: { message_id: 3, chat, from: user, date: 1, left_chat_member: user } } as any, 7))
      .toEqual({ chatId: "-100123", userId: "42" })
    // A join, a promotion, a leave that was not a member, and our own bot leaving: nothing.
    expect(telegramLeaveOf({ update_id: 1, chat_member: { chat, from: user, old_chat_member: { user, status: "left" }, new_chat_member: { user, status: "member" } } } as any, 7)).toBeNull()
    expect(telegramLeaveOf({ update_id: 1, chat_member: { chat, from: user, old_chat_member: { user, status: "left" }, new_chat_member: { user, status: "kicked" } } } as any, 7)).toBeNull()
    expect(telegramLeaveOf({ update_id: 1, message: { message_id: 3, chat, from: user, date: 1, left_chat_member: { id: 7, first_name: "Bot", is_bot: true } } } as any, 7)).toBeNull()
    expect(telegramLeaveOf({ update_id: 1, message: { message_id: 3, chat, from: user, date: 1, text: "hi" } } as any, 7)).toBeNull()
  })

  function telegram(api: (method: string, params: any) => Promise<any>) {
    const tg = new TelegramAdapter({ main: { token: "t", agentBinding: "main" } }, {}, () => {})
    ;(tg as any).apiCall = vi.fn(async (_token: string, method: string, params: any) => api(method, params))
    ;(tg as any).botInfo.set("main", { userId: 7, username: "demo_bot" })
    return tg
  }

  it("a leave in a group with an open talk: one signal, the count from getChatMemberCount minus our bots", async () => {
    setSignalInterest(() => true)
    const tg = telegram(async (method) => method === "getChatMemberCount" ? { result: 1 } : {})
    const chat = { id: -100123, type: "supergroup", title: "Demo" }
    const user = { id: 42, first_name: "Sam" }
    await tg.handleMemberUpdate("main", "t", { update_id: 1, chat_member: { chat, from: user, old_chat_member: { user, status: "member" }, new_chat_member: { user, status: "left" } } } as any)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ source: "telegram-members", kind: "left", subject: "42", scope: situationKey("telegram", "main", "-100123"), remaining: 0 })
  })

  it("the count cannot be read (not allowed, network): remaining is unknown", async () => {
    setSignalInterest(() => true)
    const tg = telegram(async () => { throw new Error("Bad Request: not enough rights") })
    const chat = { id: -100123, type: "group" }
    const user = { id: 42, first_name: "Sam" }
    await tg.handleMemberUpdate("main", "t", { update_id: 1, message: { message_id: 3, chat, from: user, date: 1, left_chat_member: user } } as any)
    expect(signals[0]).toMatchObject({ kind: "left", remaining: null })
  })

  it("no open talk on that chat: no API call, no signal", async () => {
    const api = vi.fn(async () => ({ result: 1 }))
    const tg = telegram(api)
    const chat = { id: -100123, type: "group" }
    const user = { id: 42, first_name: "Sam" }
    await tg.handleMemberUpdate("main", "t", { update_id: 1, message: { message_id: 3, chat, from: user, date: 1, left_chat_member: user } } as any)
    expect(api).not.toHaveBeenCalled()
    expect(signals).toEqual([])
  })

  // Review fixes for PR #1944: our other bots, a stale bot list, repeat counts.
  function twoBots(api: (method: string, params: any) => Promise<any>, recorded = ["main", "second"]) {
    const tg = new TelegramAdapter({ main: { token: "t", agentBinding: "main" }, second: { token: "t2", agentBinding: "second" } }, {}, () => {})
    const apiCall = vi.fn(async (_token: string, method: string, params: any) => api(method, params))
    ;(tg as any).apiCall = apiCall
    ;(tg as any).botInfo.set("main", { userId: 7, username: "demo_bot" })
    ;(tg as any).botInfo.set("second", { userId: 8, username: "other_bot" })
    // Never touch the groups file on disk: a stub store with the recorded bots.
    ;(tg as any).groupStore = { getGroupBots: () => recorded.map((accountId) => ({ accountId, agentId: accountId, username: accountId })) }
    return { tg, apiCall }
  }
  const demoChat = { id: -100123, type: "supergroup", title: "Demo" }
  const leaveOf = (id: number, isBot = false) => {
    const user = { id, first_name: "U", is_bot: isBot }
    return { update_id: 1, chat_member: { chat: demoChat, from: user, old_chat_member: { user, status: "member" }, new_chat_member: { user, status: "left" } } } as any
  }
  const leaveMsgOf = (id: number) => ({ update_id: 2, message: { message_id: 3, chat: demoChat, from: { id, first_name: "U" }, date: 1, left_chat_member: { id, first_name: "U" } } }) as any

  it("telegramLeaveOf ignores any of our bot accounts leaving, not only this account's", () => {
    expect(telegramLeaveOf(leaveOf(8, true), new Set([7, 8]))).toBeNull()
    expect(telegramLeaveOf(leaveMsgOf(8), new Set([7, 8]))).toBeNull()
    // A bot that is not ours is a party (another company's agent): its leave counts.
    expect(telegramLeaveOf(leaveOf(99, true), new Set([7, 8]))).toEqual({ chatId: "-100123", userId: "99" })
  })

  it("one of our other bots leaving is not a party leaving: no count, no signal", async () => {
    setSignalInterest(() => true)
    const { tg, apiCall } = twoBots(async () => ({ result: 2 }))
    await tg.handleMemberUpdate("main", "t", leaveOf(8, true))
    expect(apiCall).not.toHaveBeenCalled()
    expect(signals).toEqual([])
  })

  it("a stale bot list never drives the count to 0: a recorded bot that is no longer there makes it unknown", async () => {
    setSignalInterest(() => true)
    // Recorded: main + second. In fact second was removed (its record not updated yet);
    // the group is main + a candidate, so the count is 2 and 2 - 2 would wrongly be 0.
    const { tg } = twoBots(async (method, params) => {
      if (method === "getChatMemberCount") return { result: 2 }
      if (method === "getChatMember") return { result: { status: params.user_id === 8 ? "left" : "member" } }
      return {}
    })
    await tg.handleMemberUpdate("main", "t", leaveOf(42))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: "left", remaining: null })
  })

  it("the recorded bots all confirmed present: the count of 0 stands", async () => {
    setSignalInterest(() => true)
    const { tg } = twoBots(async (method) => {
      if (method === "getChatMemberCount") return { result: 2 }
      if (method === "getChatMember") return { result: { status: "administrator" } }
      return {}
    })
    await tg.handleMemberUpdate("main", "t", leaveOf(42))
    expect(signals[0]).toMatchObject({ kind: "left", remaining: 0 })
  })

  it("a recorded bot whose presence cannot be checked: unknown, not 0", async () => {
    setSignalInterest(() => true)
    const { tg } = twoBots(async (method) => {
      if (method === "getChatMemberCount") return { result: 2 }
      throw new Error("Bad Request: user not found")
    })
    await tg.handleMemberUpdate("main", "t", leaveOf(42))
    expect(signals[0]).toMatchObject({ remaining: null })
  })

  it("the same leave seen by every bot, as chat_member and as the service message: counted once in 60 s", async () => {
    setSignalInterest(() => true)
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    try {
      const { tg, apiCall } = twoBots(async () => ({ result: 1 }), ["main"])
      await Promise.all([
        tg.handleMemberUpdate("main", "t", leaveOf(42)),
        tg.handleMemberUpdate("main", "t", leaveMsgOf(42)),
        tg.handleMemberUpdate("second", "t2", leaveOf(42)),
        tg.handleMemberUpdate("second", "t2", leaveMsgOf(42)),
      ])
      expect(apiCall.mock.calls.filter((c) => c[1] === "getChatMemberCount")).toHaveLength(1)
      expect(signals).toHaveLength(1)
      // Another person's leave in the same chat is its own event.
      await tg.handleMemberUpdate("second", "t2", leaveOf(43))
      expect(signals).toHaveLength(2)
      // After the window, the same person leaving again (they rejoined) counts again.
      now.mockReturnValue(1_000_000 + 61_000)
      await tg.handleMemberUpdate("second", "t2", leaveMsgOf(42))
      expect(signals).toHaveLength(3)
    } finally {
      now.mockRestore()
    }
  })

  it("presence on Telegram is unknown when no leave was reported (chat_member needs an admin bot)", () => {
    const reg = new SignalSources({ now: () => 1 })
    reg.register(TELEGRAM_MEMBERS_SOURCE)
    const [s] = reg.read("telegram-members", { key: situationKey("telegram", "main", "-100123") })
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toMatch(/admin/)
  })
})

describe("calls: the call store as a source", () => {
  function service() {
    const store = new CallStore(new Database(":memory:"))
    let now = 1_000_000
    const deps: CallDeps = {
      store,
      config: () => callsSchema.parse({ allow: ["writer"] }),
      agentName: (id) => (id === "writer" ? "Writer" : null),
      isRunningTurn: (id, p) => p.taskId === `task-${id}`,
      turnSession: () => ({ channel: "telegram", chatId: "100" }),
      alert: async () => {},
      summarize: async () => null,
      focus: () => ({ active: false, mode: null, reason: "off" }),
      now: () => now,
    }
    const calls = new CallService(deps)
    return { calls, store, tick: (ms: number) => { now += ms } }
  }

  it("a call that ends (hang-up) publishes one `left` signal about the call, nobody remaining", async () => {
    const { calls } = service()
    await calls.ringing()
    const r = await calls.request({ agentId: "writer", reason: "The deploy" }, { taskId: "task-writer" })
    expect(r.ok).toBe(true)
    const id = (r as any).call.id
    calls.answer(id)
    expect(signals).toEqual([])
    calls.hangup(id)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ source: "calls", kind: "left", subject: "owner", scope: situationKey("call", undefined, id), remaining: 0 })
  })

  it("callEndedSignal is null for a call that is not ended", () => {
    expect(callEndedSignal({ id: "c1", status: "answered" } as any, 1)).toBeNull()
    expect(callEndedSignal({ id: "c1", status: "ended", endedAt: 9 } as any, 1)).toMatchObject({ checkedAt: 9 })
  })

  it("read: is the owner on a call with this agent now", async () => {
    const { calls, store } = service()
    const reg = new SignalSources({ now: () => 1_000_000 })
    reg.register(callsSource(() => store, () => 1_000_000))
    expect(reg.read("calls", { agentId: "writer" })[0]).toMatchObject({ kind: "present", subject: "owner", value: false })
    await calls.ringing()
    const r = await calls.request({ agentId: "writer", reason: "The deploy" }, { taskId: "task-writer" })
    calls.answer((r as any).call.id)
    expect(reg.read("calls", { agentId: "writer" })[0]).toMatchObject({ value: true })
    expect(isUnknown(reg.read("calls", {})[0])).toBe(true)
    const down = new SignalSources({ now: () => 1 })
    down.register(callsSource(() => undefined))
    expect(down.read("calls", { agentId: "writer" })[0].reason).toMatch(/no call store/)
  })
})
