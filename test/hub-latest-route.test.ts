// #2101 R26 C2/C3: GET /api/mesh/latest is a read behind the same guard as
// /api/live (it is routed beside it, with no gate of its own), only for a
// node in the dashboard's allowlist; a node that does not answer is a 502
// (the Hub then says "not checked").
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"

// A port nothing listens on: this node "does not answer".
const SILENT = "http://127.0.0.1:9"
const home = process.cwd()
let server: Server
let base = ""

function call(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); res.destroy() })
    r.setTimeout(15_000, () => r.destroy(new Error(`timeout: ${path}`)))
    r.on("error", reject)
    r.end()
  })
}
const auth = { Authorization: "Bearer tok-123" }
const latest = (q: Record<string, string>) => "/api/mesh/latest?" + new URLSearchParams(q).toString()

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-hub-latest-")))
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { token: "tok-123", daemonUrl: SILENT } })
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

describe("GET /api/mesh/latest", () => {
  it("sits behind the same guard as /api/live: same answer with no token or a wrong one", async () => {
    // From off the box, the dashboard's off-box guard (dashboard-offbox-token)
    // stands in front of both; on loopback both pass to the route.
    for (const h of [{}, { Authorization: "Bearer wrong" }]) {
      const live = await call("/api/live?quick=1", h)
      const mine = await call(latest({ node: SILENT, agent: "pm" }), h)
      expect(live === 401).toBe(mine === 401)
    }
  })
  it("needs a node and an agent", async () => {
    expect(await call(latest({ agent: "pm" }), auth)).toBe(400)
    expect(await call(latest({ node: SILENT }), auth)).toBe(400)
  })
  it("reads only a node in the allowlist", async () => {
    expect(await call(latest({ node: "http://example.invalid:18800", agent: "pm" }), auth)).toBe(403)
  })
  it("a node that does not answer is a 502, so the Hub says not checked", async () => {
    expect(await call(latest({ node: SILENT, agent: "pm" }), auth)).toBe(502)
  })
  it("is GET only", async () => {
    expect(await call(latest({ node: SILENT, agent: "pm" }), auth, "POST")).not.toBe(502)
    expect(await call(latest({ node: SILENT, agent: "pm" }), auth, "POST")).toBeGreaterThanOrEqual(400)
  })
})
