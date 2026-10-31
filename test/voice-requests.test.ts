import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import {
  LIMITS, RESTART_REASON, VoiceRequestStore, handleVoiceRequests, isVoiceRequestsPath, type VoiceRequest,
} from "../src/daemon/voice-requests-api"
import { beginPhoneThread, finishPhoneThread } from "../src/daemon/voice-phone-thread"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"

// #1455: AgentX Voice's open-requests list is kept by the daemon, so it
// survives a restart and every client reads the same rows.

let tmp: string
let db: Database.Database
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-voice-requests-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

function deps(store: VoiceRequestStore | null = new VoiceRequestStore(db, T0)) {
  const stopped: string[] = []
  return {
    store,
    knows: (id: string) => id === "writer" || id === "researcher",
    stop: (r: VoiceRequest) => { stopped.push(r.agentId); return 1 },
    stopped,
  }
}

const answer = { agentId: "writer", voice: null, text: "Done.", full: "Done, see the notes.", ui: null }

describe("VoiceRequestStore", () => {
  it("lists open rows oldest first, through thinking, answered and heard", () => {
    const store = new VoiceRequestStore(db, T0)
    const a = store.create("writer", "draft the summary", false, T0)
    const b = store.create("researcher", "find the sources", false, T0 + 1000)
    expect(store.list().map((r) => [r.id, r.state, r.heard])).toEqual([[a.id, "thinking", false], [b.id, "thinking", false]])

    store.settle(a.id, 200, answer, T0 + 5000)
    expect(store.get(a.id)).toMatchObject({ state: "answered", since: T0 + 5000, heard: false })
    expect(store.reply(a.id)).toEqual(answer)

    store.heard(a.id, T0 + 6000)
    expect(store.get(a.id)?.heard).toBe(true)
    // The order never changes with a state.
    expect(store.list().map((r) => r.id)).toEqual([a.id, b.id])
  })

  it("a second request for a busy agent waits, and thinks once /ask takes it", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "and the title", true, T0)
    expect(r.state).toBe("waiting")
    store.start(r.id, T0 + 3000)
    expect(store.get(r.id)).toMatchObject({ state: "thinking", since: T0 + 3000 })
  })

  it("a failure keeps why, on one line; an error in a 200 is a failure too", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "q", false, T0)
    store.settle(r.id, 500, { error: "the model\nwas busy" })
    expect(store.get(r.id)).toMatchObject({ state: "failed", error: "the model was busy" })
    const s = store.create("writer", "q2", false, T0)
    store.settle(s.id, 200, { text: null, error: "no answer" })
    expect(store.get(s.id)?.state).toBe("failed")
  })

  it("words dropped for the floor holder were never a request", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "q", false, T0)
    store.settle(r.id, 200, { dropped: "floor" })
    expect(store.get(r.id)).toBeNull()
  })

  it("survives a restart; a row that was thinking says the answer was lost", () => {
    const first = new VoiceRequestStore(db, T0)
    const done = first.create("writer", "q1", false, T0)
    first.settle(done.id, 200, answer)
    const lost = first.create("researcher", "q2", false, T0)
    const waits = first.create("researcher", "q3", true, T0)

    const again = new VoiceRequestStore(db, T0 + 60_000)
    const rows = again.list()
    expect(rows.map((r) => r.id)).toEqual([done.id, lost.id, waits.id])
    expect(rows[0]).toMatchObject({ state: "answered", heard: false })
    expect(rows[1]).toMatchObject({ state: "failed", error: RESTART_REASON })
    expect(rows[2].state).toBe("waiting")
    expect(again.reply(done.id)).toEqual(answer)
  })

  it("closes, reopens, and closes every heard or failed row at once", () => {
    const store = new VoiceRequestStore(db, T0)
    const heard = store.create("writer", "q1", false, T0)
    store.settle(heard.id, 200, answer)
    store.heard(heard.id)
    const failed = store.create("writer", "q2", false, T0 + 1)
    store.settle(failed.id, 500, { error: "x" })
    const unheard = store.create("writer", "q3", false, T0 + 2)
    store.settle(unheard.id, 200, answer)
    const thinking = store.create("researcher", "q4", false, T0 + 3)

    expect(store.close(unheard.id)?.closed).toBe(true)
    expect(store.list().map((r) => r.id)).not.toContain(unheard.id)
    store.reopen(unheard.id)
    expect(store.list().map((r) => r.id)).toContain(unheard.id)

    expect(store.closeHeard()).toBe(2)
    expect(store.list().map((r) => r.id)).toEqual([unheard.id, thinking.id])
  })

  it("keeps the newest heard rows; the oldest heard leave by themselves", () => {
    const store = new VoiceRequestStore(db, T0)
    const ids: string[] = []
    for (let i = 0; i < LIMITS.keptHeard + 2; i++) {
      const r = store.create("writer", `q${i}`, false, T0 + i)
      store.settle(r.id, 200, answer)
      store.heard(r.id)
      ids.push(r.id)
    }
    expect(store.list().map((r) => r.id)).toEqual(ids.slice(2))
  })

  it("only ever answers its own ids", () => {
    const store = new VoiceRequestStore(db, T0)
    expect(store.get("../x")).toBeNull()
    store.settle("nope", 200, answer)
    expect(store.list()).toEqual([])
  })
})

describe("/voice/requests", () => {
  it("creates, lists and reads one back with its answer", () => {
    const d = deps()
    const made = handleVoiceRequests(d, "POST", "/voice/requests", { agentId: "writer", question: "draft it" })
    expect(made.status).toBe(201)
    const id = (made.body as any).request.id
    d.store!.settle(id, 200, answer)
    const list = handleVoiceRequests(d, "GET", "/voice/requests", {})
    expect((list.body as any).requests).toHaveLength(1)
    const one = handleVoiceRequests(d, "GET", `/voice/requests/${id}`, {})
    expect(one.body).toMatchObject({ request: { id, state: "answered" }, reply: answer })
  })

  it("refuses a request without words or for an unknown agent", () => {
    const d = deps()
    expect(handleVoiceRequests(d, "POST", "/voice/requests", { agentId: "writer" }).status).toBe(400)
    expect(handleVoiceRequests(d, "POST", "/voice/requests", { agentId: "ghost", question: "q" }).status).toBe(404)
    expect(handleVoiceRequests(d, "GET", "/voice/requests/rnope1234", {}).status).toBe(404)
    expect(handleVoiceRequests(deps(null), "GET", "/voice/requests", {}).status).toBe(503)
  })

  it("marks heard for every client", () => {
    const d = deps()
    const r = d.store!.create("writer", "q", false, T0)
    d.store!.settle(r.id, 200, answer)
    const reply = handleVoiceRequests(d, "POST", `/voice/requests/${r.id}/heard`, {})
    expect((reply.body as any).request.heard).toBe(true)
    // Another client, reading the list later, sees it heard.
    expect(new VoiceRequestStore(db).list()[0].heard).toBe(true)
  })

  it("closing a thinking row lets the agent finish unless stop is asked for", () => {
    const d = deps()
    const keep = d.store!.create("writer", "q1", false, T0)
    const closed = handleVoiceRequests(d, "POST", `/voice/requests/${keep.id}/close`, {})
    expect(closed.body).toMatchObject({ request: { closed: true }, stopped: 0 })
    expect(d.stopped).toEqual([])

    const stop = d.store!.create("researcher", "q2", false, T0)
    const stopped = handleVoiceRequests(d, "POST", `/voice/requests/${stop.id}/close`, { stop: true })
    expect(stopped.body).toMatchObject({ stopped: 1 })
    expect(d.stopped).toEqual(["researcher"])

    // An answered row is never "stopped".
    const done = d.store!.create("writer", "q3", false, T0)
    d.store!.settle(done.id, 200, answer)
    handleVoiceRequests(d, "POST", `/voice/requests/${done.id}/close`, { stop: true })
    expect(d.stopped).toEqual(["researcher"])

    // The answer of a closed row still lands, and Undo brings the row back.
    d.store!.settle(keep.id, 200, answer)
    handleVoiceRequests(d, "POST", `/voice/requests/${keep.id}/reopen`, {})
    expect(d.store!.list().find((r) => r.id === keep.id)).toMatchObject({ state: "answered", heard: false })
  })

  it("a follow-up continues its row: new words, thinking, not heard, no new row", () => {
    const d = deps()
    const r = d.store!.create("writer", "draft the summary", false, T0)
    d.store!.settle(r.id, 200, answer, T0 + 1000)
    d.store!.heard(r.id, T0 + 2000)
    const reply = handleVoiceRequests(d, "POST", `/voice/requests/${r.id}/continue`, { question: " make it shorter " })
    expect(reply.status).toBe(200)
    expect((reply.body as any).request).toMatchObject({ id: r.id, question: "make it shorter", state: "thinking", heard: false })
    expect(d.store!.reply(r.id)).toBeNull()
    expect(d.store!.list().map((x) => x.id)).toEqual([r.id])
    // Behind another request for the same agent, it waits.
    handleVoiceRequests(d, "POST", `/voice/requests/${r.id}/continue`, { question: "later", waiting: true })
    expect(d.store!.get(r.id)?.state).toBe("waiting")
    // A closed row comes back with its follow-up.
    d.store!.close(r.id)
    handleVoiceRequests(d, "POST", `/voice/requests/${r.id}/continue`, { question: "again" })
    expect(d.store!.get(r.id)).toMatchObject({ closed: false, state: "thinking" })
    expect(handleVoiceRequests(d, "POST", `/voice/requests/${r.id}/continue`, {}).status).toBe(400)
  })

  it("closes every heard row with one call, and refuses wrong methods", () => {
    const d = deps()
    expect(handleVoiceRequests(d, "POST", "/voice/requests/close-heard", {}).body).toEqual({ closed: 0 })
    expect(handleVoiceRequests(d, "GET", "/voice/requests/close-heard", {}).status).toBe(405)
    expect(handleVoiceRequests(d, "DELETE", "/voice/requests", {}).status).toBe(405)
  })
})

describe("voice requests gate and wiring", () => {
  it("every path is mesh-gated", () => {
    for (const p of ["/voice/requests", "/voice/requests/r1234abcd", "/voice/requests/r1234abcd/close"]) {
      expect(isVoiceRequestsPath(p)).toBe(true)
      expect(isMeshGatedPath(p)).toBe(true)
    }
    expect(isVoiceRequestsPath("/voice/requestsx")).toBe(false)
  })

  it("the daemon routes the list after the gate, and /ask settles its row", () => {
    const src = readFileSync(path.join(__dirname, "../src/daemon/index.ts"), "utf8")
    const gate = src.indexOf("if (isMeshGatedPath(path))")
    const route = src.indexOf("if (isVoiceRequestsPath(path))")
    expect(gate).toBeGreaterThan(0)
    expect(route).toBeGreaterThan(gate)
    const ask = src.slice(src.indexOf('case "POST /ask":'), src.indexOf('case "POST /mesh/task":'))
    expect(ask).toContain("this.voiceRequests?.start(requestId)")
    expect(ask).toContain("this.voiceRequests?.settle(requestId, status, out)")
    // Every answer of /ask goes through the one reply that settles the row.
    expect(ask.match(/this\.json\(res,/g)).toHaveLength(1)
    // A throw before reply() still settles the row, with the error.
    expect(ask).toMatch(/catch \(err\) \{[^}]*finishThread\(\{ content: "", error: why \}\)\s*if \(requestId && !settled\) \{\s*this\.voiceRequests\?\.settle\(requestId, 500,/)
    expect(ask).toContain("throw err")
    // The phone's question is answered on the queued return too, and the
    // spoken turn is marked so it waits on its chat with no phone prompt.
    expect(ask).toMatch(/if \(queued\) \{[\s\S]*?finishThread\(\{ content: "", error: text \}\)[\s\S]*?reply\(202,/)
    expect(ask).toContain('chatId: thread.chatId, via: "voice"')
  })

  it("a queued 202 leaves its row failed with what was said, not answered", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "draft the summary", false, T0)
    store.start(r.id, T0 + 1000)
    store.settle(r.id, 202, { text: "I'm still working on your last request. Give me a moment.", queued: true, pending: 1 }, T0 + 2000)
    expect(store.get(r.id)).toMatchObject({ state: "failed", error: "I'm still working on your last request. Give me a moment." })
  })

  it("a turn that throws leaves its row failed with the error, not thinking", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "draft the summary", false, T0)
    store.start(r.id, T0 + 1000)
    store.settle(r.id, 500, { error: "agent crashed" }, T0 + 2000)
    expect(store.get(r.id)).toMatchObject({ state: "failed", error: "agent crashed", since: T0 + 2000 })
  })
})

// The phone and the Mac share one conversation per agent, and one heard
// state: an answer heard on the Mac is read on the phone, and opened on
// the phone it is heard on the Mac.
describe("voice requests in the phone's conversations", () => {
  const agent = { id: "writer", name: "Writer", color: "#22aa88" }

  it("continues the phone's newest conversation with the agent, under its session key", () => {
    const store = new VoiceRequestStore(db, T0)
    const older = store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 5000)
    const newer = store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "second", T0 - 1000)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "researcher" }, "other", T0 - 500)
    store.chats.create("phone-1", { node: "peer-a", nodeName: "Peer", agent: "writer" }, "remote", T0 - 100)
    const r = store.create("writer", "draft the summary", false, T0)

    const thread = beginPhoneThread(store, r.id, agent, "draft the summary", "Home", T0 + 10)
    expect(thread).toEqual({ conversationId: newer.id, chatId: `app:${newer.id}` })
    expect(older.id).not.toBe(newer.id)
    expect(store.get(r.id)?.conversationId).toBe(newer.id)
    expect(store.chats.get("phone-1", newer.id)?.messages).toEqual([{ role: "user", content: "draft the summary", at: T0 + 10 }])

    finishPhoneThread(store.chats, thread!, { content: "Done, see the notes." }, T0 + 20)
    expect(store.chats.get("phone-1", newer.id)?.messages.at(-1)).toMatchObject({ role: "assistant", content: "Done, see the notes.", status: "done" })
    // The phone's strip shows it as an answer not opened yet.
    expect(store.chats.unread("phone-1", 10).map((u) => u.id)).toEqual([newer.id])
  })

  it("starts a conversation on the phone used last when the agent has none; none without a phone", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("writer", "q", false, T0)
    expect(beginPhoneThread(store, r.id, agent, "q", "Home", T0)).toBeNull()
    expect(store.get(r.id)?.conversationId).toBeNull()

    store.chats.create("phone-2", { node: "local", nodeName: "Home", agent: "researcher" }, "other", T0)
    const thread = beginPhoneThread(store, r.id, agent, "what is next", "Home", T0 + 5)!
    const conv = store.chats.get("phone-2", thread.conversationId)!
    expect(conv).toMatchObject({ agent: "writer", agentName: "Writer", color: "#22aa88", node: "local", title: "what is next" })
    // The same row asked again stays in its conversation.
    expect(beginPhoneThread(store, r.id, agent, "again", "Home", T0 + 6)?.conversationId).toBe(conv.id)
    expect(beginPhoneThread(store, "rnosuchrow1", agent, "q", "Home")).toBeNull()
  })

  it("heard on the Mac reads the conversation on the phone", () => {
    const store = new VoiceRequestStore(db, T0)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 1000)
    const r = store.create("writer", "q", false, T0)
    const thread = beginPhoneThread(store, r.id, agent, "q", "Home", T0)!
    finishPhoneThread(store.chats, thread, { content: "A." }, T0 + 100)
    store.settle(r.id, 200, answer, T0 + 100)
    expect(store.chats.unread("phone-1", 10)).toHaveLength(1)

    store.heard(r.id, T0 + 200)
    expect(store.chats.unread("phone-1", 10)).toEqual([])
  })

  it("opened on the phone after the answer, the row is heard; opened before, it is not", () => {
    const store = new VoiceRequestStore(db, T0)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 1000)
    const r = store.create("writer", "q", false, T0)
    const thread = beginPhoneThread(store, r.id, agent, "q", "Home", T0)!
    store.chats.markRead("phone-1", thread.conversationId, T0 + 50)
    expect(store.get(r.id)?.heard).toBe(false)

    finishPhoneThread(store.chats, thread, { content: "A." }, T0 + 100)
    store.settle(r.id, 200, answer, T0 + 100)
    expect(store.list()[0]).toMatchObject({ id: r.id, heard: false })
    store.chats.markRead("phone-1", thread.conversationId, T0 + 300)
    expect(store.list()[0]).toMatchObject({ id: r.id, heard: true })
    // "Close heard" counts it as heard.
    expect(store.closeHeard(T0 + 400)).toBe(1)
  })

  it("a failure is saved for the phone with why", () => {
    const store = new VoiceRequestStore(db, T0)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 1000)
    const r = store.create("writer", "q", false, T0)
    const thread = beginPhoneThread(store, r.id, agent, "q", "Home", T0)!
    finishPhoneThread(store.chats, thread, { content: "", error: "the model was busy" }, T0 + 100)
    expect(store.chats.unread("phone-1", 10)[0]).toMatchObject({ id: thread.conversationId, status: "error" })
  })

  it("closing an unheard answer reads it on the phone too", () => {
    const store = new VoiceRequestStore(db, T0)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 1000)
    const r = store.create("writer", "q", false, T0)
    const thread = beginPhoneThread(store, r.id, agent, "q", "Home", T0)!
    finishPhoneThread(store.chats, thread, { content: "A." }, T0 + 100)
    store.settle(r.id, 200, answer, T0 + 100)
    store.close(r.id, T0 + 200)
    expect(store.chats.unread("phone-1", 10)).toEqual([])
  })

  it("a thinking row in a phone conversation is stopped under that conversation", () => {
    const store = new VoiceRequestStore(db, T0)
    store.chats.create("phone-1", { node: "local", nodeName: "Home", agent: "writer" }, "first", T0 - 1000)
    const r = store.create("writer", "q", false, T0)
    const thread = beginPhoneThread(store, r.id, agent, "q", "Home", T0)!
    const seen: Array<string | null> = []
    handleVoiceRequests({ store, knows: () => true, stop: (row) => { seen.push(row.conversationId); return 1 } },
      "POST", `/voice/requests/${r.id}/close`, { stop: true })
    expect(seen).toEqual([thread.conversationId])
  })

  it("a database from before the phone link gains the column", () => {
    db.exec(`CREATE TABLE voice_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, question TEXT NOT NULL,
      state TEXT NOT NULL, sent_at INTEGER NOT NULL, since INTEGER NOT NULL,
      heard_at INTEGER, closed_at INTEGER, reply TEXT, error TEXT)`)
    db.prepare("INSERT INTO voice_requests (id, agent_id, question, state, sent_at, since) VALUES ('rold0000001', 'writer', 'q', 'answered', 1, 1)").run()
    const store = new VoiceRequestStore(db, T0)
    expect(store.get("rold0000001")).toMatchObject({ conversationId: null, heard: false })
  })
})
