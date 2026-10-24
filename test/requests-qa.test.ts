import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { describeOpen, runRequestTool } from "../src/requests/tool"
import { requestCard } from "../src/requests/card-view"
import { awaitingQa, parseVerdict, QA_VERDICTS } from "../src/requests/qa"

// QA verdict per request, and the awaiting-QA filter (#1188).

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let now: number
let running: Map<string, { agentId: string; channel: string; chatId: string }>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-qa-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  now = 6_000
  running = new Map([
    ["run-coder", { agentId: "coder", channel: "telegram", chatId: "chat-1" }],
    ["run-qa", { agentId: "qa", channel: "a2a", chatId: "qa-chat" }],
  ])
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const api = (method: string, p: string, body?: Record<string, unknown>, taskId = "run-coder", query?: Record<string, string>) =>
  handleRequestsApi(method, p, body, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder" || id === "qa", now,
    query: query ? new URLSearchParams(query) : undefined,
    runningTurn: (agentId, pr) => {
      const hit = pr.taskId ? running.get(pr.taskId) : undefined
      return hit && hit.agentId === agentId ? { channel: hit.channel, chatId: hit.chatId } : null
    },
  }, { taskId })

function turn(taskId: string, chatId = "chat-1") {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId, taskId, messagePreview: "ship the fix", fullMessage: "ship the fix",
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
}

const coder = (action: string, extra: Record<string, unknown> = {}) => api("POST", "/requests", { action, agentId: "coder", ...extra })
const qa = (extra: Record<string, unknown>) => api("POST", "/requests", { action: "qa", agentId: "qa", ...extra }, "run-qa")
const awaitingIds = () => ((api("GET", "/requests", undefined, "run-coder", { qa: "awaiting" }).body as any).items as any[]).map((r) => r.id)

describe("recording a QA verdict", () => {
  it.each(QA_VERDICTS)("records %s with who gave it and when", (verdict) => {
    turn("t1")
    coder("accept", { work: "code", needsQa: true })
    now = 7_000
    const res = qa({ id: "req-t1", verdict, note: verdict === "pass" ? undefined : "login fails on a phone" })
    expect(res.status).toBe(200)
    const r = store.get("req-t1")!
    expect(r.qa).toEqual({ verdict, by: "qa", at: 7_000, note: verdict === "pass" ? null : "login fails on a phone" })
    expect(awaitingQa(r)).toBe(false)
    // Not a touch: the quiet timer of the work stays where it was.
    expect(r.updatedAt).toBe(6_000)
  })

  it("block and risk need a note; an unknown verdict is refused", () => {
    turn("t1")
    coder("accept", { work: "code" })
    expect(qa({ id: "req-t1", verdict: "block" }).status).toBe(400)
    expect(qa({ id: "req-t1", verdict: "risk", note: "  " }).status).toBe(400)
    expect(qa({ id: "req-t1", verdict: "maybe" }).status).toBe(400)
    expect(qa({ id: "req-t1" }).status).toBe(400)
    expect(store.get("req-t1")!.qa).toBeNull()
    expect(parseVerdict("PASS", undefined)).toEqual({ verdict: "pass", note: null })
  })

  it("needs the id, a real request, and a running turn of the agent that gives it", () => {
    turn("t1")
    coder("accept", { work: "code" })
    expect(qa({ verdict: "pass" }).status).toBe(400)
    expect(qa({ id: "req-nope", verdict: "pass" }).status).toBe(404)
    // qa claiming the verdict from coder's run.
    expect(api("POST", "/requests", { action: "qa", agentId: "qa", id: "req-t1", verdict: "pass" }, "run-coder").status).toBe(403)
    expect(store.get("req-t1")!.qa).toBeNull()
  })

  it("works on a closed request, and keeps every verdict in its history", () => {
    turn("t1")
    coder("accept", { work: "code", needsQa: true })
    coder("done", { id: "req-t1", evidence: "https://example.test/pull/9" })
    now = 7_000
    expect(qa({ id: "req-t1", verdict: "block", note: "breaks the import" }).status).toBe(200)
    now = 8_000
    expect(qa({ id: "req-t1", verdict: "pass" }).status).toBe(200)
    const one = api("GET", "/requests/req-t1").body as any
    expect(one.request.qa).toMatchObject({ verdict: "pass", by: "qa", at: 8_000 })
    expect(one.verdicts.map((v: any) => v.verdict)).toEqual(["block", "pass"])
    expect(one.request.state).toBe("done")
  })

  it("a candidate takes no verdict", () => {
    turn("t1")
    expect(qa({ id: "req-t1", verdict: "pass" }).status).toBe(404)
  })
})

describe("the awaiting-QA filter", () => {
  it("lists requests marked as needing QA with no verdict yet, open or closed", () => {
    for (const n of [1, 2, 3, 4]) turn(`t${n}`, `chat-${n}`)
    coder("accept", { id: "req-t1", work: "code", needsQa: true })
    coder("accept", { id: "req-t2", work: "code" })
    coder("accept", { id: "req-t3", work: "code", needsQa: true })
    coder("done", { id: "req-t3", evidence: "https://example.test/pull/3" })
    coder("accept", { id: "req-t4", work: "code", needsQa: true })
    expect(store.get("req-t3")!.state).toBe("done")
    now = 7_000
    qa({ id: "req-t4", verdict: "pass" })
    // A verdict on a request nobody marked: it has one, it is not awaited.
    qa({ id: "req-t2", verdict: "risk", note: "no tests" })
    expect(awaitingIds()).toEqual(["req-t1", "req-t3"])
    expect(((api("GET", "/requests", undefined, "run-coder", { qa: "risk" }).body as any).items as any[]).map((r) => r.id)).toEqual(["req-t2"])
    expect(((api("GET", "/requests", undefined, "run-coder", { qa: "pass", state: "open" }).body as any).items as any[]).map((r) => r.id)).toEqual(["req-t4"])
    expect(api("GET", "/requests", undefined, "run-coder", { qa: "soon" }).status).toBe(400)
  })

  it("asking again after a block awaits a new verdict; needsQa false clears the mark", () => {
    turn("t1")
    coder("accept", { work: "code", needsQa: true })
    now = 7_000
    qa({ id: "req-t1", verdict: "block", note: "breaks the import" })
    expect(awaitingIds()).toEqual([])
    now = 8_000
    expect(coder("describe", { id: "req-t1", needsQa: true }).status).toBe(200)
    expect(awaitingIds()).toEqual(["req-t1"])
    // The block stays readable while the new verdict is awaited.
    expect(store.get("req-t1")!.qa?.verdict).toBe("block")
    coder("describe", { id: "req-t1", needsQa: false })
    expect(awaitingIds()).toEqual([])
    expect(coder("describe", { id: "req-t1", needsQa: "yes" }).status).toBe(400)
  })

  it("a promise can ask for QA too", () => {
    turn("t1")
    const res = coder("promise", { owedTo: "owner", text: "Ship the export", needsQa: true })
    expect(res.status).toBe(200)
    expect(awaitingIds()).toEqual([(res.body as any).request.id])
  })
})

describe("where the verdict shows", () => {
  it("the request's card and the tool's list carry the verdict, who and when", () => {
    turn("t1")
    coder("accept", { work: "code", needsQa: true })
    let card = requestCard(store.get("req-t1")!, store)
    expect(card.awaitingQa).toBe(true)
    expect(describeOpen([store.get("req-t1")])).toContain("Awaiting QA.")
    now = Date.UTC(2030, 0, 1, 10, 0)
    qa({ id: "req-t1", verdict: "risk", note: "slow on large files" })
    card = requestCard(store.get("req-t1")!, store)
    expect(card.awaitingQa).toBe(false)
    expect(card.qa).toMatchObject({ verdict: "risk", by: "qa" })
    expect(describeOpen([store.get("req-t1")])).toContain("QA: RISK by qa, 2030-01-01 10:00 UTC: slow on large files.")
  })

  it("the tool sends verdict and note, and says what was recorded", async () => {
    let sent: any
    const fake = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({ request: { id: "req-1", qa: { verdict: "pass", by: "qa", at: Date.UTC(2030, 0, 1), note: null } } }), { status: 200 })
    }) as any
    const text = await runRequestTool({ action: "qa", id: "req-1", verdict: "pass", callerAgentId: "qa" }, { daemonUrl: "http://d", fetch: fake, env: {} })
    expect(sent).toMatchObject({ action: "qa", agentId: "qa", id: "req-1", verdict: "pass" })
    expect(text).toContain("Verdict recorded on req-1: PASS by qa, 2030-01-01 00:00 UTC")
  })
})
