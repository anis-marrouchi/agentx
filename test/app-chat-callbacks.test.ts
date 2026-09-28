import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { AppChatStore } from "../src/daemon/app-chat-store"
import { AppPresence, type FinishPush } from "../src/daemon/app-chat-active"
import { AppCallbackPuller, CALLBACK_RETRIES, toAnswer, type CallbackEvent, type CallbackPullDeps, type CallbackReplyBody } from "../src/daemon/app-chat-callbacks"

// A phone chat with "front" on this node; front delegated, and its callback
// turn's reply now waits on the daemon (#277).

const PRIMARY = "http://127.0.0.1:18971"
const PEER = "http://127.0.0.1:18972"

let store: AppChatStore
let convId: string
let events: CallbackEvent[]
let replies: Map<string, CallbackReplyBody>
let pushes: FinishPush[]
let presence: AppPresence
let finishOn: boolean

function reply(taskId: string, over: Partial<CallbackReplyBody> = {}): CallbackReplyBody {
  return { taskId, channel: "app", chatId: `app:${convId}`, agent: "front", text: "The build is green.", status: "done", at: 1, ...over }
}
function event(id: string, ref: string, node = "node-a"): CallbackEvent {
  return { id, node, kind: "delegation", type: "reply", agentId: "front", ref }
}

function puller(over: Partial<CallbackPullDeps> = {}) {
  return new AppCallbackPuller({
    recent: async (since) => {
      const i = since ? events.findIndex((e) => e.id === since) : -1
      return events.slice(i + 1)
    },
    nodeUrl: async (node) => (node === "node-a" ? PRIMARY : node === "node-b" ? PEER : null),
    conversationUrl: async (conv) => (conv.node === "local" ? PRIMARY : conv.node === "node-b" ? PEER : null),
    fetchReply: async (url, id) => (url === PRIMARY || url === PEER ? replies.get(`${url}|${id}`) ?? null : null),
    store: () => store,
    presence,
    finishAlerts: () => finishOn,
    notifyFinish: async (p) => { pushes.push(p) },
    ...over,
  })
}

beforeEach(() => {
  store = new AppChatStore(new Database(":memory:"))
  const conv = store.create("phone-1", { node: "local", nodeName: "node-a", agent: "front", agentName: "Front" }, "Check the build", 1000)
  convId = conv.id
  store.append("phone-1", convId, { role: "user", content: "Check the build", at: 1000 })
  store.append("phone-1", convId, { role: "assistant", content: "I asked the worker.", status: "done", at: 1001 })
  store.markRead("phone-1", convId, 2000)
  events = []
  replies = new Map()
  pushes = []
  presence = new AppPresence()
  finishOn = true
})

describe("filing a callback reply in the phone thread", () => {
  it("adds the reply to the conversation, unread, with the finish notification", async () => {
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1"))
    expect(await puller().tick()).toBe(1)

    const conv = store.get("phone-1", convId)!
    expect(conv.messages.at(-1)).toMatchObject({ role: "assistant", content: "The build is green.", status: "done" })
    // Unread: the strip, banner and speaking queue read this.
    expect(store.unread("phone-1", 10).map((u) => u.id)).toEqual([convId])
    expect(pushes).toEqual([{ deviceId: "phone-1", title: "Front", body: "The build is green.", url: `/app#chat=${convId}` }])
  })

  it("files each reply once, across polls and restarts", async () => {
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1"))
    const p = puller()
    expect(await p.tick()).toBe(1)
    expect(await p.tick()).toBe(0)
    // A restarted dashboard reads the same event again.
    expect(await puller().tick()).toBe(0)
    expect(store.get("phone-1", convId)!.messages.filter((m) => m.content === "The build is green.")).toHaveLength(1)
    expect(pushes).toHaveLength(1)
  })

  it("respects the phone's finish switch and an open app", async () => {
    finishOn = false
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1"))
    await puller().tick()
    expect(pushes).toHaveLength(0)

    finishOn = true
    presence.poll("phone-1")
    replies.set(`${PRIMARY}|dlg-2`, reply("dlg-2", { text: "Second answer." }))
    events.push(event("e2", "dlg-2"))
    await puller().tick()
    // The app is on screen: a banner from its own poll, no notification.
    expect(pushes).toHaveLength(0)
    expect(store.unread("phone-1", 10)).toHaveLength(1)
  })

  it("marks a failed delegation's report as an error", async () => {
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1", { status: "error", text: "The request to worker did not complete (timeout)." }))
    events.push(event("e1", "dlg-1"))
    await puller().tick()
    expect(store.get("phone-1", convId)!.messages.at(-1)).toMatchObject({ status: "error" })
    expect(pushes[0].body).toMatch(/^Could not answer: The request to worker/)
  })

  it("takes a peer's reply for a conversation with that peer's agent", async () => {
    const peerConv = store.create("phone-1", { node: "node-b", nodeName: "node-b", agent: "builder" }, "Fix CI", 1000)
    replies.set(`${PEER}|dlg-9`, reply("dlg-9", { chatId: `app:${peerConv.id}`, agent: "builder", text: "CI fixed." }))
    events.push(event("e1", "dlg-9", "node-b"))
    expect(await puller().tick()).toBe(1)
    expect(store.get("phone-1", peerConv.id)!.messages.at(-1)?.content).toBe("CI fixed.")
  })

  it("ignores a node answering for a conversation that is not its agent's", async () => {
    // node-b claims front's conversation on node-a.
    replies.set(`${PEER}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1", "node-b"))
    // Right node, wrong agent.
    replies.set(`${PRIMARY}|dlg-2`, reply("dlg-2", { agent: "worker" }))
    events.push(event("e2", "dlg-2"))
    // Not a phone chat.
    replies.set(`${PRIMARY}|dlg-3`, reply("dlg-3", { channel: "telegram", chatId: "chat-1" }))
    events.push(event("e3", "dlg-3"))
    expect(await puller().tick()).toBe(0)
    expect(store.get("phone-1", convId)!.messages).toHaveLength(2)
  })

  it("retries an event whose node is not known yet, then gives up", async () => {
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1"))
    let known = false
    const p = puller({ nodeUrl: async () => (known ? PRIMARY : null) })
    expect(await p.tick()).toBe(0)
    known = true
    expect(await p.tick()).toBe(1)

    events.push(event("e2", "dlg-2", "node-x"))
    const logs: string[] = []
    const q = puller({ log: (m) => logs.push(m) })
    for (let i = 0; i < CALLBACK_RETRIES + 1; i++) await q.tick()
    expect(logs.some((l) => l.includes("dlg-2"))).toBe(true)
  })

  it("keeps its place when the daemon is down", async () => {
    let down = true
    const p = puller({ recent: async () => { if (down) throw new Error("down"); return events } })
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1"))
    events.push(event("e1", "dlg-1"))
    expect(await p.tick()).toBe(0)
    down = false
    expect(await p.tick()).toBe(1)
  })

  it("skips other event types and a deleted conversation", async () => {
    events.push({ id: "e0", node: "node-a", kind: "delegation", type: "started", ref: "dlg-0" })
    replies.set(`${PRIMARY}|dlg-1`, reply("dlg-1", { chatId: "app:cnotaconversation1" }))
    events.push(event("e1", "dlg-1"))
    expect(await puller().tick()).toBe(0)
  })
})

describe("toAnswer", () => {
  it("strips the agentx:ui block and file lines like a streamed answer", () => {
    const text = "Done.\n\n```agentx:ui\n{\"buttons\":[{\"label\":\"Open\",\"url\":\"https://example.com\"}]}\n```"
    const a = toAnswer({ taskId: "d", channel: "app", chatId: "app:c1", agent: "front", text, status: "done", at: 1 }, 5)
    expect(a.row.content).toBe("Done.")
    expect(a.row.at).toBe(5)
    const plain = toAnswer({ taskId: "d", channel: "app", chatId: "app:c1", agent: "front", text, status: "done", plain: true, at: 1 }, 5)
    expect(plain.row.ui).toBeUndefined()
  })
})

describe("AppChatStore.appendOnce", () => {
  it("files a key once and only in the owner's conversation", () => {
    expect(store.ownerOf(convId)).toBe("phone-1")
    expect(store.ownerOf("cnotthere00")).toBeNull()
    const m = { role: "assistant" as const, content: "x", status: "done" as const, at: 3000 }
    expect(store.appendOnce("phone-2", convId, "k1", m)).toBeNull()
    expect(store.appendOnce("phone-1", convId, "k1", m)).toEqual([])
    expect(store.appendOnce("phone-1", convId, "k1", m)).toBeNull()
    expect(store.get("phone-1", convId)!.messages).toHaveLength(3)
  })
})
