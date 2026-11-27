import { describe, expect, it } from "vitest"
import { APP_CHAT_SCRIPT } from "../src/daemon/ui/pages/app-chat.client"
import { parseOpenHash } from "../src/daemon/ui/pages/app-voice-reply-logic"

// Switching conversations on the phone (2026-11-22): Anis talked to Rassam,
// switched to Hakim, and his voice notes landed in Rassam's chat. Until the
// conversation switched to is loaded, the chat still holds the old one, so
// words sent meanwhile must wait for the new one, never go to the old one.

type Pending = { path: string; body?: any; resolve: (r: any) => void; reject: (e: any) => void }

function el(): any {
  const e: any = {
    hidden: false, value: "", textContent: "", innerHTML: "", style: {}, open: false,
    classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, appendChild() {},
    insertBefore() {}, remove() {}, focus() {}, showModal() { e.open = true }, close() { e.open = false },
    querySelector: () => el(),
  }
  return e
}

function page() {
  const els: Record<string, any> = {}
  const pending: Pending[] = []
  const flashes: string[] = []
  const store: Record<string, string> = {}
  const fetch = (path: string, opts: any = {}) => new Promise((resolve, reject) => {
    pending.push({ path, body: opts.body ? JSON.parse(opts.body) : undefined, resolve, reject })
  })
  const document: any = {
    getElementById: (id: string) => (els[id] ||= el()),
    querySelector: () => el(),
    body: el(),
    addEventListener() {},
    dispatchEvent() {},
  }
  const queued: Array<{ text: string }> = []
  const window: any = {
    AXChatView: {
      NL: "\n", preview: (t: string) => t, setTools() {},
      cacheGet: () => Promise.resolve(null), cachePut() {}, cacheDrop() {},
      readStream: () => Promise.resolve(),
    },
    AXChatSheets: () => ({ loadPicker() {}, loadHistory() {} }),
    AXChatLog: () => ({
      scrollDown() {}, clear() {}, userMsg() {}, agentMsg: () => el(), setBody() {}, setNote() {},
      renderUi() {}, renderFiles() {}, renderConversation() {}, flash: (m: string) => flashes.push(m),
      queuedMsg: (text: string) => { const q = { text, el: el() }; queued.push(q); return q },
    }),
    AXSheet() {},
    addEventListener() {},
  }
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } }
  const navigator = { onLine: true }
  const location = { hash: "", reload() {} }
  const history = { replaceState() {} }
  // parseOpenHash is injected into the page once, ahead of Chat (#2103).
  new Function("window", "document", "fetch", "localStorage", "navigator", "location", "history", "CustomEvent", "requestAnimationFrame", "parseOpenHash", APP_CHAT_SCRIPT)(
    window, document, fetch, localStorage, navigator, location, history, class { constructor(public type: string, public init: any) {} }, () => 0, parseOpenHash)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const conv = (id: string, agent: string) => ({ id, agent, agentName: agent, node: "local", nodeName: "Mac", messages: [], running: false })
  const answer = async (match: (p: Pending) => boolean, body: any, status = 200) => {
    const i = pending.findIndex(match)
    expect(i, "a request is waiting").toBeGreaterThanOrEqual(0)
    const [p] = pending.splice(i, 1)
    p.resolve({ status, ok: status < 300, json: () => Promise.resolve(body), body: null })
    await tick(); await tick()
  }
  const chatPosts = () => pending.filter((p) => p.path === "/api/app/chat").map((p) => p.body)
  return { C: window.AXChat, els, pending, flashes, tick, conv, answer, chatPosts }
}

const rassam = "cmwrassam0001", hakim = "cmwhakim00001"

describe("switching conversation on the phone", () => {
  it("words said while the switch loads go to the new conversation, not the old one", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    expect(p.C.current()).toBe(rassam)

    p.C.open(hakim) // the load is still on its way
    expect(p.C.send("this is for Hakim", { spoken: true })).toBe(true)
    await p.tick()
    expect(p.chatPosts()).toEqual([]) // before: posted to Rassam's chat at once

    await p.answer((x) => x.path.endsWith(hakim), p.conv(hakim, "pm-agent"))
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "this is for Hakim", spoken: true }])
  })

  it("a switch that fails does not send to the old conversation and keeps the words", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.open(hakim)
    p.C.send("this is for Hakim", { spoken: true })
    await p.answer((x) => x.path.endsWith(hakim), { error: "busy" }, 500)
    expect(p.chatPosts()).toEqual([])
    expect(p.els["cx-input"].value).toBe("this is for Hakim")
    expect(p.flashes.join(" ")).toMatch(/did not open.*Still talking to artist-3d/)
    // The old conversation is the one on screen again: words now go there, as shown.
    p.C.send("now for Rassam")
    expect(p.chatPosts()).toEqual([{ conversationId: rassam, message: "now for Rassam" }])
  })

  it("a failed switch with nothing waiting still says so", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.open(hakim)
    const i = p.pending.findIndex((x) => x.path.endsWith(hakim))
    p.pending.splice(i, 1)[0].reject(new Error("offline"))
    await p.tick(); await p.tick()
    expect(p.flashes.join(" ")).toMatch(/did not open/)
  })

  it("switching again before the first switch loads gives the words back", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.open(hakim)
    p.C.send("said while opening Hakim")
    p.C.open("cmwother00001")
    expect(p.els["cx-input"].value).toBe("said while opening Hakim")
    await p.answer((x) => x.path.endsWith("cmwother00001"), p.conv("cmwother00001", "marketing-agent"))
    expect(p.chatPosts()).toEqual([])
  })

  it("opening the conversation already on screen does not hold sends", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.open(rassam) // e.g. coming back online
    p.C.send("still Rassam")
    expect(p.chatPosts()).toEqual([{ conversationId: rassam, message: "still Rassam" }])
  })
})

// Second path (2026-11-23 06:07Z): the voice bar took the chat at the moment
// the words came back, so a switch during recording or transcribing (the
// "Rassam finished" banner, a chip, a notification) moved them. The voice
// bar now pins the chat when recording starts and sends with sendTo.
describe("voice pinned to the chat open when recording started", () => {
  async function onHakim() {
    const p = page()
    p.C.open(hakim)
    await p.answer((x) => x.path.endsWith(hakim), p.conv(hakim, "pm-agent"))
    return p
  }

  it("a switch during recording does not move the words", async () => {
    const p = await onHakim()
    const pin = p.C.pin() // recording starts on Hakim
    p.C.open(rassam) // banner tap while speaking
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    expect(p.C.sendTo(pin, "this is for Hakim", { spoken: true })).toBe(true)
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "this is for Hakim", spoken: true }])
    await p.answer((x) => x.path === "/api/app/chat", {})
    expect(p.flashes.join(" ")).toMatch(/Sent to pm-agent/)
    expect(p.C.sentHere(hakim)).toBe(true)
  })

  it("a switch still loading when the words come back does not move them", async () => {
    const p = await onHakim()
    const pin = p.C.pin()
    p.C.open(rassam) // transcribe returns before Rassam's chat has loaded
    p.C.sendTo(pin, "this is for Hakim", { spoken: true })
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "this is for Hakim", spoken: true }])
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "this is for Hakim", spoken: true }])
  })

  it("no switch: a normal send in the chat on screen", async () => {
    const p = await onHakim()
    const pin = p.C.pin()
    p.C.sendTo(pin, "hello Hakim", { spoken: true })
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "hello Hakim", spoken: true }])
    expect(p.flashes).toEqual([])
  })

  it("recording started while a switch loaded: the words go to the chat being opened", async () => {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.open(hakim)
    const pin = p.C.pin()
    expect(pin.id).toBe(hakim)
    await p.answer((x) => x.path.endsWith(hakim), p.conv(hakim, "pm-agent"))
    p.C.sendTo(pin, "for Hakim")
    expect(p.chatPosts()).toEqual([{ conversationId: hakim, message: "for Hakim" }])
  })

  it("the pinned chat still answering: held as its next turn", async () => {
    const p = await onHakim()
    const pin = p.C.pin()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.sendTo(pin, "for Hakim later")
    await p.answer((x) => x.path === "/api/app/chat", { error: "busy" }, 409)
    expect(p.C.held(hakim)).toBe(1)
    expect(p.flashes.join(" ")).toMatch(/Sent to pm-agent when its answer is done/)
  })

  it("a failed background send gives the words back and says where they were meant", async () => {
    const p = await onHakim()
    const pin = p.C.pin()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    p.C.sendTo(pin, "for Hakim")
    await p.answer((x) => x.path === "/api/app/chat", { error: "x" }, 500)
    expect(p.els["cx-input"].value).toBe("for Hakim")
    expect(p.flashes.join(" ")).toMatch(/Not sent to pm-agent/)
    expect(p.chatPosts()).toEqual([])
  })
})

// Switch then talk (#2101 G, Hakim's v4 condition): on the phone Agents
// tab, a tap on an agent's row calls AXChat.with (app-agents.client.ts),
// which starts a new chat with that agent. Words said after the tap must
// go to the agent tapped, never to the conversation on screen before it.
describe("switch then talk: Agents tab tap, then voice", () => {
  const hakimRow = { node: "local", nodeName: "Mac", agent: "pm-agent", agentName: "Hakim", color: "#1f66e5" }
  const rassamRow = { node: "local", nodeName: "Mac", agent: "artist-3d", agentName: "Rassam" }

  async function onRassam() {
    const p = page()
    p.C.open(rassam)
    await p.answer((x) => x.path.endsWith(rassam), p.conv(rassam, "artist-3d"))
    return p
  }

  it("switch then talk: spoken words after the tap start a chat with the tapped agent", async () => {
    const p = await onRassam()
    p.C.with(hakimRow)
    expect(p.C.current()).toBeNull()
    expect(p.C.target()).toEqual(hakimRow)
    const pin = p.C.pin() // the voice bar starts recording after the tap
    expect(pin).toEqual({ id: null, target: hakimRow })
    expect(p.C.sendTo(pin, "this is for Hakim", { spoken: true })).toBe(true)
    expect(p.chatPosts()).toEqual([{ node: "local", agent: "pm-agent", message: "this is for Hakim", spoken: true }])
    expect(p.flashes).toEqual([])
  })

  it("switch then talk: typed words after the tap go to the tapped agent too", async () => {
    const p = await onRassam()
    p.C.with(hakimRow)
    p.C.send("typed for Hakim")
    expect(p.chatPosts()).toEqual([{ node: "local", agent: "pm-agent", message: "typed for Hakim" }])
  })

  it("switch then talk: a tap while still recording keeps the words with the chat recording started in", async () => {
    const p = await onRassam()
    const pin = p.C.pin() // recording starts in Rassam's chat
    p.C.with(hakimRow) // Agents tab tap while speaking
    p.C.sendTo(pin, "still for Rassam", { spoken: true })
    expect(p.chatPosts()).toEqual([{ conversationId: rassam, message: "still for Rassam", spoken: true }])
    await p.answer((x) => x.path === "/api/app/chat", {})
    expect(p.flashes.join(" ")).toMatch(/Sent to artist-3d/)
  })

  it("switch then talk: two taps, words go to the last agent tapped", async () => {
    const p = await onRassam()
    p.C.with(hakimRow)
    p.C.with(rassamRow)
    p.C.send("for a new Rassam chat", { spoken: true })
    expect(p.chatPosts()).toEqual([{ node: "local", agent: "artist-3d", message: "for a new Rassam chat", spoken: true }])
  })

  it("switch then talk: a tap while the old chat is answering does not hold the words for it", async () => {
    const p = await onRassam()
    p.C.send("Rassam, draw it")
    expect(p.C.busy()).toBe(true)
    p.C.with(hakimRow)
    expect(p.C.busy()).toBe(false)
    p.C.send("this is for Hakim", { spoken: true })
    expect(p.chatPosts()).toEqual([
      { conversationId: rassam, message: "Rassam, draw it" },
      { node: "local", agent: "pm-agent", message: "this is for Hakim", spoken: true },
    ])
  })
})
