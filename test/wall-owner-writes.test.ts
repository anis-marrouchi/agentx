import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { listCards, saveCard, type DecisionCard } from "../src/approvals/cards"
import { closeDb, openDb } from "../src/storage/sqlite"
import { RequestStore } from "../src/requests/store"
import { RequestTracker } from "../src/requests/tracker"

// #1440: the Wall answers what waits on the owner under /api/admin/wall
// (#1454's guard), served by the calls the classic pages make. Only the
// owner may: the dashboard refuses an answer
// without the dashboard token, from this machine or through a peer, and
// the card stays as it was. With the token, the record is the one
// /approvals writes.

const TOKEN = "demo-dashboard-token"
const home = process.cwd()
let server: Server
let base: string
let requests: RequestStore

const card = (id: string): DecisionCard => ({
  id, title: "Send the newsletter?", ask: "Send it today?", recommend: "Yes: it is ready", if_silent: "keep",
  expires: new Date(Date.now() + 3600e3).toISOString(), raised_by: "writer", created_at: new Date().toISOString(), status: "pending",
})

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", ...headers },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-owner-")))
  writeFileSync("agentx.json", JSON.stringify({ agents: { writer: { name: "Writer" }, coder: { name: "Coder" } }, requests: { enabled: true } }))
  saveCard(process.cwd(), card("c-1"))
  // Three open requests in the folder's own database, as the daemon keeps them.
  const db = openDb({ quiet: true })!
  db.exec("CREATE TABLE IF NOT EXISTS task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, final_response TEXT)")
  requests = new RequestStore(db)
  const tracker = new RequestTracker(requests, () => ({ enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }), () => {}, () => Date.now())
  for (const taskId of ["t1", "t2", "t3"]) {
    tracker.taskStarted({ agentId: "writer", channel: "voice", chatId: "mac", taskId, messagePreview: "", fullMessage: "Build the weekly report.", at: "", humanRoot: true, operator: true } as any)
    tracker.taskCompleted({ agentId: "writer", channel: "voice", chatId: "mac", taskId, durationMs: 1, error: "Task timed out after 60 minutes", at: "" } as any)
  }
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { daemonUrl: "http://daemon.invalid:18800", token: TOKEN },
  })
  const ctx = { boards: [], sources: new Map(), token: TOKEN, config } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
})

describe("owner-only answers from the Wall (#1440)", () => {
  it("refuses an answer without the dashboard token, and leaves the card waiting", async () => {
    expect((await post("/api/admin/wall/decide", { key: "card:c-1", action: "yes" })).status).toBe(401)
    expect((await post("/api/admin/wall/decide", { key: "card:c-1", action: "yes" }, { Authorization: "Bearer not-the-token" })).status).toBe(401)
    // Sent on to another node, as for a post kept there: refused here first.
    expect((await post("/api/admin/wall/decide", { key: "card:c-1", action: "yes" }, { "X-Agentx-Peer": "node-b" })).status).toBe(401)
    expect(listCards(process.cwd(), "pending").map((c) => c.id)).toEqual(["c-1"])
  })

  it("refuses a review decision without the dashboard token", async () => {
    expect((await post("/api/admin/wall/review/approve", { msgHash: "m-1" })).status).toBe(401)
    expect((await post("/api/admin/wall/review/reject", { msgHash: "m-1" })).status).toBe(401)
  })

  // One per alias: refused for anyone but the owner, and served by the
  // Open requests call of /approvals for the owner.
  const ALIASES = [
    { act: "reply", body: { id: "req-t1", text: "Send me the file." }, message: "Reply sent: Writer will go on with req-t1", state: "in_progress" },
    { act: "handoff", body: { id: "req-t2", agentId: "coder" }, message: "Coder has req-t2 now", state: "in_progress" },
    { act: "close", body: { id: "req-t3", action: "drop" }, message: "req-t3 dropped", state: "dropped" },
  ]
  for (const a of ALIASES) {
    it(`refuses /wall/request/${a.act} to anyone but the owner, and the request stays as it was`, async () => {
      const before = requests.get(a.body.id)
      expect((await post(`/api/admin/wall/request/${a.act}`, a.body)).status).toBe(401)
      expect((await post(`/api/admin/wall/request/${a.act}`, a.body, { Authorization: "Bearer not-the-token" })).status).toBe(401)
      expect((await post(`/api/admin/wall/request/${a.act}`, a.body, { "X-Agentx-Peer": "node-b" })).status).toBe(401)
      expect(requests.get(a.body.id)).toEqual(before)
    })

    it(`serves /wall/request/${a.act} for the owner through the /approvals call`, async () => {
      const r = await post(`/api/admin/wall/request/${a.act}`, a.body, { Authorization: `Bearer ${TOKEN}` })
      expect(r.status).toBe(200)
      expect((await r.json()).message).toContain(a.message)
      expect(requests.get(a.body.id)!.state).toBe(a.state)
    })
  }

  it("tells the page whether it is the owner", async () => {
    const get = (h: Record<string, string>) => fetch(base + "/api/admin/approvals", { headers: h }).then((r) => r.json())
    expect((await get({ Authorization: `Bearer ${TOKEN}` })).owner).toBe(true)
  })

  it("takes the owner's answer, with the same record /approvals writes", async () => {
    const r = await post("/api/admin/wall/decide", { key: "card:c-1", action: "yes" }, { Authorization: `Bearer ${TOKEN}` })
    expect(r.status).toBe(200)
    expect((await r.json()).message).toContain("writer will be told yes")
    const done = listCards(process.cwd(), "decided").find((c) => c.id === "c-1")!
    expect(done).toMatchObject({ verdict: "yes", decided_by: "operator (dashboard)" })
    // And it is on the answered list the Answered tab reads.
    const list = await fetch(base + "/api/admin/approvals?answered=1", { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
    expect(list.answered[0]).toMatchObject({ key: "card:c-1", kind: "card", title: "Send the newsletter?", raised_by: "writer", answer: "yes", by: "operator (dashboard)" })
  })
})
