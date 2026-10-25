import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"
import { hasStreamTicket, streamTicket, STREAM_TICKET_TTL_S } from "../src/daemon/dashboard-session"

// #1302: every /api/admin/* route needs dashboard.token unless listed here.
// The streams (logs, activity map) closed the list with stream tickets.
const OPEN = new Set<string>([])

// Route literals the dashboard router matches, read from its source so a new
// route lands in this test without anyone adding it by hand.
const SOURCE = readFileSync(join(__dirname, "../src/daemon/board-dashboard.ts"), "utf8")
const ROUTES = [...new Set(
  [...SOURCE.matchAll(/path(?:\.startsWith\(| === )"(\/api\/admin\/[^"]*)"/g)]
    .map((m) => (m[0].includes("startsWith") ? m[1] + (m[1].endsWith("/") ? "x" : "") : m[1])),
)]
// Named reads behind the observability and ledger prefixes.
const READS = [
  ...["overview", "summary", "activity", "errors", "routing", "rotations", "cost", "cost.csv", "budgets"].map((s) => `/api/admin/observability/${s}`),
  ...["stats", "events", "divergences", "active"].map((s) => `/api/admin/ledger/${s}`),
  "/api/admin/doctor",
]

const home = process.cwd()
let server: Server
let base = ""

function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
      res.destroy()
    })
    r.setTimeout(10_000, () => r.destroy(new Error(`timeout: ${path}`)))
    r.on("error", reject)
    r.end()
  })
}

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-admin-gate-")))
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { token: "tok-123" } })
  server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token: "tok-123", config } as unknown as Ctx)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
  closeDb()
  process.chdir(home)
})

describe("admin token gate (#1302)", () => {
  it("finds the router's admin routes", () => {
    expect(ROUTES).toContain("/api/admin/observability/x")
    expect(ROUTES).toContain("/api/admin/doctor")
  })

  it("answers 401 without the token on every admin route but the open list", async () => {
    const open: string[] = []
    for (const path of [...new Set([...ROUTES, ...READS])]) {
      if (OPEN.has(path)) continue
      if ((await get(path)) !== 401) open.push(path)
    }
    expect(open).toEqual([])
  })

  it("answers 401 with a wrong token", async () => {
    expect(await get("/api/admin/observability/budgets", { Authorization: "Bearer wrong" })).toBe(401)
    expect(await get("/api/admin/observability/cost.csv", { Authorization: "Bearer wrong" })).toBe(401)
  })

  it("serves the reads with the token", async () => {
    for (const path of ["/api/admin/observability/budgets", "/api/admin/observability/cost", "/api/admin/observability/cost.csv"]) {
      expect(await get(path, { Authorization: "Bearer tok-123" }), path).not.toBe(401)
    }
  })

  it("gives the Health, Cost and Ledger pages the token for their reads", async () => {
    const page = (path: string) => new Promise<string>((resolve, reject) => {
      request(base + path, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)) }).on("error", reject).end()
    })
    for (const path of ["/admin/health", "/admin/cost", "/admin/ledger", "/activity?view=map"]) {
      expect(await page(path), path).toContain('window.AX_LOCAL_TOKEN = "tok-123"')
    }
  })
})

describe("stream tickets", () => {
  const mint = (headers: Record<string, string>) => new Promise<{ status: number; ticket: string }>((resolve, reject) => {
    request(base + "/api/admin/stream-ticket", { method: "POST", headers }, (res) => {
      let b = ""
      res.on("data", (c) => (b += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, ticket: res.statusCode === 200 ? JSON.parse(b).ticket : "" }))
    }).on("error", reject).end()
  })

  it("mints a ticket only for the token", async () => {
    expect((await mint({})).status).toBe(401)
    expect((await mint({ Authorization: "Bearer wrong" })).status).toBe(401)
    const { status, ticket } = await mint({ Authorization: "Bearer tok-123" })
    expect(status).toBe(200)
    expect(ticket).toMatch(/^\d+\.[\w-]+$/)
    expect(ticket).not.toContain("tok-123")
  })

  it("does not follow the peer selector", async () => {
    expect((await mint({ Authorization: "Bearer tok-123", "X-Agentx-Peer": "http://peer.invalid:4202" })).status).toBe(200)
  })

  it("opens the streams, and only the streams", async () => {
    const { ticket } = await mint({ Authorization: "Bearer tok-123" })
    const st = `st=${encodeURIComponent(ticket)}`
    expect(await get(`/api/admin/activity-graph/stream?hours=1&${st}`)).toBe(200)
    expect(await get(`/api/admin/activity-graph/stream?hours=1&peer=fleet&${st}`)).toBe(200)
    for (const path of ["/api/admin/activity-graph", "/api/admin/observability/budgets", "/api/admin/doctor"]) {
      expect(await get(`${path}?${st}`), path).toBe(401)
    }
    expect(await get(`/api/admin/activity-graph/stream?hours=1&${st}`, {}, "POST")).toBe(401)
  })

  it("rejects a forged, foreign or expired ticket", async () => {
    const at = (t: string) => ({ url: `/api/admin/logs/stream?st=${encodeURIComponent(t)}` }) as never
    const now = Date.now()
    const good = streamTicket("tok-123", now)
    expect(hasStreamTicket(at(good), "tok-123", now)).toBe(true)
    expect(hasStreamTicket(at(good), "tok-123", now + (STREAM_TICKET_TTL_S + 1) * 1000)).toBe(false)
    expect(hasStreamTicket(at(streamTicket("other", now)), "tok-123", now)).toBe(false)
    expect(hasStreamTicket(at(`${Number(good.split(".")[0]) + 3600}.${good.split(".")[1]}`), "tok-123", now)).toBe(false)
    expect(hasStreamTicket(at("garbage"), "tok-123", now)).toBe(false)
    expect(hasStreamTicket(at(good), undefined, now)).toBe(false)
    expect(await get(`/api/admin/logs/stream?st=${encodeURIComponent(streamTicket("other"))}`)).toBe(401)
  })
})
