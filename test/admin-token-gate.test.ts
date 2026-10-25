import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"

// #1302: every /api/admin/* route needs dashboard.token unless listed here.
// These stay open for now: the browser reads them through EventSource or the
// /activity map, which cannot send the token yet.
const OPEN = new Set([
  "/api/admin/logs/stream",
  "/api/admin/activity-graph",
  "/api/admin/activity-graph/stream",
  "/api/admin/activity-graph/dispatch/x",
])

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

function get(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method: "GET", headers }, (res) => {
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
    for (const path of ["/admin/health", "/admin/cost", "/admin/ledger"]) {
      expect(await page(path), path).toContain('window.AX_LOCAL_TOKEN = "tok-123"')
    }
  })
})
