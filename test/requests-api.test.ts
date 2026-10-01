import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi, OWNER_ONLY } from "../src/requests/daemon-api"
import { runRequestTool, describeOpen } from "../src/requests/tool"
import { readRequestSettings, updateRequestSettings } from "../src/requests/settings"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let enabled: boolean

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-api-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  enabled = true
  running = new Map([["run-coder", { agentId: "coder", channel: "telegram", chatId: "chat-1" }]])
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Runs in flight, as the registry would report them: task id → agent and chat. */
let running: Map<string, { agentId: string; channel: string; chatId: string }>

const api = (method: string, p: string, body?: Record<string, unknown>, proof: Record<string, string | undefined> = { taskId: "run-coder" }) =>
  handleRequestsApi(method, p, body, {
    store, tracker, enabled, hasAgent: (id) => id === "coder" || id === "devops", now: 6_000,
    runningTurn: (agentId, pr) => {
      const hit = pr.taskId ? running.get(pr.taskId)
        : [...running.values()].find((r) => r.channel === pr.channel && r.chatId === pr.chatId)
      return hit && hit.agentId === agentId ? { channel: hit.channel, chatId: hit.chatId } : null
    },
  }, proof)

function turn(taskId: string, chatId = "chat-1") {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId, taskId, messagePreview: "ship the fix", fullMessage: "ship the fix",
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
}
const endTurn = (taskId: string, chatId = "chat-1") =>
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId, taskId, durationMs: 1, at: "" } as any)

/** coder speaking from its running turn in chat-1. */
const say = (action: string, extra: Record<string, unknown> = {}) =>
  api("POST", "/requests", { action, agentId: "coder", ...extra })

describe("an agent's statement about its request", () => {
  it("accept keeps the request of the running turn open after a clean end", () => {
    turn("t1")
    expect(say("accept").status).toBe(200)
    endTurn("t1")
    expect(store.get("req-t1")?.state).toBe("in_progress")
    expect((api("GET", "/requests").body as any).items.map((r: any) => r.id)).toEqual(["req-t1"])
  })

  it("wait records the question and shows the request as waiting on the owner", () => {
    turn("t1")
    expect(say("wait").status).toBe(400)
    expect(say("wait", { question: "Staging or production?" }).status).toBe(200)
    endTurn("t1")
    expect(store.get("req-t1")).toMatchObject({ state: "waiting_owner", question: "Staging or production?" })
  })

  it("done needs evidence and decline needs a reason", () => {
    turn("t1")
    say("accept")
    endTurn("t1")
    expect(say("done", { id: "req-t1" }).status).toBe(400)
    const r = say("done", { id: "req-t1", evidence: "https://example.test/pull/9" })
    expect(r.status).toBe(200)
    expect((r.body as any).request).toMatchObject({ state: "done", evidence: "https://example.test/pull/9" })
    expect(say("decline", { reason: "x", id: "req-t1" }).status).toBe(409)

    turn("t2", "chat-2")
    expect(say("decline", { id: "req-t2" }).status).toBe(400)
    expect(say("decline", { id: "req-t2", reason: "outside my access" }).status).toBe(200)
    expect(store.get("req-t2")).toMatchObject({ state: "declined", closeReason: "outside my access" })
  })

  it("in a later turn it needs the id: it never reaches for an older request of the chat", () => {
    turn("t1")
    say("accept")
    endTurn("t1")
    expect(tracker.liveRequestId("coder", "telegram", "chat-1")).toBeNull()
    // A later turn in the same chat, started by someone else: no request of its own.
    expect(say("done", { evidence: "https://example.test/deploy/3" }).status).toBe(404)
    expect(store.get("req-t1")?.state).toBe("in_progress")
    expect(say("done", { id: "req-t1", evidence: "https://example.test/deploy/3" }).status).toBe(200)
    expect(store.get("req-t1")?.state).toBe("done")
  })

  it("refuses a write that does not come from a running turn of the agent it names", () => {
    turn("t1")
    say("accept")
    running.set("run-devops", { agentId: "devops", channel: "a2a", chatId: "x" })
    // devops, from its own run, claiming to be coder.
    const forged = api("POST", "/requests", { action: "decline", agentId: "coder", id: "req-t1", reason: "tidy" }, { taskId: "run-devops" })
    expect(forged.status).toBe(403)
    // No proof at all, and a proof for a run that is over.
    expect(api("POST", "/requests", { action: "done", agentId: "coder", id: "req-t1", evidence: "x" }, {}).status).toBe(403)
    expect(api("POST", "/requests", { action: "done", agentId: "coder", id: "req-t1", evidence: "x" }, { taskId: "gone" }).status).toBe(403)
    expect(store.get("req-t1")?.state).toBe("in_progress")
    // The channel and chat of the running turn are accepted as proof too.
    expect(api("POST", "/requests", { action: "done", agentId: "coder", id: "req-t1", evidence: "https://example.test/p" }, { channel: "telegram", chatId: "chat-1" }).status).toBe(200)
  })

  it("refuses another agent's request, an unknown agent and a chat with nothing recorded", () => {
    turn("t1")
    running.set("run-devops", { agentId: "devops", channel: "a2a", chatId: "x" })
    expect(api("POST", "/requests", { action: "done", agentId: "devops", id: "req-t1", evidence: "x" }, { taskId: "run-devops" }).status).toBe(403)
    expect(api("POST", "/requests", { action: "accept", agentId: "ghost", id: "req-t1" }).status).toBe(400)
    expect(api("POST", "/requests", { action: "accept", agentId: "devops" }, { taskId: "run-devops" }).status).toBe(404)
    expect(store.get("req-t1")?.state).toBe("candidate")
  })

  it("never lets an agent drop a request", () => {
    turn("t1")
    say("accept")
    expect(say("drop", { reason: "tidy up" })).toEqual({ status: 403, body: { error: OWNER_ONLY } })
    expect(store.get("req-t1")?.state).toBe("in_progress")
  })

  it("refuses to record anything while requests are off", () => {
    turn("t1")
    enabled = false
    expect(say("accept").status).toBe(409)
    expect((api("GET", "/requests").body as any).enabled).toBe(false)
  })
})

describe("reading", () => {
  it("lists open requests oldest first and hides candidates", () => {
    turn("t1"); say("accept"); endTurn("t1")
    turn("t2", "chat-2")
    const body = api("GET", "/requests").body as any
    expect(body).toMatchObject({ count: 1, truncated: false })
    expect(api("GET", "/requests/req-t2").status).toBe(404)
    const one = api("GET", "/requests/req-t1").body as any
    expect(one.links).toEqual([{ kind: "run", ref: "t1", at: 5_000 }])
  })

  it("is gated like the approvals endpoints", () => {
    expect(isMeshGatedPath("/requests")).toBe(true)
    expect(isMeshGatedPath("/requests/req-1")).toBe(true)
  })
})

describe("the agentx_request tool", () => {
  const viaApi = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    const proof = { taskId: h.get("x-agentx-task") ?? undefined, channel: h.get("x-agentx-channel") ?? undefined, chatId: h.get("x-agentx-chat") ?? undefined }
    const r = api(init?.method ?? "GET", new URL(url).pathname, init?.body ? JSON.parse(String(init.body)) : undefined, proof)
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  const env = { AGENTX_AGENT_ID: "coder", AGENTX_CHANNEL: "telegram", AGENTX_CHAT_ID: "chat-1" } as NodeJS.ProcessEnv
  const tool = (args: Record<string, unknown>) => runRequestTool(args, { daemonUrl: "http://127.0.0.1:1", fetch: viaApi, env })

  it("accepts, then answers what is still open, then closes with evidence", async () => {
    turn("t1")
    expect(await tool({ action: "accept" })).toContain("Request req-t1 is open and in progress")
    endTurn("t1")
    const open = await tool({})
    expect(open).toContain("1 open request, oldest first.")
    expect(open).toContain("req-t1 [in progress]")
    expect(open).toContain("ship the fix")
    expect(await tool({ action: "done", id: "req-t1", evidence: "https://example.test/pull/9" })).toBe("Request req-t1 is closed as done. Evidence: https://example.test/pull/9")
    expect(await tool({ action: "list" })).toContain("No open requests.")
  })

  it("returns refusals as text", async () => {
    expect(await tool({ action: "done" })).toMatch(/^Error: This turn has no recorded request/)
    // The run's task id, when the runtime sets it, is the proof the tool sends.
    expect(await runRequestTool({ action: "done", id: "req-none" }, { daemonUrl: "http://127.0.0.1:1", fetch: viaApi, env: { AGENTX_AGENT_ID: "coder", AGENTX_TASK_ID: "gone" } as NodeJS.ProcessEnv }))
      .toMatch(/^Error: no running turn of "coder" matches this call/)
    turn("t1")
    expect(await tool({ action: "done" })).toBe("Error: a finished request needs a link to the evidence")
    expect(await tool({ action: "drop" })).toBe(`Error: ${OWNER_ONLY}`)
    enabled = false
    expect(await tool({ action: "list" })).toContain("turned off")
  })

  it("shows the question of a request that waits on the owner", () => {
    expect(describeOpen([{ id: "req-1", state: "waiting_owner", question: "Which server?", createdAt: 0, channel: "voice", agentId: "coder", text: "deploy" }]))
      .toBe("- req-1 [waiting on the owner] 1970-01-01 00:00 UTC, voice, coder: deploy. Question: Which server?")
  })
})

describe("settings", () => {
  it("reads defaults, saves changes through the config schema and rejects bad values", async () => {
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: {} }))
    expect(readRequestSettings(configPath)).toEqual({ enabled: false, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 })
    const ok = await updateRequestSettings({ enabled: true, from: ["telegram:4242"], staleAfterHours: 12 }, { configPath, reload: false })
    expect(ok.success).toBe(true)
    expect(JSON.parse(readFileSync(configPath, "utf-8")).requests).toEqual({ enabled: true, from: ["telegram:4242"], staleAfterHours: 12 })
    expect(readRequestSettings(configPath)).toMatchObject({ enabled: true, staleAfterHours: 12, retentionDays: 90 })
    const bad = await updateRequestSettings({ staleAfterHours: -1 }, { configPath, reload: false })
    expect(bad.success).toBe(false)
    expect((await updateRequestSettings({ from: ["no-channel"] }, { configPath, reload: false })).success).toBe(false)
    expect(readRequestSettings(configPath).staleAfterHours).toBe(12)
  })
})
