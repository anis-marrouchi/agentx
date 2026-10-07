import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore, ensureRequestTables } from "../src/requests/store"
import { RequestTracker, PICKUP_CHANNEL, isPickup, pickupContext, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep, pickupText, pickupEnded } from "../src/requests/sweep"
import { writeFileSync, readFileSync } from "fs"
import { decide, listInbox } from "../src/approvals/inbox"
import { digestText } from "../src/approvals/sweep"

// Requests that need attention sit in the Approvals inbox: yes hands the
// request back to its agent, no drops it, later puts it off.

const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let clock: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-inbox-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  clock = Date.parse("2026-10-01T10:00:00Z")
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Requests on, unless a test turns them off. */
let on = true
const ctx = () => {
  const configPath = path.join(tmp, "inbox-agentx.json")
  writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: {}, requests: { enabled: on } }))
  return { root: tmp, requests: store, now: clock, configPath }
}

/** A voice request whose run timed out. */
function failed(taskId: string) {
  tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, messagePreview: "", fullMessage: "build the report and deploy it", at: "", humanRoot: true, operator: true } as any)
  tracker.taskCompleted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, durationMs: 1, error: "Task timed out after 60 minutes", at: "" } as any)
}

const sweep = (over: Record<string, unknown> = {}) => {
  const turns: Array<{ agentId: string; text: string }> = []
  return runRequestsSweep({
    store, settings, log: () => {}, now: clock, hasAgent: (id) => id === "coder",
    tellAgent: async (agentId, text) => { turns.push({ agentId, text }) },
    ...over,
  }).then((result) => ({ result, turns }))
}

describe("requests in the Approvals inbox", () => {
  it("lists only requests that need attention, with what happened", () => {
    failed("t1")
    tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId: "t2", messagePreview: "", fullMessage: "still running", at: "", humanRoot: true, operator: true } as any)
    const { items, errors } = listInbox(ctx(), { kinds: ["request"] })
    expect(errors).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: "request:req-t1", kind: "request", raised_by: "coder",
      title: "Request not finished: build the report and deploy it",
      ask: "Ask coder to pick it up again?",
      more: "agentx requests show req-t1",
    })
    expect(items[0].detail).toContain("coder timed out")
    expect(digestText(items)).toContain("1 decision waiting for you.")
  })

  it("reads no database for a folder this process does not run from", () => {
    expect(listInbox({ root: tmp }, { kinds: ["request"] })).toEqual({ items: [], snoozed: 0, errors: [] })
  })

  it("no drops the request, with the note as the reason", async () => {
    failed("t1")
    expect(await decide(ctx(), "request:req-t1", "no", { note: "not needed any more" })).toEqual({ ok: true, message: "request:req-t1: dropped" })
    expect(store.get("req-t1")).toMatchObject({ state: "dropped", closeReason: "not needed any more" })
    expect(listInbox(ctx(), { kinds: ["request"] }).items).toEqual([])
    expect((await decide(ctx(), "request:req-t1", "no")).ok).toBe(false)
  })

  it("later hides it without changing the request", async () => {
    failed("t1")
    expect((await decide(ctx(), "request:req-t1", "later", { laterHours: 2 })).ok).toBe(true)
    expect(listInbox(ctx(), { kinds: ["request"] })).toMatchObject({ items: [], snoozed: 1 })
    expect(store.get("req-t1")?.state).toBe("needs_attention")
  })

  it("yes hands it back to the agent once, as a turn linked to the request", async () => {
    failed("t1")
    await sweep()
    expect((await decide(ctx(), "request:req-t1", "yes")).ok).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", attentionReason: null })

    const first = await sweep()
    expect(first.result.pickedUp).toBe(1)
    expect(first.turns).toEqual([{ agentId: "coder", text: pickupText(store.get("req-t1")!) }])
    expect(first.turns[0].text).toContain("build the report and deploy it")
    expect(first.turns[0].text).toContain('id:"req-t1"')
    expect((await sweep()).turns).toEqual([])

    // The turn the daemon starts is followed like any other run of the request.
    tracker.taskStarted({ agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false, pickup: true } as any)
    expect(store.byLink("run", "t9")?.id).toBe("req-t1")
    tracker.taskCompleted({ agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", durationMs: 1, error: "model overloaded", at: "" } as any)
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "coder failed: model overloaded", notifiedAt: null })
  })

  it("refuses yes while requests are off, because nothing would hand it back", async () => {
    failed("t1")
    on = false
    const r = await decide(ctx(), "request:req-t1", "yes")
    on = true
    expect(r.ok).toBe(false)
    expect((r as any).error).toContain("Requests are off")
    expect(store.get("req-t1")?.state).toBe("needs_attention")
    expect(store.takePickups()).toEqual([])
    // No still works: dropping needs no daemon.
    on = false
    expect((await decide(ctx(), "request:req-t1", "no")).ok).toBe(true)
    on = true
  })

  it("comes back when the pick-up turn never starts (agent busy, message dropped)", async () => {
    failed("t1")
    await decide(ctx(), "request:req-t1", "yes")
    await sweep()
    const r = store.get("req-t1")!
    expect(pickupEnded(store, r, { error: 'Agent "coder" is busy — message dropped' }, clock)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: 'Could not hand it back to coder: Agent "coder" is busy — message dropped', notifiedAt: null })
    // A turn that ran and answered changes nothing here.
    store.progress("req-t1", clock)
    expect(pickupEnded(store, r, { }, clock)).toBe(false)
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("stays in progress when the hand-back was queued behind the agent's current turn (#392)", async () => {
    failed("t1")
    await decide(ctx(), "request:req-t1", "yes")
    await sweep()
    const r = store.get("req-t1")!
    store.progress("req-t1", clock)
    // What registry.execute answers for a busy chat: accepted, runs later.
    expect(pickupEnded(store, r, { error: "__queued__:collect:1" }, clock)).toBe(false)
    expect(store.get("req-t1")).toMatchObject({ state: "in_progress", attentionReason: null })
    expect(pickupEnded(store, r, { error: 'Peer "p" /task error: 500: __queued__:followup:2' }, clock)).toBe(false)
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("comes back when the agent is gone or the turn cannot start", async () => {
    failed("t1")
    await decide(ctx(), "request:req-t1", "yes")
    await sweep({ hasAgent: () => false })
    expect(store.get("req-t1")?.attentionReason).toBe('Could not hand it back: agent "coder" is not on this node')

    await decide(ctx(), "request:req-t1", "yes")
    await sweep({ tellAgent: async () => { throw new Error("no free slot") } })
    expect(store.get("req-t1")?.attentionReason).toBe("Could not hand it back to coder: no free slot")
  })

  it("does not let another agent's pick-up turn attach to the request", () => {
    failed("t1")
    tracker.taskStarted({ agentId: "devops", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false, pickup: true } as any)
    expect(store.byLink("run", "t9")).toBeNull()
  })

  it("links work a pick-up turn hands to another agent, while that turn runs", () => {
    failed("t1")
    store.requestPickup("req-t1", clock)
    const turn = { agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false, pickup: true }
    const handOn = (id: string) => tracker.delegationStarted({ id, caller: "coder", callee: "devops", origin: { channel: PICKUP_CHANNEL, chatId: "req-t1" } })

    tracker.taskStarted(turn as any)
    handOn("d1")
    expect(store.byLink("delegation", "d1")?.id).toBe("req-t1")
    expect(store.get("req-t1")?.state).toBe("waiting_other")

    tracker.taskCompleted({ ...turn, durationMs: 1 } as any)
    handOn("d2")
    expect(store.byLink("delegation", "d2")).toBeNull()
  })

  it("keeps a yes written while the pick-ups are being read for the next read", () => {
    failed("t1"); failed("t2")
    store.requestPickup("req-t1", clock)
    // The dashboard is another process: its yes lands right after the read's first statement.
    const other = new Database(path.join(tmp, "db.sqlite"))
    const dashboard = new RequestStore(other)
    let landed = false
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = (target as any)[prop]
          return typeof v === "function" ? v.bind(target) : v
        }
        return (sql: string) => {
          const st = target.prepare(sql)
          if (landed || !sql.includes("pickup_at")) return st
          const all = st.all.bind(st)
          st.all = ((...args: unknown[]) => {
            const rows = all(...args)
            landed = true
            dashboard.requestPickup("req-t2", clock)
            return rows
          }) as typeof st.all
          return st
        }
      },
    })
    const daemon = new RequestStore(racing)

    expect(daemon.takePickups().map((r) => r.id)).toEqual(["req-t1"])
    expect(landed).toBe(true)
    expect(daemon.takePickups().map((r) => r.id)).toEqual(["req-t2"])
    expect(daemon.takePickups()).toEqual([])
    other.close()
  })

  it("does not fail when another process added the pick-up column first", () => {
    // What the slower of two starting processes sees: no column yet, then the ALTER finds it.
    const stale = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (sql.startsWith("PRAGMA table_info") ? { all: () => [] } : target.prepare(sql))
        const v = (target as any)[prop]
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    expect(() => ensureRequestTables(stale)).not.toThrow()
    failed("t1")
    expect(store.requestPickup("req-t1", clock)).toBe(true)
  })

  it("links only the pick-up turn the daemon started, not one a caller names (#393)", () => {
    failed("t1")
    const before = store.get("req-t1")
    clock += 5000
    // POST /task with channel "requests" and the request id as the chat.
    tracker.taskStarted({ agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false } as any)
    expect(store.byLink("run", "t9")).toBeNull()
    // Its quiet clock is not reset either.
    expect(store.get("req-t1")).toEqual(before)
  })

  it("marks the pick-up context in a way a request body cannot", () => {
    const ctx = pickupContext("req-t1")
    expect(ctx).toMatchObject({ channel: PICKUP_CHANNEL, chatId: "req-t1", sender: "operator" })
    expect(isPickup(ctx)).toBe(true)
    // The registry copies a context; the mark goes with it.
    expect(isPickup({ ...ctx, initiator: {} })).toBe(true)
    // Through JSON, as any HTTP caller's context arrives, it is gone.
    expect(isPickup(JSON.parse(JSON.stringify(ctx)))).toBe(false)
    expect(isPickup({ channel: PICKUP_CHANNEL, chatId: "req-t1", pickup: true, "Symbol(requests.pickup)": true })).toBe(false)
    expect(isPickup(undefined)).toBe(false)
  })

  it("adds the pick-up column to a database created by the first version", () => {
    const old = new Database(path.join(tmp, "old.sqlite"))
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT,
      agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attention_reason TEXT,
      notified_at INTEGER, question TEXT, closed_at INTEGER, evidence TEXT, close_reason TEXT)`)
    old.prepare("INSERT INTO requests (id,state,channel,chat_id,agent_id,text,created_at,updated_at) VALUES ('req-old','needs_attention','voice','mac','coder','x',1,1)").run()
    const s = new RequestStore(old)
    expect(s.requestPickup("req-old", 5)).toBe(true)
    expect(s.takePickups().map((r) => r.id)).toEqual(["req-old"])
    // And the agent it was asked of, kept at a hand-off (#481).
    expect(s.get("req-old")?.askedAgent).toBeNull()
    expect(s.handOff("req-old", "writer", "", 6)).toBe(true)
    expect(s.get("req-old")).toMatchObject({ agentId: "writer", askedAgent: "coder" })
    old.close()
  })
})

import { handleRequestsPanel } from "../src/daemon/requests-panel"
import { renderApprovalsPage } from "../src/daemon/ui/pages/approvals"
import { REQUESTS_SCRIPT } from "../src/daemon/ui/pages/approvals-requests"

describe("the dashboard's open requests", () => {
  const panelCtx = () => {
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: {} }))
    return { root: tmp, requests: store, now: clock, configPath, reload: false }
  }
  const P = "/api/admin/approvals/requests"

  it("lists open requests oldest first with the settings", async () => {
    failed("t1")
    clock += 1000
    failed("t2")
    const r = await handleRequestsPanel("GET", P, {}, panelCtx())
    expect(r.status).toBe(200)
    expect((r.body as any).items.map((i: any) => i.id)).toEqual(["req-t1", "req-t2"])
    expect((r.body as any).settings).toEqual({ enabled: false, channels: [], from: [], staleAfterHours: 24, retentionDays: 90, plans: { enabled: true, stallMinutes: 30, maxNudges: 3, approveKinds: ["message"], disabledAgents: [] } })
  })

  it("closes as done with evidence, and drops with a default reason", async () => {
    failed("t1"); failed("t2")
    const c = panelCtx()
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t1", action: "done", evidence: "https://example.test/pr/4" }, c)).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.test/pr/4" })
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t1", action: "drop" }, c)).status).toBe(409)
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t2", action: "drop" }, c)).status).toBe(200)
    expect(store.get("req-t2")).toMatchObject({ state: "dropped", closeReason: "dropped by the owner (dashboard)" })
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "nope", action: "drop" }, c)).status).toBe(404)
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t2", action: "delete" }, c)).status).toBe(400)
  })

  it("saves every setting from the form and rejects a bad one", async () => {
    const c = panelCtx()
    const ok = await handleRequestsPanel("POST", `${P}/settings`, {
      enabled: true, from: "telegram:42, github:me", channels: "", staleAfterHours: 48, retentionDays: 30,
      plansEnabled: false, stallMinutes: 20, maxNudges: 2, approveKinds: "message, deploy", plansOffFor: "helper",
    }, c)
    expect(ok.status).toBe(200)
    expect((ok.body as any).settings).toEqual({
      enabled: true, channels: [], from: ["telegram:42", "github:me"], staleAfterHours: 48, retentionDays: 30,
      plans: { enabled: false, stallMinutes: 20, maxNudges: 2, approveKinds: ["message", "deploy"], disabledAgents: ["helper"] },
    })
    expect((await handleRequestsPanel("POST", `${P}/settings`, { maxNudges: 1.5 }, c)).status).toBe(400)
    expect(JSON.parse(readFileSync(c.configPath, "utf-8")).requests.enabled).toBe(true)
    expect((await handleRequestsPanel("POST", `${P}/settings`, { from: "no-channel" }, c)).status).toBe(400)
    expect(await handleRequestsPanel("POST", `${P}/settings`, { staleAfterHours: 0 }, c)).toEqual({ status: 400, body: { error: "staleAfterHours must be a positive number" } })
  })

  it("ships a page whose script parses and whose section is on the Approvals page", () => {
    expect(() => new Function(REQUESTS_SCRIPT)).not.toThrow()
    const html = renderApprovalsPage()
    expect(html).toContain('id="req-section"')
    expect(html).toContain('data-kind="request"')
    expect(html).toContain("/api/admin/approvals/requests/'")
  })
})
