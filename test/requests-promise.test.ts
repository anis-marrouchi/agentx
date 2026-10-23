import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { Command } from "commander"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall, type RequestsApiDeps } from "../src/requests/daemon-api"
import { runRequestsSweep } from "../src/requests/sweep"
import {
  attachPromiseFacts, closeWatcherLoop, DEFAULT_PROMISE_SETTINGS, openPromise, parseProof, promiseFact, raiseWatcherLoop, watcherNotice,
  type PromiseSettings,
} from "../src/requests/promise"
import type { CheckResult } from "../src/requests/checkers"
import { WatcherStore } from "../src/watchers/store"
import { WatchCheckpoint, type WatcherSettings } from "../src/watchers/checkpoint"
import { FactLedger, isStaleFact } from "../src/wiki/facts/ledger"
import { registerWikiFacts } from "../src/commands/wiki-facts"
import { requestsConfigSchema } from "../src/daemon/config"

// One Promise, proof that leaves a Fact (#1138 step D).

const HOUR = 3_600_000
const MIN = 60_000
const AGENTS = new Set(["coder", "devops"])

let tmp: string
let wikiDir: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let promises: PromiseSettings
let clock: number
let verdict: CheckResult
let logs: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-promise-"))
  wikiDir = path.join(tmp, "wiki")
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY)")
  store = new RequestStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  promises = { ...DEFAULT_PROMISE_SETTINGS }
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90, promises }
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  verdict = { verdict: "met", detail: "the issue is closed" }
  logs = []
  attachPromiseFacts(store, { settings: () => promises, ledger: () => new FactLedger(wikiDir), log: (m) => logs.push(m), now: () => clock })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const deps = (over: Partial<RequestsApiDeps> = {}): RequestsApiDeps & { check: () => Promise<CheckResult> } => ({
  store, tracker, enabled: true, hasAgent: (id) => AGENTS.has(id), now: clock, promiseSettings: promises,
  runningTurn: (agentId) => (AGENTS.has(agentId) ? { channel: "telegram", chatId: "chat-1" } : null),
  check: async () => verdict, ...over,
})
const post = (body: Record<string, unknown>, over: Partial<RequestsApiDeps> = {}) => handleRequestsCall("POST", "/requests", body, deps(over))

async function promise(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post({ action: "promise", agentId: "coder", owedTo: "client-a", text: "Deploy the login fix to production", ...extra })
  expect(res.status).toBe(200)
  return (res.body as any).request.id
}
const done = (id: string, extra: Record<string, unknown>) => post({ action: "done", agentId: "coder", id, ...extra })
const facts = () => new FactLedger(wikiDir).list()

describe("proof types", () => {
  const now = Date.parse("2030-03-01T12:00:00Z")

  it("reads a link, a passing test run, an output and a check that ran", () => {
    expect(parseProof("https://example.com/pull/7", now)).toEqual({ kind: "link", value: "https://example.com/pull/7", ranAt: now })
    expect(parseProof({ kind: "link", url: "https://example.com/pull/7" }, now)).toMatchObject({ kind: "link", value: "https://example.com/pull/7" })
    expect(parseProof({ kind: "test", passed: 12, failed: 0, command: "pnpm test" }, now))
      .toEqual({ kind: "test", value: "pnpm test", ranAt: now, passed: 12, failed: 0 })
    expect(parseProof({ kind: "output", text: "v1.2.3 is live" }, now)).toEqual({ kind: "output", value: "v1.2.3 is live", ranAt: now })
    expect(parseProof({ kind: "check", value: "curl /health said 0.154.2", ranAt: "2030-03-01T11:00:00Z" }, now))
      .toEqual({ kind: "check", value: "curl /health said 0.154.2", ranAt: Date.parse("2030-03-01T11:00:00Z") })
  })

  it("is not a proof: a failed or empty test run, plain words, an unknown kind, a check with nothing found", () => {
    expect(parseProof(undefined, now)).toBeNull()
    expect(parseProof({ kind: "test", passed: 12, failed: 1 }, now)).toMatch(/1 failed/)
    expect(parseProof({ kind: "test", passed: 0, failed: 0 }, now)).toMatch(/at least one passed/)
    expect(parseProof("it is deployed", now)).toMatch(/link/)
    expect(parseProof({ kind: "vibes", value: "x" }, now)).toMatch(/link, test, output, check/)
    expect(parseProof({ kind: "check" }, now)).toMatch(/check proof needs value/)
    expect(parseProof({ kind: "check", value: "x", ranAt: "soon" }, now)).toMatch(/ranAt/)
    // A check can't be dated after it happened.
    expect(parseProof({ kind: "check", value: "x", ranAt: now + HOUR }, now)).toMatchObject({ ranAt: now })
  })
})

describe("done on a promise", () => {
  it("is refused without a proof, and the promise stays open", async () => {
    const id = await promise()
    const res = await done(id, { evidence: "deployed it" })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ proofRequired: true, error: expect.stringMatching(/only with a proof/) })
    expect(store.get(id)?.state).toBe("in_progress")
    expect((await done(id, { evidence: "deployed", proof: { kind: "test", passed: 3, failed: 2 } })).status).toBe(400)
    expect(store.get(id)?.state).toBe("in_progress")
    expect(facts()).toEqual([])
  })

  it.each([
    ["link", { evidence: "https://example.com/pull/7" }, "link: https://example.com/pull/7"],
    ["test", { proof: { kind: "test", passed: 41, failed: 0, command: "pnpm test" } }, "test: pnpm test (41 passed, 0 failed)"],
    ["output", { proof: { kind: "output", text: "agentx 0.154.2 on both hosts" } }, "output: agentx 0.154.2 on both hosts"],
    ["check", { proof: { kind: "check", value: "GET /health said 0.154.2" } }, "check: GET /health said 0.154.2"],
  ])("closes with a %s proof and leaves a checked fact", async (kind, body, source) => {
    const id = await promise()
    const res = await done(id, body)
    expect(res.status).toBe(200)
    const r = store.get(id)!
    expect(r).toMatchObject({ state: "done", proof: { kind }, factId: expect.stringMatching(/^f-/) })
    const [f] = facts()
    expect(f).toMatchObject({
      id: r.factId, subject: "Deploy the login fix to production", attribute: "done", value: "yes",
      source: `${source} (${id})`, verifiedBy: "coder", verifiedAt: new Date(clock).toISOString(), volatility: "work-state", ttlDays: 7,
    })
    expect(f.undated).toBeUndefined()
    // Trusted for factTtlDays, then stale.
    expect(isStaleFact(f, clock + 6 * 24 * HOUR)).toBe(false)
    expect(isStaleFact(f, clock + 8 * 24 * HOUR)).toBe(true)
  })

  it("on a loop with a check, the check that ran is the proof", async () => {
    const id = await promise({ closeWhen: { kind: "issue", provider: "github", ref: "example-org/app#12" } })
    expect((await done(id, {})).status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", proof: { kind: "check", value: "the issue is closed" } })
    expect(facts()[0].source).toBe(`check: the issue is closed (${id})`)
  })

  it("closes without a proof and leaves no fact when requireProof is off; a plain request never needs one", async () => {
    promises.requireProof = false
    const id = await promise()
    expect((await done(id, { evidence: "deployed it" })).status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", proof: null, factId: null })
    expect(facts()).toEqual([])
  })

  it("leaves no fact when facts are off", async () => {
    promises.facts = false
    const id = await promise()
    expect((await done(id, { evidence: "https://example.com/pull/7" })).status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", proof: { kind: "link" }, factId: null })
    expect(facts()).toEqual([])
  })

  it("never breaks the close when the fact cannot be written", async () => {
    const broken = new RequestStore(db)
    attachPromiseFacts(broken, { settings: () => promises, ledger: () => ({ write: () => { throw new Error("disk full") } }), log: (m) => logs.push(m) })
    const p = openPromise(broken, { agentId: "coder", owedTo: "owner", text: "x", channel: "telegram", chatId: "c", now: clock })
    expect(broken.close(p.id, "done", "https://example.com/1", clock, { kind: "link", value: "https://example.com/1", ranAt: clock })).toBe(true)
    expect(broken.get(p.id)?.state).toBe("done")
    expect(logs.some((l) => l.includes("could not write its fact: disk full"))).toBe(true)
  })
})

describe("the fact in `agentx wiki facts list`", () => {
  it("lists the fact a kept promise left, with source and check date", async () => {
    const id = await promise()
    await done(id, { proof: { kind: "check", value: "GET /health said 0.154.2" } })
    const out: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")) })
    try {
      const program = new Command()
      registerWikiFacts(program.command("wiki"))
      await program.parseAsync(["node", "agentx", "wiki", "facts", "list", "--dir", wikiDir, "--json"])
    } finally {
      spy.mockRestore()
    }
    const listed = JSON.parse(out.join("\n"))
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      subject: "Deploy the login fix to production", attribute: "done", value: "yes",
      source: `check: GET /health said 0.154.2 (${id})`, verifiedAt: "2030-03-01T12:00:00.000Z", ttlDays: 7,
    })
  })
})

describe("the API for later steps: openPromise", () => {
  it("opens a promise an agent owes, due when given, linked to what it follows", () => {
    const p = openPromise(store, {
      agentId: "coder", owedTo: "owner", text: "Send the brochure", channel: "telegram", chatId: "chat-1",
      dueAt: clock + HOUR, link: { kind: "run", ref: "trace-9" }, headline: "Brochure to the owner", now: clock,
    })
    expect(store.get(p.id)).toMatchObject({ promise: true, state: "in_progress", owedTo: "owner", owedBy: null, dueAt: clock + HOUR, headline: "Brochure to the owner" })
    expect(store.byLink("run", "trace-9")?.id).toBe(p.id)
  })

  it("a promise owed by the owner waits on the owner from the start, and records the owner's answer as its fact", () => {
    const p = openPromise(store, { agentId: "coder", owedTo: "coder", owedBy: "owner", text: "Pick staging or production", channel: "approvals", chatId: "card-1", now: clock })
    expect(store.get(p.id)).toMatchObject({ state: "waiting_owner", owedBy: "owner" })
    expect(promiseFact(store.get(p.id)!, { kind: "output", value: "yes: production", ranAt: clock }, promises))
      .toMatchObject({ attribute: "owner's answer", value: "yes: production", verifiedBy: "owner" })
  })
})

describe("one escalation path", () => {
  const WATCH: WatcherSettings = {
    enabled: true, skipChannels: [], defaultDueMinutes: 120, noBelow: 0.2, yesAt: 0.7,
    escalateAfterMinutes: 30, retentionDays: 30, doneSignal: "result",
  }

  function checkpoint(ownerAlerts: string[]) {
    const watchers = new WatcherStore(db)
    const cp = new WatchCheckpoint({
      store: watchers, settings: () => WATCH, decide: async () => ({ probability: 0.9, callId: null, mode: "active" }),
      hasAgent: (id) => AGENTS.has(id), alertAgent: async () => {}, alertOwner: async (title) => { ownerAlerts.push(title) },
      raise: (w, reason) => { raiseWatcherLoop(store, w, reason, clock); return true },
      onClosed: (w, outcome) => { if (outcome === "done") closeWatcherLoop(store, watchers.get(w.id) ?? w, clock) },
      log: () => {}, now: () => clock,
    })
    return { cp, watchers }
  }

  it("a task watcher that fires opens a promise for its task; the requests check tells the owner once; done with evidence closes it with a fact", async () => {
    const ownerAlerts: string[] = []
    const { cp, watchers } = checkpoint(ownerAlerts)
    await cp.check({ key: "trace-1", traceId: "trace-1", kind: "dispatch", agentId: "devops", channel: "cron", delegator: null, message: "renew the TLS certificate", dueAt: clock + HOUR })
    const w = watchers.list()[0]
    clock += 2 * HOUR
    await cp.sweep()
    // Not the watcher's own push: the request loop's.
    expect(ownerAlerts).toEqual([])
    const r = store.byLink("watcher", w.id)!
    expect(r).toMatchObject({ promise: true, agentId: "devops", owedTo: "owner", state: "needs_attention", attentionReason: expect.stringMatching(/^Task watcher /) })
    const told: Array<{ title: string; kind?: string }> = []
    const sweep = () => runRequestsSweep({
      store, settings, now: clock, log: () => {}, noticeFor: watcherNotice,
      notify: async (title, _m, _r, kind) => { told.push({ title, kind }) },
    })
    await sweep()
    await sweep()
    expect(told).toEqual([{ title: "A task is not finished", kind: "notice" }])
    // Marked done with a link: the promise closes with it as proof.
    expect(cp.markDone(w.id, "https://example.com/cert/renewed").changed).toBe(true)
    expect(store.get(r.id)).toMatchObject({ state: "done", proof: { kind: "link", value: "https://example.com/cert/renewed" }, factId: expect.any(String) })
    expect(facts()[0]).toMatchObject({ subject: "renew the TLS certificate", attribute: "done", verifiedBy: "devops" })
  })

  it("a watcher on handed-on work raises the request that follows it, and does not open a second record", () => {
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "ship it", fullMessage: "ship it",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    tracker.delegationStarted({ id: "dlg-1", caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } } as any)
    const res = raiseWatcherLoop(store, { id: "watch-dlg-1", taskKey: "dlg-1", traceId: null, agentId: "devops", delegator: "coder", summary: "deploy", dueAt: clock }, "the due time passed", clock)
    expect(res).toMatchObject({ requestId: "req-t1", opened: false, raised: true })
    expect(store.byLink("watcher", "watch-dlg-1")?.id).toBe("req-t1")
    expect(store.listByState("needs_attention").map((r) => r.id)).toEqual(["req-t1"])
  })

  it("a follow-up wait that runs out comes back through the requests check, not a path of its own", async () => {
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "ship it", fullMessage: "ship it",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    tracker.delegationStarted({ id: "dlg-1", caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } } as any)
    tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", durationMs: 1, at: "" } as any)
    tracker.delegationDone({ id: "dlg-1", caller: "coder", callee: "devops" } as any, "waiting", "waiting on the build", clock + HOUR)
    expect(store.get("req-t1")).toMatchObject({ state: "waiting_other", dueAt: clock + HOUR })
    const told: string[] = []
    const sweep = () => runRequestsSweep({ store, settings, now: clock, log: () => {}, notify: async (title) => { told.push(title) } })
    clock += 30 * MIN
    await sweep()
    expect(told).toEqual([])
    clock += 31 * MIN
    await sweep()
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: expect.stringMatching(/Past its due time/) })
    expect(told).toHaveLength(1)
  })

  it("a decision card raised outside a request's turn is a promise owed by the owner, when promises.cards is on", () => {
    tracker.cardRaised({ id: "card-1", raised_by: "coder", ask: "Ship to production?", title: "Production deploy" }, null)
    expect(store.byLink("card", "card-1")).toBeNull()
    promises.cards = true
    tracker.cardRaised({ id: "card-1", raised_by: "coder", ask: "Ship to production?", title: "Production deploy" }, null)
    const p = store.byLink("card", "card-1")!
    expect(p).toMatchObject({ promise: true, owedBy: "owner", state: "waiting_owner", headline: "Production deploy" })
    tracker.cardResolved({ id: "card-1", status: "decided", ask: "Ship to production?", verdict: "yes", decided_at: new Date(clock).toISOString() })
    expect(store.get(p.id)).toMatchObject({ state: "done", proof: { kind: "output", value: "yes" } })
    expect(facts()[0]).toMatchObject({ subject: "Production deploy", attribute: "owner's answer", value: "yes", verifiedBy: "owner" })
    // Expired unanswered: dropped, no fact.
    tracker.cardRaised({ id: "card-2", raised_by: "coder", ask: "Rotate keys?" }, null)
    tracker.cardResolved({ id: "card-2", status: "expired", ask: "Rotate keys?", if_silent: "discard" })
    expect(store.byLink("card", "card-2")).toMatchObject({ state: "dropped" })
    expect(facts()).toHaveLength(1)
  })
})

describe("settings", () => {
  it("requests.promises defaults: proof required, facts on for 7 days, watchers on the loop, cards off", () => {
    expect(requestsConfigSchema.parse(undefined).promises).toEqual({ requireProof: true, facts: true, factTtlDays: 7, watchers: true, cards: false })
    expect(requestsConfigSchema.safeParse({ promises: { factTtlDays: 0 } }).success).toBe(false)
  })
})
