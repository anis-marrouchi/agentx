import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { DEFAULT_WAKE_SETTINGS, JobWake } from "../src/jobs/wake"
import { armPromiseWake, DEFAULT_PROMISE_SETTINGS, openPromise, raiseLoop } from "../src/requests/promise"
import { runRequestsSweep } from "../src/requests/sweep"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"

// A promise's due time wakes the agent that owes it (noqta#858): before,
// the due time only told the owner the promise was late.

const MIN = 60_000
const HOUR = 60 * MIN

let tmp: string
let db: Database.Database
let store: RequestStore
let jobs: JobStore
let wake: JobWake
let clock: number
let started: Array<{ id: string; assignee: string; text: string }>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-promise-wake-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, status TEXT, started_at INTEGER, finished_at INTEGER, cost_usd REAL, error TEXT)")
  store = new RequestStore(db)
  jobs = new JobStore(db)
  clock = Date.UTC(2026, 10, 18, 8, 0, 0)
  started = []
  wake = new JobWake({
    jobs, settings: () => ({ ...DEFAULT_WAKE_SETTINGS }), log: () => {}, now: () => clock,
    facts: () => ({ lastRunEndedAt: clock - HOUR }),
    start: async (job, text) => { started.push({ id: job.id, assignee: job.assignee, text }); return {} },
    hasAgent: () => true,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const flush = () => new Promise((r) => setTimeout(r, 0))

const promise = (over: Partial<Parameters<typeof openPromise>[1]> = {}) => openPromise(store, {
  agentId: "sales", owedTo: "owner", text: "Send the second follow-up email at 10:00Z", channel: "telegram", chatId: "chat-1",
  dueAt: clock + 2 * HOUR, now: clock, ...over,
})

describe("a promise with a due time", () => {
  it("wakes the agent that owes it when it falls due, once, with what it promised", async () => {
    const p = promise()
    expect(wake.tick().woken).toBe(0)
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
    clock += HOUR
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ id: p.id, assignee: "sales" })
    expect(started[0].text).toContain("Send the second follow-up email at 10:00Z")
    expect(started[0].text).toContain("owed to owner")
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("stays an open promise: armed, still in progress, its due time kept", () => {
    const p = promise()
    expect(store.get(p.id)).toMatchObject({ state: "in_progress", promise: true, dueAt: clock + 2 * HOUR })
    expect(jobs.get(p.id)).toMatchObject({ wakeAt: clock + 2 * HOUR, state: "continue" })
  })

  it("does not wake once it is kept", () => {
    const p = promise()
    store.close(p.id, "done", "https://example.com/sent", clock)
    clock += 2 * HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("arms nothing without a due time, or with one already past", () => {
    const a = promise({ dueAt: null })
    const b = promise({ dueAt: clock - MIN })
    expect(jobs.get(a.id)?.wakeAt).toBeNull()
    expect(jobs.get(b.id)?.wakeAt).toBeNull()
    clock += HOUR
    expect(wake.tick().woken).toBe(0)
  })

  it("does not wake for a promise the owner owes: the owner is not an agent to wake", () => {
    const p = promise({ owedTo: "sales", owedBy: "owner", channel: "approvals", chatId: "card-1" })
    expect(store.get(p.id)?.state).toBe("waiting_owner")
    expect(jobs.get(p.id)?.wakeAt).toBeNull()
  })

  it("an escalation stays needing attention, not hidden behind a wake", () => {
    const { requestId } = raiseLoop(store, {
      links: [], reason: "the follow-up ran out",
      open: { agentId: "sales", owedTo: "owner", text: "Chase the lead", channel: "telegram", chatId: "chat-1", dueAt: clock + HOUR, link: { kind: "card", ref: "c-1" } },
      now: clock,
    })
    expect(store.get(requestId)?.state).toBe("needs_attention")
    expect(jobs.get(requestId)?.wakeAt).toBeNull()
  })
})

describe("a due time added to an open request", () => {
  it("arms the wake once, and never over a state a run declared or a wake already set", () => {
    const p = promise({ dueAt: null })
    expect(armPromiseWake(store, p.id, clock + HOUR, clock)).toBe(true)
    expect(armPromiseWake(store, p.id, clock + 3 * HOUR, clock)).toBe(false)
    expect(jobs.get(p.id)?.wakeAt).toBe(clock + HOUR)

    const q = promise({ dueAt: null })
    jobs.declare(q.id, { state: "waiting", on: "pm", until: clock + 5 * HOUR }, { now: clock })
    expect(armPromiseWake(store, q.id, clock + HOUR, clock)).toBe(false)
    expect(jobs.get(q.id)?.state).toBe("waiting")
  })
})

// The same hour it falls due (#1908): the agent is woken and whoever waits
// on it is told by the requests check, not after the quiet time.
describe("a promise past its due time", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  let told: Array<{ to: string; text: string }>
  let notices: string[]

  const check = (over: Partial<RequestSettings> = {}) => runRequestsSweep({
    store, settings: { ...settings, ...over }, log: () => {}, now: clock,
    hasAgent: (id) => ["sales", "pm"].includes(id),
    wakeJob: (id, note) => wake.wakeFor(id, note),
    tellRequester: (to, text) => { told.push({ to, text }); return true },
    notify: async (title) => { notices.push(title) },
  })

  beforeEach(() => {
    told = []
    notices = []
  })

  it("wakes its agent at the due time and tells the owner in the same check", async () => {
    const p = promise()
    clock += HOUR
    expect((await check()).duePushed).toBe(0)
    expect(wake.tick().woken).toBe(0)
    clock += HOUR + MIN
    const result = await check()
    expect(result.duePushed).toBe(1)
    expect(result.notified).toBe(1)
    expect(notices[0]).toContain("Promise not kept")
    expect(store.get(p.id)).toMatchObject({ state: "needs_attention" })
    expect(store.get(p.id)!.attentionReason).toContain("Past its due time")
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started.map((s) => s.id)).toEqual([p.id])
    // Once: the next checks neither wake nor tell again.
    clock += MIN
    expect((await check()).duePushed).toBe(0)
    expect(wake.tick().woken).toBe(0)
    expect(notices).toHaveLength(1)
  })

  it("wakes the agent even when the promise had no wake armed", async () => {
    const p = promise({ wake: false })
    expect(jobs.get(p.id)?.wakeAt).toBeNull()
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started[0]).toMatchObject({ id: p.id, assignee: "sales" })
    expect(started[0].text).toContain("fell due")
  })

  it("tells the agent that waits on it, as a notice", async () => {
    const p = promise({ owedTo: "pm" })
    clock += 2 * HOUR + MIN
    await check()
    expect(told).toHaveLength(1)
    expect(told[0].to).toBe("pm")
    expect(told[0].text).toContain(p.id)
    expect(told[0].text).toContain("sales promised you this")
  })

  // Handed on and back done (#1912 item 2): a promise is never settled by
  // the hand-back path (that path reads non-promises only), so it is pushed
  // like any other due promise, once, and is not read again by the next check.
  it("pushes a promise whose handed work came back, once, and leaves it out of the next check", async () => {
    const p = promise()
    store.link(p.id, "delegation", "dlg-1", clock, "pm")
    store.endLink("delegation", "dlg-1", "done", "https://example.com/pr/1", clock + HOUR)
    expect(store.cameBack(p.id)).toBe(false)
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(store.get(p.id)).toMatchObject({ state: "needs_attention", promise: true })
    clock += MIN
    expect(store.duePromises(clock).map((r) => r.id)).not.toContain(p.id)
    expect((await check()).duePushed).toBe(0)
    expect(store.get(p.id)?.state).toBe("needs_attention")
  })

  // A host rolled back to code from before the push (#1912): that code
  // sets a due time without clearing `due_pushed_at`.
  const oldSetDue = (id: string, dueAt: number) =>
    db.prepare("UPDATE requests SET due_at = ?, state = 'in_progress', attention_reason = NULL, updated_at = ? WHERE id = ?").run(dueAt, clock, id)

  it("pushes a new due time that older code wrote with the pushed mark left set, once", async () => {
    const p = promise()
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    oldSetDue(p.id, clock + HOUR)
    expect((db.prepare("SELECT due_pushed_at FROM requests WHERE id = ?").get(p.id) as any).due_pushed_at).not.toBeNull()
    expect((await check()).duePushed).toBe(0)
    clock += HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(store.get(p.id)!.attentionReason).toContain("Past its due time")
    clock += MIN
    expect((await check()).duePushed).toBe(0)
    expect(notices).toHaveLength(2)
  })

  it("pushes it too when the push itself was made before the mark held a due time", async () => {
    const p = promise()
    clock += 2 * HOUR + MIN
    // Pushed by 0.229.0: only `due_pushed_at` is written.
    db.prepare("UPDATE requests SET due_pushed_at = ?, due_pushed_for = NULL WHERE id = ?").run(clock, p.id)
    const other = promise({ chatId: "chat-2" })
    db.prepare("UPDATE requests SET due_pushed_at = ?, due_pushed_for = NULL WHERE id = ?").run(clock, other.id)
    oldSetDue(p.id, clock + HOUR)
    // The upgrade: the store opens the database again.
    store = new RequestStore(db)
    clock += HOUR + MIN
    // The new due time is pushed; the one already pushed is not pushed again.
    expect(store.duePromises(clock).map((r) => r.id)).toEqual([p.id])
    expect((await check()).duePushed).toBe(1)
    expect((await check()).duePushed).toBe(0)
  })

  // The switch (#1912): `promises.duePush`.
  it("with the push off, neither wakes the agent nor tells the waiter nor marks it pushed", async () => {
    const p = promise({ owedTo: "pm", wake: false })
    store.progress(p.id, clock + 2 * HOUR + 30_000)
    clock += 2 * HOUR + MIN
    const result = await check({ promises: { duePush: false } })
    expect(result.duePushed).toBe(0)
    expect(result.quiet).toBe(0)
    expect(told).toEqual([])
    expect(notices).toEqual([])
    expect(store.get(p.id)).toMatchObject({ state: "in_progress", attentionReason: null })
    expect(wake.tick().woken).toBe(0)
    expect((db.prepare("SELECT due_pushed_at FROM requests WHERE id = ?").get(p.id) as any).due_pushed_at).toBeNull()
    // Turned on again: pushed as on 0.229.0.
    const on = await check({ promises: { duePush: true } })
    expect(on.duePushed).toBe(1)
    expect(told.map((t) => t.to)).toEqual(["pm"])
    expect(store.get(p.id)).toMatchObject({ state: "needs_attention" })
    expect(wake.tick().woken).toBe(1)
  })

  it("leaves a kept promise, one not due yet, and one the owner owes", async () => {
    const kept = promise()
    store.close(kept.id, "done", "https://example.com/sent", clock)
    promise({ dueAt: clock + 5 * HOUR })
    promise({ owedTo: "sales", owedBy: "owner", channel: "approvals", chatId: "card-2" })
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(0)
    expect(told).toEqual([])
  })
})

describe("a due time an agent accepts on a request", () => {
  it("arms the wake, like a promise's", () => {
    const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
    const tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
    tracker.taskStarted({
      agentId: "sales", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "Send the offer", fullMessage: "Send the offer",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    const due = new Date(clock + 3 * HOUR).toISOString()
    const res = handleRequestsApi("POST", "/requests", { agentId: "sales", action: "accept", work: "ops", id: "req-t1", due }, {
      store, tracker, enabled: true, hasAgent: (id) => id === "sales", now: clock,
      runningTurn: (agentId) => (agentId === "sales" ? { channel: "telegram", chatId: "chat-1" } : null),
    }, { taskId: "t1" })
    expect(res.status).toBe(200)
    expect(jobs.get("req-t1")).toMatchObject({ wakeAt: clock + 3 * HOUR, state: "continue" })
  })

  // The switch (#1912): `promises.acceptWake`.
  it("with the switch off, stores the due time and arms no wake", () => {
    const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
    const tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
    tracker.taskStarted({
      agentId: "sales", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "Send the offer", fullMessage: "Send the offer",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    const due = new Date(clock + 3 * HOUR).toISOString()
    const res = handleRequestsApi("POST", "/requests", { agentId: "sales", action: "accept", work: "ops", id: "req-t1", due }, {
      store, tracker, enabled: true, hasAgent: (id) => id === "sales", now: clock,
      runningTurn: (agentId) => (agentId === "sales" ? { channel: "telegram", chatId: "chat-1" } : null),
      promiseSettings: { ...DEFAULT_PROMISE_SETTINGS, acceptWake: false },
    }, { taskId: "t1" })
    expect(res.status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ dueAt: clock + 3 * HOUR, state: "in_progress" })
    expect(jobs.get("req-t1")?.wakeAt ?? null).toBeNull()
  })
})

// A missed PR due time (#2279): a promise whose words name a PR, past due
// with no PR linked, wakes its agent at once with the issue, and the lead
// (pm-agent) 15 min later if there is still no PR. Each wake once.
describe("a promised PR past its due time", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  const ISSUE = "https://github.com/acme/app/issues/12"
  let turns: Array<{ to: string; text: string }>
  let notes: Array<{ id: string; note: string }>
  let jobTakes: boolean

  const check = (over: Partial<RequestSettings> = {}) => runRequestsSweep({
    store, settings: { ...settings, ...over }, log: () => {}, now: clock,
    hasAgent: (id) => ["coder", "pm-agent"].includes(id),
    wakeJob: (id, note) => {
      if (!jobTakes) return false
      notes.push({ id, note })
      return wake.wakeFor(id, note)
    },
    tellAgent: async (to, text) => { turns.push({ to, text }) },
    notify: async () => {},
  })

  const prPromise = (over: Partial<Parameters<typeof openPromise>[1]> = {}) => promise({
    agentId: "coder", owedTo: "owner", text: `Open the Draft PR for ${ISSUE} by 10:00Z`, ...over,
  })

  beforeEach(() => {
    turns = []
    notes = []
    jobTakes = true
  })

  it("wakes the agent at once with the issue, and the PM 15 min later, each once", async () => {
    const p = prPromise()
    clock += 2 * HOUR + MIN
    const first = await check()
    expect(first.duePushed).toBe(1)
    expect(first.prLeads).toBe(0)
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe(p.id)
    expect(notes[0].note).toContain("[agentx:pr-due")
    expect(notes[0].note).toContain(ISSUE)
    expect(notes[0].note).toContain("pm-agent is woken")
    expect(turns).toEqual([])
    expect(wake.tick().woken).toBe(1)
    await flush()
    expect(started.map((s) => s.assignee)).toEqual(["coder"])

    // Not before 15 min.
    clock += 10 * MIN
    expect((await check()).prLeads).toBe(0)
    expect(turns).toEqual([])

    clock += 5 * MIN
    expect((await check()).prLeads).toBe(1)
    expect(turns).toHaveLength(1)
    expect(turns[0].to).toBe("pm-agent")
    expect(turns[0].text).toContain("[agentx:pr-due-lead")
    expect(turns[0].text).toContain(ISSUE)
    expect(turns[0].text).toContain("coder")

    // Once: later checks wake nobody again.
    for (let i = 0; i < 3; i++) {
      clock += MIN
      const r = await check()
      expect(r.duePushed).toBe(0)
      expect(r.prLeads).toBe(0)
    }
    expect(turns).toHaveLength(1)
    expect(notes).toHaveLength(1)
  })

  it("wakes the agent by a turn of its own when its job's wake cannot take it", async () => {
    const p = prPromise()
    jobTakes = false
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(1)
    expect(turns).toHaveLength(1)
    expect(turns[0].to).toBe("coder")
    expect(turns[0].text).toContain(`[agentx:pr-due id=${p.id}]`)
    expect(turns[0].text).toContain(ISSUE)
    expect(store.get(p.id)!.attentionReason).toContain("woken")
  })

  it("wakes nobody about a PR when one is linked", async () => {
    prPromise({ chatId: "c-1", home: { kind: "issue", link: "https://github.com/acme/app/pull/40" } })
    prPromise({ chatId: "c-2", text: "Get https://gitlab.example.com/acme/app/-/merge_requests/7 (the PR) reviewed by 10:00Z" })
    const viaLink = prPromise({ chatId: "c-3" })
    store.link(viaLink.id, "issue", "https://github.com/acme/app/pull/41", clock)
    clock += 2 * HOUR + MIN
    expect((await check()).duePushed).toBe(3)
    for (const n of notes) expect(n.note).not.toContain("pr-due")
    clock += 16 * MIN
    expect((await check()).prLeads).toBe(0)
    expect(turns).toEqual([])
  })

  it("does not wake the PM when the PR came in the 15 min, or for a promise with no PR due", async () => {
    const kept = prPromise({ chatId: "c-1" })
    promise({ agentId: "coder", chatId: "c-2" })
    clock += 2 * HOUR + MIN
    await check()
    store.close(kept.id, "done", "https://github.com/acme/app/pull/42", clock + 5 * MIN)
    clock += 16 * MIN
    expect((await check()).prLeads).toBe(0)
    expect(turns).toEqual([])
  })

  it("wakes no lead with promises.prLead empty, nor when the lead owes the PR itself", async () => {
    prPromise({ chatId: "c-1" })
    clock += 2 * HOUR + MIN
    await check({ promises: { prLead: "" } })
    expect(notes[0].note).not.toContain("is woken")
    clock += 16 * MIN
    expect((await check({ promises: { prLead: "" } })).prLeads).toBe(0)

    prPromise({ agentId: "pm-agent", chatId: "c-2", dueAt: clock + 2 * HOUR })
    clock += 2 * HOUR + MIN
    await check()
    clock += 16 * MIN
    expect((await check()).prLeads).toBe(0)
    expect(turns).toEqual([])
  })
})

describe("missed PR words", () => {
  it("reads a PR due from the words, and a PR linked from any of its records", async () => {
    const { namesPrDue, issueOf } = await import("../src/requests/pr-due")
    expect(namesPrDue({ headline: null, text: "Draft PR for #2238 by 17:00Z" })).toBe(true)
    expect(namesPrDue({ headline: null, text: "open the merge request today" })).toBe(true)
    expect(namesPrDue({ headline: null, text: "send the pr-ready email" })).toBe(false)
    expect(namesPrDue({ headline: null, text: "Send the follow-up email" })).toBe(false)
    const p = promise({ text: "Draft PR", closeWhen: { kind: "issue", provider: "github", ref: "acme/app#12", notePattern: "x", after: clock } })
    expect(issueOf(p)).toBe("https://github.com/acme/app/issues/12")
  })
})
