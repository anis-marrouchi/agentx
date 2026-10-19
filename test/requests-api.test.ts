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
    expect(readRequestSettings(configPath)).toEqual({ enabled: false, channels: [], from: [], staleAfterHours: 24, retentionDays: 90, plans: { enabled: true, stallMinutes: 30, maxNudges: 3, approveKinds: ["message"], disabledAgents: [], requireForWork: ["code"], requireOverMinutes: 30 }, checkers: { enabled: ["url", "issue", "git-ancestor", "reply"], checkEveryMinutes: 10, repos: {} } })
    const ok = await updateRequestSettings({ enabled: true, from: ["telegram:4242"], staleAfterHours: 12 }, { configPath, reload: false })
    expect(ok.success).toBe(true)
    expect(JSON.parse(readFileSync(configPath, "utf-8")).requests).toEqual({ enabled: true, from: ["telegram:4242"], staleAfterHours: 12 })
    expect(readRequestSettings(configPath)).toMatchObject({ enabled: true, staleAfterHours: 12, retentionDays: 90 })
    const bad = await updateRequestSettings({ staleAfterHours: -1 }, { configPath, reload: false })
    expect(bad.success).toBe(false)
    expect((await updateRequestSettings({ from: ["no-channel"] }, { configPath, reload: false })).success).toBe(false)
    expect(readRequestSettings(configPath).staleAfterHours).toBe(12)
    // Plans (#788): only the fields given are written.
    expect((await updateRequestSettings({ plans: { stallMinutes: 45, disabledAgents: ["bot"] } }, { configPath, reload: false })).success).toBe(true)
    expect(JSON.parse(readFileSync(configPath, "utf-8")).requests.plans).toEqual({ stallMinutes: 45, disabledAgents: ["bot"] })
    expect(readRequestSettings(configPath).plans).toEqual({ enabled: true, stallMinutes: 45, maxNudges: 3, approveKinds: ["message"], disabledAgents: ["bot"], requireForWork: ["code"], requireOverMinutes: 30 })
    expect((await updateRequestSettings({ plans: { maxNudges: -1 } }, { configPath, reload: false })).success).toBe(false)
  })
})

describe("home and the since list (#394)", () => {
  const getSince = (since: string) =>
    handleRequestsApi("GET", "/requests", undefined, {
      store, tracker, enabled, hasAgent: () => true, runningTurn: () => null, query: new URLSearchParams({ since }),
    })

  it("accept, wait and done record where the work lives", () => {
    turn("t1")
    expect(say("accept", { home: { kind: "issue", link: "https://gitlab.noqta.tn/noqta/noqta/-/issues/394" } }).status).toBe(200)
    expect(store.get("req-t1")?.home).toEqual({ kind: "issue", link: "https://gitlab.noqta.tn/noqta/noqta/-/issues/394" })
    expect(say("wait", { question: "Ship it?", home: { kind: "card", link: "followup-394" } }).status).toBe(200)
    expect(store.get("req-t1")?.home).toEqual({ kind: "card", link: "followup-394" })
    expect(say("done", { evidence: "https://example.com/pull/1", home: { kind: "issue", link: "https://example.com/i/1" } }).status).toBe(200)
    expect(store.get("req-t1")).toMatchObject({ state: "done", home: { kind: "issue", link: "https://example.com/i/1" } })
  })

  it("refuses a malformed home and changes nothing", () => {
    turn("t1")
    expect(say("accept", { home: { kind: "chat", link: "x" } }).status).toBe(400)
    expect(say("accept", { home: { kind: "issue" } }).status).toBe(400)
    expect(say("accept", { home: { kind: "idea", link: "x".repeat(501) } }).status).toBe(400)
    expect(say("decline", { reason: "no", home: { kind: "idea", link: "ideas/a.md" } }).status).toBe(400)
    expect(store.get("req-t1")).toMatchObject({ state: "candidate", home: null })
  })

  it("two requests can share one home", () => {
    turn("t1")
    say("accept", { home: { kind: "issue", link: "https://example.com/i/394" } })
    endTurn("t1")
    running.set("run-t2", { agentId: "coder", channel: "telegram", chatId: "chat-1" })
    turn("t2")
    expect(api("POST", "/requests", { action: "accept", agentId: "coder", home: { kind: "issue", link: "https://example.com/i/394" } }, { taskId: "run-t2" }).status).toBe(200)
    expect(store.get("req-t1")?.home?.link).toBe("https://example.com/i/394")
    expect(store.get("req-t2")?.home?.link).toBe("https://example.com/i/394")
  })

  it("GET /requests?since lists open and closed requests made since then, with links", () => {
    turn("t1")
    say("accept")
    say("done", { evidence: "https://example.com/pull/1" })
    endTurn("t1")
    const body = getSince("0").body as any
    expect(body.items.map((r: any) => [r.id, r.state])).toEqual([["req-t1", "done"]])
    expect(body.items[0].links).toEqual([{ kind: "run", ref: "t1", at: 5_000 }])
    expect((getSince("6000").body as any).items).toEqual([])
    expect(getSince("soon").status).toBe(400)
    expect(getSince("").status).toBe(400)
  })

  it("past 100, the since list keeps the newest, oldest first", () => {
    for (let i = 0; i < 105; i++) {
      store.addCandidate({ id: `req-${i}`, runId: `r${i}`, channel: "telegram", chatId: "chat-1", agentId: "coder", text: "x", now: 1_000 + i })
      store.progress(`req-${i}`, 1_000 + i)
    }
    const body = getSince("0").body as any
    expect(body).toMatchObject({ count: 100, truncated: true })
    expect(body.items[0].id).toBe("req-5")
    expect(body.items[99].id).toBe("req-104")
  })

  it("a step report with a home is refused", () => {
    turn("t1")
    say("accept")
    expect(say("step", { step: 1, status: "done", home: { kind: "issue", link: "https://example.com/i/1" } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("takes no home") },
    })
    expect(store.get("req-t1")?.home).toBeNull()
  })

  it("a home is also a request link, so a request keeps every home and an issue leads back to it", () => {
    turn("t1")
    say("accept", { home: { kind: "issue", link: "https://example.com/i/394" } })
    say("wait", { question: "Which file?", home: { kind: "idea", link: "ideas/followup.md" } })
    say("done", { evidence: "https://example.com/pull/1", home: { kind: "card", link: "followup-394" } })
    expect(store.links("req-t1").map((l) => [l.kind, l.ref])).toEqual([
      ["run", "t1"], ["issue", "https://example.com/i/394"], ["idea", "ideas/followup.md"],
    ])
    expect(store.get("req-t1")?.home).toEqual({ kind: "card", link: "followup-394" })
    expect(store.byLink("issue", "https://example.com/i/394")?.id).toBe("req-t1")
  })

  it("approval and erp homes are links too; a promise's home is linked when it is made", () => {
    turn("t1")
    say("accept", { home: { kind: "approval", link: "2026-10-18-x-uw01" } })
    say("done", { evidence: "e", home: { kind: "erp", link: "SO-2026-0042" } })
    expect(store.links("req-t1").map((l) => l.kind)).toEqual(["run", "approval", "erp"])
    const p = say("promise", { owedTo: "owner", text: "send the brochure", home: { kind: "issue", link: "https://example.com/i/20" } }).body as any
    expect(store.links(p.request.id)).toEqual([{ kind: "issue", ref: "https://example.com/i/20", at: 6_000 }])
  })

  it("a second request on the same issue keeps it in its column; the link stays with the first", () => {
    turn("t1")
    say("accept", { home: { kind: "issue", link: "https://example.com/i/394" } })
    endTurn("t1")
    running.set("run-t2", { agentId: "coder", channel: "telegram", chatId: "chat-1" })
    turn("t2")
    api("POST", "/requests", { action: "accept", agentId: "coder", home: { kind: "issue", link: "https://example.com/i/394" } }, { taskId: "run-t2" })
    expect(store.byLink("issue", "https://example.com/i/394")?.id).toBe("req-t1")
    expect(store.get("req-t2")?.home?.link).toBe("https://example.com/i/394")
  })

  it("the tool passes home through", async () => {
    let sent: any
    const fakeFetch = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({ request: { id: "req-x" } }), { status: 200 })
    }) as typeof fetch
    await runRequestTool({ action: "accept", home: { kind: "idea", link: "ideas/a.md" } }, { daemonUrl: "http://d", fetch: fakeFetch, env: { AGENTX_AGENT_ID: "coder" } })
    expect(sent.home).toEqual({ kind: "idea", link: "ideas/a.md" })
  })

  it("the tool passes the work and its estimate through, for the plan gate (#1048)", async () => {
    let sent: any
    const fakeFetch = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({ error: "Not started: code work needs a plan before it starts." }), { status: 409 })
    }) as typeof fetch
    const said = await runRequestTool({ action: "accept", work: "code", estimateMinutes: 90 }, { daemonUrl: "http://d", fetch: fakeFetch, env: { AGENTX_AGENT_ID: "coder" } })
    expect(sent).toMatchObject({ work: "code", estimateMinutes: 90 })
    expect(said).toBe("Error: Not started: code work needs a plan before it starts.")
  })
})

describe("GET /requests filters (#394)", () => {
  const get = (q: Record<string, string>) =>
    handleRequestsApi("GET", "/requests", undefined, {
      store, tracker, enabled, hasAgent: () => true, runningTurn: () => null, query: new URLSearchParams(q),
    }) as { status: number; body: any }
  /** Requests req-0 … req-(n-1), one ms apart; every third one closed, every third + 1 needing attention. */
  function seed(n: number) {
    for (let i = 0; i < n; i++) {
      store.addCandidate({ id: `req-${i}`, runId: `r${i}`, channel: "telegram", chatId: "chat-1", agentId: "coder", text: `ask ${i}`, now: 1_000 + i })
      store.progress(`req-${i}`, 1_000 + i)
      if (i % 3 === 0) store.close(`req-${i}`, "done", "https://example.com/pull/1", 2_000 + i)
      if (i % 3 === 1) store.needsAttention(`req-${i}`, "quiet", 2_000 + i)
    }
  }
  const ids = (b: any) => b.items.map((r: any) => r.id)

  it("without filters: open ones only, without links, as before", () => {
    seed(6)
    const { body } = get({})
    expect(ids(body)).toEqual(["req-1", "req-2", "req-4", "req-5"])
    expect(body).toMatchObject({ count: 4, total: 4, truncated: false })
    expect(body.items[0].links).toBeUndefined()
  })

  it("state picks states and groups; closed=1 adds the closed ones; links=1 adds links", () => {
    seed(6)
    expect(ids(get({ state: "needs_attention" }).body)).toEqual(["req-1", "req-4"])
    expect(ids(get({ state: "closed" }).body)).toEqual(["req-0", "req-3"])
    expect(ids(get({ state: "done,needs_attention" }).body)).toEqual(["req-0", "req-1", "req-3", "req-4"])
    expect(get({ closed: "1" }).body.total).toBe(6)
    expect(get({ state: "needs_attention", links: "1" }).body.items[0].links).toEqual([{ kind: "run", ref: "r1", at: 1_001 }])
  })

  it("closedSince counts what closed since then, whenever it was made", () => {
    seed(6)
    expect(ids(get({ closedSince: "2003" }).body)).toEqual(["req-3"])
  })

  it("pages from the oldest with limit and offset", () => {
    seed(7)
    const first = get({ closed: "1", limit: "3", offset: "0" }).body
    expect(ids(first)).toEqual(["req-0", "req-1", "req-2"])
    expect(first).toMatchObject({ total: 7, truncated: true, nextOffset: 3 })
    const last = get({ closed: "1", limit: "3", offset: "6" }).body
    expect(ids(last)).toEqual(["req-6"])
    expect(last.nextOffset).toBeUndefined()
  })

  it("refuses a bad filter", () => {
    for (const q of [{ state: "lost" }, { state: "," }, { limit: "0" }, { limit: "501" }, { limit: "2.5" }, { offset: "-1" }, { closedSince: "x" }]) {
      expect(get(q).status).toBe(400)
    }
  })
})
