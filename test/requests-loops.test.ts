import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi, handleRequestsCall, MAX_OPEN_PROMISES, type RequestsApiDeps } from "../src/requests/daemon-api"
import { runRequestsSweep, attentionText } from "../src/requests/sweep"
import { stalledLoops, waitsOn } from "../src/requests/loops"
import { runRequestTool } from "../src/requests/tool"
import type { CheckResult } from "../src/requests/checkers"
import { handleRequestsPanel } from "../src/daemon/requests-panel"

// Open loops (#1039): an agent's promise, a due time, and a check that
// closes the loop on evidence instead of on the agent's word.

const HOUR = 3_600_000
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const AGENTS = new Set(["coder", "devops"])

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let clock: number
let verdict: CheckResult
let checks: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-loops-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  verdict = { verdict: "not_met", detail: "not yet" }
  checks = 0
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const check = async () => { checks++; return verdict }

const deps = (over: Partial<RequestsApiDeps> = {}): RequestsApiDeps & { check: typeof check } => ({
  store, tracker, enabled: true, hasAgent: (id) => AGENTS.has(id), now: clock,
  runningTurn: (agentId) => (AGENTS.has(agentId) ? { channel: "telegram", chatId: "chat-1" } : null),
  check, ...over,
})

const post = (body: Record<string, unknown>, over: Partial<RequestsApiDeps> = {}) =>
  handleRequestsCall("POST", "/requests", body, { ...deps(over), now: clock })

const promise = (extra: Record<string, unknown> = {}, over: Partial<RequestsApiDeps> = {}) =>
  post({ action: "promise", agentId: "coder", owedTo: "client-a", text: "Send the signed file", ...extra }, over)

function ownerTurn(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, messagePreview: "ship it", fullMessage: "ship it",
    at: "", humanRoot: true, sender: { id: "4242" }, person: { id: "owner" },
  } as any)
}

const sweep = () => runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: (id) => AGENTS.has(id), tellAgent: async () => {}, check })

describe("promise", () => {
  it("opens a loop owed to someone, with a due time and a check, listed with the open requests", async () => {
    const res = await promise({ due: "2030-03-03T17:00:00Z", closeWhen: { kind: "url", url: "https://example.com/file", contains: "signed" } })
    expect(res.status).toBe(200)
    const r = (res.body as any).request
    expect(r).toMatchObject({
      state: "in_progress", agentId: "coder", owedTo: "client-a", promise: true, dueAt: Date.parse("2030-03-03T17:00:00Z"),
      closeWhen: { kind: "url", url: "https://example.com/file", contains: "signed" }, channel: "telegram", chatId: "chat-1",
    })
    expect(r.id).toMatch(/^prm-/)
    const list = handleRequestsApi("GET", "/requests", undefined, deps())
    expect((list.body as any).items.map((x: any) => x.id)).toEqual([r.id])
  })

  it("refuses a promise without owedTo or text, to itself, with a bad due time or check, or from no running turn", async () => {
    expect((await post({ action: "promise", agentId: "coder", text: "x" })).status).toBe(400)
    expect((await post({ action: "promise", agentId: "coder", owedTo: "client-a" })).status).toBe(400)
    expect((await promise({ owedTo: "coder" })).status).toBe(400)
    expect((await promise({ due: "next friday" })).body).toMatchObject({ error: expect.stringMatching(/ISO date/) })
    expect((await promise({ closeWhen: { kind: "url", url: "ftp://x" } })).status).toBe(400)
    expect((await promise({ closeWhen: { kind: "url", url: "https://x" } }, { checkers: { enabled: ["issue"], checkEveryMinutes: 10, repos: {} } })).body)
      .toMatchObject({ error: expect.stringMatching(/turned off/) })
    expect((await promise({}, { runningTurn: () => null })).status).toBe(403)
    expect(store.listOpen()).toEqual([])
  })

  it("caps the open promises of one agent", async () => {
    for (let i = 0; i < MAX_OPEN_PROMISES; i++) {
      store.addPromise({ id: `prm-${i}`, channel: "telegram", chatId: "chat-1", agentId: "coder", text: "x", owedTo: "client-a", now: clock })
    }
    expect((await promise()).status).toBe(409)
    expect((await post({ action: "promise", agentId: "devops", owedTo: "coder", text: "y" })).status).toBe(200)
  })

  it("the tool passes it through and says what happens next", async () => {
    const fake = (async (_url: string, init: any) => {
      const reply = await handleRequestsCall("POST", "/requests", JSON.parse(init.body), deps())
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    }) as unknown as typeof fetch
    const text = await runRequestTool(
      { action: "promise", owedTo: "client-a", text: "Send the file", due: "2030-03-03T17:00:00Z", closeWhen: { kind: "reply", channel: "telegram", chatId: "9", from: "client-a" } },
      { daemonUrl: "http://127.0.0.1:1", fetch: fake, env: { AGENTX_AGENT_ID: "coder" } as any },
    )
    expect(text).toMatch(/^Promise prm-\S+ is open, owed to client-a, due 2030-03-03 17:00 UTC\. The daemon checks its evidence/)
  })
})

describe("done on a loop with a check", () => {
  const withCheck = async () => ((await promise({ closeWhen: { kind: "url", url: "https://example.com/v" } })).body as any).request.id as string

  it("is refused while the check says not met, and marked failed", async () => {
    const id = await withCheck()
    const res = await post({ action: "done", agentId: "coder", id, evidence: "I sent it" })
    expect(res.status).toBe(409)
    expect((res.body as any).error).toMatch(/not finished \(not yet\)/)
    expect(store.get(id)).toMatchObject({ state: "in_progress", verifyState: "failed", verifyDetail: "not yet" })
  })

  it("stays open and is marked unverified when the check cannot say", async () => {
    const id = await withCheck()
    verdict = { verdict: "unverifiable", detail: "could not be reached" }
    const res = await post({ action: "done", agentId: "coder", id, evidence: "I sent it" })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ verify: "unverified", detail: "could not be reached" })
    expect(store.get(id)).toMatchObject({ state: "in_progress", verifyState: "unverified" })
  })

  it("closes with the checker's evidence when met", async () => {
    const id = await withCheck()
    verdict = { verdict: "met", detail: "https://example.com/v answered" }
    const res = await post({ action: "done", agentId: "coder", id, evidence: "https://example.com/pr/1" })
    expect(res.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "verified", evidence: "https://example.com/v answered (agent: https://example.com/pr/1)" })
  })

  it("a node with no checker leaves it open as unverified", async () => {
    const id = await withCheck()
    const res = await handleRequestsCall("POST", "/requests", { action: "done", agentId: "coder", id }, { ...deps(), check: undefined })
    expect(res.status).toBe(202)
    expect(store.get(id)?.verifyState).toBe("unverified")
  })

  it("accept and wait give an owner's request a check and a due time", async () => {
    ownerTurn("t1")
    expect((await post({ action: "accept", agentId: "coder", due: "2030-03-02T09:00:00Z", closeWhen: { kind: "issue", provider: "github", ref: "acme/app#12" } })).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ owedTo: "owner", dueAt: Date.parse("2030-03-02T09:00:00Z"), closeWhen: { kind: "issue", ref: "acme/app#12" } })
    expect((await post({ action: "done", agentId: "coder", evidence: "merged" })).status).toBe(409)
  })
})

describe("requests without the new fields", () => {
  it("close on the agent's word, as before, and never run a check", async () => {
    ownerTurn("t1")
    await post({ action: "accept", agentId: "coder" })
    expect(store.get("req-t1")).toMatchObject({ dueAt: null, closeWhen: null, promise: false, verifyState: null })
    expect((await post({ action: "done", agentId: "coder", evidence: "https://example.com/pr/1" })).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.com/pr/1" })
    expect(checks).toBe(0)
  })

  it("a database from before the loops gets the columns, and its rows read as before", () => {
    const old = new Database(":memory:")
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT,
      agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attention_reason TEXT,
      notified_at INTEGER, question TEXT, closed_at INTEGER, evidence TEXT, close_reason TEXT)`)
    old.prepare("INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at) VALUES ('r1', 'in_progress', 'voice', 'mac', 'coder', 'x', 1, 1)").run()
    const s = new RequestStore(old)
    expect(s.get("r1")).toMatchObject({ owedTo: null, promise: false, dueAt: null, closeWhen: null, verifyState: null })
    old.close()
  })
})

describe("the requests check", () => {
  it("closes a loop once its check is met, with the checker's evidence, and checks each loop at its pace", async () => {
    const id = ((await promise({ closeWhen: { kind: "url", url: "https://example.com/v" } })).body as any).request.id
    expect((await sweep()).checked).toBe(1)
    expect(store.get(id)?.state).toBe("in_progress")
    clock += 5 * 60_000
    expect((await sweep()).checked).toBe(0)
    clock += 6 * 60_000
    verdict = { verdict: "met", detail: "https://example.com/v answered" }
    expect(await sweep()).toMatchObject({ checked: 1, verified: 1 })
    expect(store.get(id)).toMatchObject({ state: "done", evidence: "https://example.com/v answered", verifyState: "verified" })
    expect(checks).toBe(2)
  })

  it("marks a loop unverified when its check cannot say, and keeps a refused done failed while it is not met", async () => {
    const id = ((await promise({ closeWhen: { kind: "url", url: "https://example.com/v" } })).body as any).request.id
    verdict = { verdict: "unverifiable", detail: "down" }
    await sweep()
    expect(store.get(id)?.verifyState).toBe("unverified")
    clock += 11 * 60_000
    verdict = { verdict: "not_met", detail: "not yet" }
    await post({ action: "done", agentId: "coder", id })
    clock += 11 * 60_000
    await sweep()
    expect(store.get(id)?.verifyState).toBe("failed")
  })

  it("raises a loop past its due time, not by the global quiet time, and tells the owner who it waits on", async () => {
    const notices: string[] = []
    const id = ((await promise({ due: clock + 2 * HOUR })).body as any).request.id
    clock += HOUR
    await sweep()
    expect(store.get(id)?.state).toBe("in_progress")
    clock += 2 * HOUR
    const res = await runRequestsSweep({ store, settings, log: () => {}, now: clock, hasAgent: (a) => AGENTS.has(a), notify: async (title, text) => { notices.push(`${title}\n${text}`) } })
    expect(res.quiet).toBe(1)
    expect(store.get(id)).toMatchObject({ state: "needs_attention", attentionReason: "Past its due time (2030-03-01 14:00 UTC)" })
    expect(notices[0]).toMatch(/^Promise not kept\nA promise coder made to client-a is not kept yet\./)
    expect(notices[0]).toMatch(/Waiting on: client-a \(outside person\)/)
  })

  it("a loop handed on after its due time gets the usual quiet time before it comes back", async () => {
    const id = ((await promise({ due: clock + HOUR })).body as any).request.id
    clock += 2 * HOUR
    await sweep()
    expect(store.get(id)?.state).toBe("needs_attention")
    store.handOff(id, "devops", "take this one", clock)
    clock += HOUR
    await sweep()
    expect(store.get(id)?.state).toBe("in_progress")
    clock += 24 * HOUR
    await sweep()
    expect(store.get(id)?.state).toBe("needs_attention")
  })

  it("an owner's request with no due time comes back after staleAfterHours, as before", async () => {
    ownerTurn("t1")
    await post({ action: "accept", agentId: "coder" })
    clock += 25 * HOUR
    await sweep()
    expect(store.get("req-t1")?.attentionReason).toBe("No activity for 24 h")
    expect(attentionText(store.get("req-t1")!)).toMatch(/Waiting on: you\nNothing is retrying it\. Ask again, or drop it\.$/)
  })
})

describe("the stalled view", () => {
  async function fill() {
    // Waiting on the owner, quiet for two days.
    ownerTurn("t1")
    await post({ action: "wait", agentId: "coder", question: "Staging or production?" })
    // An agent's promise to another agent, past due.
    store.addPromise({ id: "prm-agent", channel: "telegram", chatId: "chat-1", agentId: "devops", text: "deploy after review", owedTo: "coder", dueAt: clock + HOUR, now: clock })
    // A promise to an outside person, past due.
    store.addPromise({ id: "prm-person", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "send the file", owedTo: "client-a", dueAt: clock + HOUR, now: clock })
    // Not due yet: not stalled.
    store.addPromise({ id: "prm-later", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "call back", owedTo: "client-a", dueAt: clock + 30 * 24 * HOUR, now: clock })
    clock += 48 * HOUR
  }

  it("groups stalled loops by owner, agent and outside person", async () => {
    await fill()
    const g = stalledLoops(store.listOpen(), 24, clock, { isAgent: (id) => AGENTS.has(id) })
    expect(g.owner.map((l) => l.request.id)).toEqual(["req-t1"])
    expect(g.agent.map((l) => [l.request.id, l.who])).toEqual([["prm-agent", "devops"]])
    expect(g.person.map((l) => [l.request.id, l.who])).toEqual([["prm-person", "client-a"]])
    expect(g.person[0].why).toBe("past its due time (2030-03-01 13:00 UTC)")
  })

  it("an active plan step is what the loop waits on", () => {
    store.addPromise({ id: "p1", channel: "telegram", chatId: "c", agentId: "coder", text: "x", owedTo: "owner", now: clock })
    expect(waitsOn(store.get("p1")!, { isAgent: (id) => AGENTS.has(id), activeStepAgent: () => "devops" })).toEqual({ group: "agent", who: "devops" })
  })

  it("the panel counts them and shows each card's loop", async () => {
    await fill()
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: { coder: {}, devops: {} }, requests: { enabled: true } }))
    const r = await handleRequestsPanel("GET", "/api/admin/approvals/requests", {}, { root: tmp, requests: store, now: clock, configPath, reload: false } as any)
    const body = r.body as any
    expect(body.stalled).toEqual({ owner: 1, agent: 1, person: 1 })
    const person = body.items.find((c: any) => c.id === "prm-person")
    expect(person.loop).toMatchObject({ owedTo: "client-a", promise: true, dueAt: Date.parse("2030-03-01T13:00:00Z") })
    expect(person.stall).toMatchObject({ group: "person", who: "client-a" })
    expect(body.items.find((c: any) => c.id === "prm-later").stall).toBeNull()
  })
})

describe("the owner closes a loop by hand", () => {
  it("with a reason, past its check, from the panel", async () => {
    const id = ((await promise({ closeWhen: { kind: "url", url: "https://example.com/v" } })).body as any).request.id
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: {}, requests: { enabled: true } }))
    const ctx = { root: tmp, requests: store, now: clock, configPath, reload: false } as any
    const res = await handleRequestsPanel("POST", "/api/admin/approvals/requests/close", { id, action: "done", evidence: "checked by hand" }, ctx)
    expect(res.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", evidence: "closed by owner: checked by hand" })
    expect(checks).toBe(0)
  })
})
