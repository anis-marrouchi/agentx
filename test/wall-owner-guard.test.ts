import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "http"
import { mkdtempSync, readdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { closeDb } from "../src/storage/sqlite"
import { isWallWrite, WALL_ACTIONS_PREFIX } from "../src/daemon/wall-actions"

// #1454: every Wall write is the owner's. One guard in board-dashboard.ts
// refuses a write under /api/admin/wall without the owner's token, so a new
// write route is covered without being added anywhere. The routes below are
// read from the source, the pages' calls and the route comments, so a new
// one lands in this test by itself.

const SRC = join(__dirname, "../src/daemon")
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []))
const SOURCES = files(SRC).map((f) => ({ f, text: readFileSync(f, "utf8") }))
const WRITE = "POST|PUT|PATCH|DELETE"

// What the pages send: act('POST', '/api/admin/...') and the route comments
// ("POST /api/admin/wall/comment  {id, text}").
const PAGE_WRITES = [...new Set(SOURCES.flatMap(({ text }) =>
  [...text.matchAll(new RegExp(`act\\('(?:${WRITE})', '(/api/[^'?]*)'`, "g"))].map((m) => m[1])))]
const DOC_WRITES = [...new Set(SOURCES.flatMap(({ text }) =>
  [...text.matchAll(new RegExp(`(?:${WRITE})\\s+(${WALL_ACTIONS_PREFIX}/[a-z/-]+)`, "g"))].map((m) => m[1])))]
// A route nobody has built yet: the guard must hold for it too.
const UNBUILT = `${WALL_ACTIONS_PREFIX}/not-built-yet`
const ROUTES = [...new Set([...PAGE_WRITES.filter((p) => p.startsWith(WALL_ACTIONS_PREFIX)), ...DOC_WRITES, UNBUILT])]

const home = process.cwd()
const servers: Server[] = []
let withToken = ""
let noToken = ""

function post(base: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
      res.destroy()
    })
    r.setTimeout(10_000, () => r.destroy(new Error(`timeout: ${path}`)))
    r.on("error", reject)
    r.end("{}")
  })
}

async function serve(token?: string): Promise<string> {
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: token ? { token } : {} })
  const server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "agentx-wall-guard-")))
  withToken = await serve("tok-wall")
  noToken = await serve()
})

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections?.()
    await new Promise<void>((r) => s.close(() => r()))
  }
  closeDb()
  process.chdir(home)
})

describe("Wall owner-only write guard (#1454)", () => {
  it("finds every Wall write route the pages and the route comments name", () => {
    expect(ROUTES).toEqual(expect.arrayContaining([
      "/api/admin/wall/comment", "/api/admin/wall/post", "/api/admin/wall/call",
      "/api/admin/wall/space", "/api/admin/wall/space/say", "/api/admin/wall/space/stop",
      "/api/admin/wall/budget",
    ]))
  })

  it("keeps every write a Wall page sends under the guarded prefix", () => {
    const wallPages = SOURCES.filter(({ f }) => /ui\/pages\/wall[^/]*\.ts$/.test(f))
    const outside = wallPages.flatMap(({ f, text }) =>
      [...text.matchAll(new RegExp(`act\\('(?:${WRITE})', '([^']*)'`, "g"))]
        .map((m) => m[1]).filter((p) => !isWallWrite("POST", p)).map((p) => `${f}: ${p}`))
    expect(outside).toEqual([])
  })

  it("treats reads as reads and anything else under the prefix as a write", () => {
    expect(isWallWrite("GET", "/api/admin/wall/space")).toBe(false)
    expect(isWallWrite("HEAD", "/api/admin/wall")).toBe(false)
    expect(isWallWrite("OPTIONS", "/api/admin/wall/comment")).toBe(false)
    expect(isWallWrite("DELETE", "/api/admin/wall/comment")).toBe(true)
    expect(isWallWrite("POST", "/api/admin/wallpaper")).toBe(false)
    expect(isWallWrite("POST", "/api/admin/approvals")).toBe(false)
  })

  it("refuses every Wall write without the owner's token", async () => {
    const open: string[] = []
    for (const path of ROUTES) {
      for (const headers of [{}, { Authorization: "Bearer wrong" }, { "X-Agentx-Peer": "http://peer.example:4100" }]) {
        const status = await post(withToken, path, headers)
        if (status !== 401) open.push(`${path} ${JSON.stringify(headers)} → ${status}`)
      }
    }
    expect(open).toEqual([])
  })

  it("lets the owner's token through to the route", async () => {
    // An empty body: the route itself answers, so the guard let it pass.
    expect(await post(withToken, "/api/admin/wall/comment", { Authorization: "Bearer tok-wall" })).toBe(400)
    expect(await post(withToken, "/api/admin/wall/post", { Authorization: "Bearer tok-wall" })).toBe(400)
    expect(await post(withToken, "/api/admin/wall/budget", { Authorization: "Bearer tok-wall" })).toBe(400)
  })

  it("starting a workflow run is the owner's too (#1445)", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) expect(await post(withToken, "/workflows/demo/run", headers)).toBe(401)
    expect(await post(noToken, "/workflows/demo/run", { "X-Forwarded-For": "203.0.113.7" })).toBe(401)
    // Past the guard, the dashboard asks the daemon, which is not running here.
    expect(await post(withToken, "/workflows/demo/run", { Authorization: "Bearer tok-wall" })).toBe(502)
  })

  it("with no dashboard token, writes only from this machine", async () => {
    expect(await post(noToken, "/api/admin/wall/comment")).toBe(400)
    const open: string[] = []
    for (const path of ROUTES) {
      const status = await post(noToken, path, { "X-Forwarded-For": "203.0.113.7" })
      if (status !== 401) open.push(`${path} → ${status}`)
    }
    expect(open).toEqual([])
  })

  it("with no dashboard token, shows Settings only to a viewer on this machine", async () => {
    const page = async (headers: Record<string, string> = {}) => (await fetch(`${noToken}/wall`, { headers })).text()
    expect(await page()).toContain('data-nav="settings"')
    expect(await page({ "X-Forwarded-For": "203.0.113.7" })).not.toContain('data-nav="settings"')
  })
})
