import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { listCards, saveCard, type DecisionCard } from "../src/approvals/cards"

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
  writeFileSync("agentx.json", JSON.stringify({ agents: { writer: { name: "Writer" } } }))
  saveCard(process.cwd(), card("c-1"))
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

  it("refuses a request reply, hand-off or close without the dashboard token", async () => {
    expect((await post("/api/admin/wall/request/reply", { id: "r-1", text: "go on" })).status).toBe(401)
    expect((await post("/api/admin/wall/request/handoff", { id: "r-1", agentId: "writer" })).status).toBe(401)
    expect((await post("/api/admin/wall/request/close", { id: "r-1", action: "drop" })).status).toBe(401)
  })

  it("serves a request action with the owner's token through the /approvals call", async () => {
    // No request store in this folder: the /approvals handler's own answer.
    const r = await post("/api/admin/wall/request/close", { id: "r-1", action: "drop" }, { Authorization: `Bearer ${TOKEN}` })
    expect(r.status).toBe(404)
    expect((await r.json()).error).toContain('no request "r-1"')
  })

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
