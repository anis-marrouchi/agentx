import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall, type RequestsApiDeps } from "../src/requests/daemon-api"
import { fetchAllowFromConfig, localUrlRefused, setFetchAllow } from "../src/requests/checkers/fetch-guard"
import type { CheckResult } from "../src/requests/checkers"

// #2535: a promise on a Mac (daemon on 18800) got a closeWhen on
// localhost:19900, another node's port. The guard refused it at close time
// only, so the promise could never close. Now it is refused when made, and
// a kept one closes on its agent's check proof.

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const AGENTS = new Set(["coder", "devops"])

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let clock: number
let verdict: CheckResult

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-2535-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  verdict = { verdict: "unverifiable", detail: "http://localhost:19900/health could not be reached: refused: localhost is a local name" }
  // A Mac-style node: bound to loopback on 18800.
  setFetchAllow(fetchAllowFromConfig({ node: { bind: "127.0.0.1:18800" } }))
})
afterEach(() => {
  setFetchAllow([])
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const deps = (): RequestsApiDeps => ({
  store, tracker, enabled: true, hasAgent: (id) => AGENTS.has(id), now: clock,
  runningTurn: (agentId) => (AGENTS.has(agentId) ? { channel: "telegram", chatId: "chat-1" } : null),
  check: async () => verdict,
})
const post = (body: Record<string, unknown>) => handleRequestsCall("POST", "/requests", body, { ...deps(), now: clock })
const promise = (url: string) => post({ action: "promise", agentId: "coder", owedTo: "devops", text: "Install 0.311.0", closeWhen: { kind: "url", url, contains: "0.311.0" } })

describe("a closeWhen on a local address this node never opens (#2535)", () => {
  it("is refused when the promise is made, naming this node's own address", async () => {
    const res = await promise("http://localhost:19900/health")
    expect(res.status).toBe(400)
    expect((res.body as any).error).toMatch(/localhost:19900 is a local address this node never opens; this node's own address is http:\/\/127\.0\.0\.1:18800/)
    expect((await promise("http://127.0.0.1:6379/")).status).toBe(400)
    expect((await promise("http://[::1]:19900/health")).status).toBe(400)
    expect(store.listOpen()).toEqual([])
  })

  it("is kept on the node's real port and on a public address", async () => {
    expect((await promise("http://localhost:18800/health")).status).toBe(200)
    expect((await promise("http://127.0.0.1:18800/health")).status).toBe(200)
    expect((await promise("https://example.com/health")).status).toBe(200)
  })

  it("a Linux-style node (0.0.0.0:19900) keeps its own port and refuses the Mac's", () => {
    const linux = fetchAllowFromConfig({ node: { bind: "0.0.0.0:19900" } })
    expect(localUrlRefused(new URL("http://localhost:19900/health"), linux)).toBeNull()
    expect(localUrlRefused(new URL("http://localhost:18800/health"), linux)).toMatch(/never opens/)
    expect(localUrlRefused(new URL("http://192.168.1.10/x"), linux)).toMatch(/never opens/)
    expect(localUrlRefused(new URL("https://box.example.com/x"), linux)).toBeNull()
  })
})

describe("a kept promise whose check can never run (#2535)", () => {
  const kept = () => {
    store.addPromise({ id: "prm-dead", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "Install 0.311.0", owedTo: "devops", now: clock })
    store.setLoop("prm-dead", { closeWhen: { kind: "url", url: "http://localhost:19900/health", contains: "0.311.0" } }, clock)
    return "prm-dead"
  }

  it("a done without a check proof stays open and says how to close it", async () => {
    const id = kept()
    const res = await post({ action: "done", work: "ops", agentId: "coder", id, evidence: "Mac /health shows 0.311.0" })
    expect(res.status).toBe(202)
    expect((res.body as any).detail).toMatch(/can never run here: close it with proof: \{kind:"check"/)
    expect(store.get(id)?.state).toBe("in_progress")
  })

  it("closes on its agent's check proof, kept unverified with why", async () => {
    const id = kept()
    const res = await post({
      action: "done", work: "ops", agentId: "coder", id, evidence: "Mac /health shows 0.311.0",
      proof: { kind: "check", value: "curl http://127.0.0.1:18800/health shows version 0.311.0" },
    })
    expect(res.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "unverified", verifyDetail: expect.stringMatching(/its check never ran: localhost:19900/) })
  })

  it("another agent cannot close it", async () => {
    const id = kept()
    const res = await post({ action: "done", work: "ops", agentId: "devops", id, proof: { kind: "check", value: "looked" } })
    expect(res.status).toBe(403)
    expect(store.get(id)?.state).toBe("in_progress")
  })

  it("a check that can run is still not skipped by a check proof", async () => {
    store.addPromise({ id: "prm-live", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "Install", owedTo: "devops", now: clock })
    store.setLoop("prm-live", { closeWhen: { kind: "url", url: "http://127.0.0.1:18800/health", contains: "0.311.0" } }, clock)
    verdict = { verdict: "not_met", detail: "answered without 0.311.0" }
    const res = await post({ action: "done", work: "ops", agentId: "coder", id: "prm-live", proof: { kind: "check", value: "I looked" } })
    expect(res.status).toBe(409)
    expect(store.get("prm-live")?.state).toBe("in_progress")
  })
})
