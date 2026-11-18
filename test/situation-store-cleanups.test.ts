import { afterEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { SituationStore, GATE_MESSAGE_MAX, SITUATION_KEEP_MS } from "../src/situations/store"
import { SituationGate } from "../src/situations/gate"
import { situationKey } from "../src/situations/key"
import { sendToChat, setSendToChatStore } from "../src/situations/send-to-chat"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import type { OutgoingMessage } from "../src/channels/types"

// #1921: clean-ups after phase 1 of the courtesy-close gate (#1892).
// Neutral ids only.

const DAY = 24 * 3600_000

function logRow(over: Partial<Parameters<SituationStore["logGate"]>[0]> = {}): Parameters<SituationStore["logGate"]>[0] {
  return {
    key: "discord|default|g1", situationId: null, messageId: "m1", channel: "discord", chatId: "g1",
    senderId: "u1", senderName: "C", senderKind: "bot", text: "Thanks, bye", phase: "ended",
    outcome: "drop", reason: "ended (closed), courtesy", message: JSON.stringify({ id: "m1", channel: "discord", text: "Thanks, bye" }),
    ...over,
  }
}

afterEach(() => setSendToChatStore(null))

describe("store prepares each statement once (#1921)", () => {
  it("repeated reads and writes do not prepare again", () => {
    const db = new Database(":memory:")
    const store = new SituationStore(db)
    const spy = vi.spyOn(db, "prepare")
    store.create("k1", "during", "first")
    const row = store.get("k1")!
    store.move("k1", { phase: "during", since: row.phaseChangedAt }, "ending", { why: "closer" })
    store.takeSlot("k1", "t1")
    store.freeSlot("k1", "t1")
    store.noteSent("k1", "agent-a")
    const id = store.logGate(logRow())
    store.gateRow(id)
    store.gateLog()
    store.gateLog({ outcome: "drop" })
    store.markReleased(id)
    for (let i = 0; i < 5; i++) store.get("k1")
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("situations rows are pruned (#1921)", () => {
  it("a record untouched for longer than the keep time goes on the next write; a recent one stays", () => {
    let now = 1_000_000_000_000
    const store = new SituationStore(new Database(":memory:"), () => now)
    store.create("old", "ended", "setup")
    now += SITUATION_KEEP_MS - DAY
    store.create("recent", "during", "setup")
    now += 2 * DAY
    store.create("new", "during", "setup")
    expect(store.get("old")).toBeNull()
    expect(store.get("recent")).not.toBeNull()
    expect(store.get("new")).not.toBeNull()
  })

  it("old gate log rows are pruned too, without waiting for a row-count multiple", () => {
    let now = 1_000_000_000_000
    const store = new SituationStore(new Database(":memory:"), () => now)
    const old = store.logGate(logRow())
    now += 31 * DAY
    store.logGate(logRow({ messageId: "m2" }))
    expect(store.gateRow(old)).toBeNull()
    expect(store.gateLog()).toHaveLength(1)
  })
})

describe("gate log message is clipped (#1921)", () => {
  it("a huge inbound message is stored bounded, still readable, and can be released", () => {
    const store = new SituationStore(new Database(":memory:"))
    const gate = new SituationGate({ store })
    const big = "x".repeat(200_000)
    const message = JSON.stringify({ id: "m9", channel: "discord", sender: { id: "u1", name: "C" }, text: big, channelMeta: { blob: "y".repeat(200_000) } })
    const id = store.logGate(logRow({ messageId: "m9", text: big, message }))
    const row = store.gateRow(id)!
    expect(row.message.length).toBeLessThanOrEqual(GATE_MESSAGE_MAX)
    const parsed = JSON.parse(row.message)
    expect(parsed.id).toBe("m9")
    expect(parsed.channel).toBe("discord")
    expect(typeof parsed.text).toBe("string")
    expect(parsed.text.length).toBeLessThan(big.length)
    const r = gate.release(id)
    expect(r.ok).toBe(true)
  })

  it("a message within the bound is stored unchanged", () => {
    const store = new SituationStore(new Database(":memory:"))
    const message = JSON.stringify({ id: "m1", channel: "discord", text: "Thanks", channelMeta: { thread: "t1" } })
    const id = store.logGate(logRow({ message }))
    expect(store.gateRow(id)!.message).toBe(message)
  })
})

describe("GET /situations/gate-log is mesh-gated (#1921)", () => {
  it("it carries message text and sender names, like /traces and /events/recent", () => {
    expect(isMeshGatedPath("/situations/gate-log")).toBe(true)
  })
})

describe("Telegram DM key on a send with no account (review of 058a142c)", () => {
  it("a counted reply with no accountId ends the DM talk of the bot the person wrote to", async () => {
    const store = new SituationStore(new Database(":memory:"))
    setSendToChatStore(store)
    // The person wrote to bot account "helper" in a private chat.
    const key = situationKey("telegram", "helper", "5550100")
    store.create(key, "ending", "a closer")
    // channel.reply / a workflow send: no accountId; the adapter sends from
    // the account it last saw this chat on.
    const adapter = {
      name: "telegram",
      send: async (_m: OutgoingMessage) => "out-1",
      accountForChat: (chatId: string) => (chatId === "5550100" ? "helper" : undefined),
    }
    await sendToChat(adapter as any, { channel: "telegram", chatId: "5550100", text: "Goodbye!", agentId: "a1" } as OutgoingMessage, { countsAsReply: true })
    expect(store.get(key)?.phase).toBe("ended")
  })
})
