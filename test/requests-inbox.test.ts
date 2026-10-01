import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, PICKUP_CHANNEL, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep, pickupText } from "../src/requests/sweep"
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

const ctx = () => ({ root: tmp, requests: store, now: clock })

/** A voice request whose run timed out. */
function failed(taskId: string) {
  tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, messagePreview: "", fullMessage: "build the report and deploy it", at: "", humanRoot: true } as any)
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
    tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId: "t2", messagePreview: "", fullMessage: "still running", at: "", humanRoot: true } as any)
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
    tracker.taskStarted({ agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false } as any)
    expect(store.byLink("run", "t9")?.id).toBe("req-t1")
    tracker.taskCompleted({ agentId: "coder", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", durationMs: 1, error: "model overloaded", at: "" } as any)
    expect(store.get("req-t1")).toMatchObject({ state: "needs_attention", attentionReason: "coder failed: model overloaded", notifiedAt: null })
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
    tracker.taskStarted({ agentId: "devops", channel: PICKUP_CHANNEL, chatId: "req-t1", taskId: "t9", messagePreview: "", at: "", humanRoot: false } as any)
    expect(store.byLink("run", "t9")).toBeNull()
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
    old.close()
  })
})

import { writeFileSync, readFileSync } from "fs"
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
    expect((r.body as any).settings).toEqual({ enabled: false, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 })
  })

  it("closes as done only with evidence, and drops with a default reason", async () => {
    failed("t1"); failed("t2")
    const c = panelCtx()
    expect((await handleRequestsPanel("POST", `${P}/close`, { id: "req-t1", action: "done" }, c)).status).toBe(400)
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
    const ok = await handleRequestsPanel("POST", `${P}/settings`, { enabled: true, from: "telegram:42, github:me", channels: "", staleAfterHours: 48, retentionDays: 30 }, c)
    expect(ok.status).toBe(200)
    expect((ok.body as any).settings).toEqual({ enabled: true, channels: [], from: ["telegram:42", "github:me"], staleAfterHours: 48, retentionDays: 30 })
    expect(JSON.parse(readFileSync(c.configPath, "utf-8")).requests.enabled).toBe(true)
    expect((await handleRequestsPanel("POST", `${P}/settings`, { from: "no-channel" }, c)).status).toBe(400)
    expect(await handleRequestsPanel("POST", `${P}/settings`, { staleAfterHours: 0 }, c)).toEqual({ status: 400, body: { error: "staleAfterHours must be a positive number" } })
  })

  it("ships a page whose script parses and whose section is on the Approvals page", () => {
    expect(() => new Function(REQUESTS_SCRIPT)).not.toThrow()
    const html = renderApprovalsPage()
    expect(html).toContain('id="req-section"')
    expect(html).toContain('data-kind="request"')
    expect(html).toContain("/api/admin/approvals/requests/close")
  })
})
