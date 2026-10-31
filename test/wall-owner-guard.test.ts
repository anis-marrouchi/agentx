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
import { isWorkflowEditorWrite } from "../src/daemon/workflows-api"

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
// Stand-ins for the workflow stores: past the guard, a write lands here.
const WRITES: string[] = []
const STORE = {
  list: () => [], get: () => null, getSource: () => null,
  save: (wf: { id: string }) => { WRITES.push(`save ${wf.id}`); return wf },
  delete: (id: string) => { WRITES.push(`delete ${id}`); return true },
}
const LAYOUTS = {
  get: () => null,
  save: (id: string, l: unknown) => { WRITES.push(`layout ${id}`); return l },
  delete: () => {},
}
const servers: Server[] = []
let withToken = ""
let noToken = ""

function post(base: string, path: string, headers: Record<string, string> = {}, method = "POST"): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", ...headers } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
      res.destroy()
    })
    r.setTimeout(10_000, () => r.destroy(new Error(`timeout: ${path}`)))
    r.on("error", reject)
    r.end(method === "DELETE" ? undefined : "{}")
  })
}

// A closed port: a daemon running on this machine must not answer for "demo" (#1579).
const CLOSED = "http://127.0.0.1:1"

async function serve(token?: string): Promise<string> {
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: CLOSED, ...(token ? { token } : {}) } })
  const server = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config, workflowStore: STORE, workflowRuns: {}, workflowLayouts: LAYOUTS } as unknown as Ctx)
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
    const page = async (headers: Record<string, string> = {}) => (await fetch(`${noToken}/hub`, { headers })).text()
    expect(await page()).toContain('data-nav="settings"')
    expect(await page({ "X-Forwarded-For": "203.0.113.7" })).not.toContain('data-nav="settings"')
  })

  it("keeps the ask-an-agent proxy for the owner, reads included", async () => {
    const open: string[] = []
    // post() sends a body, which a GET may not carry: reads go through fetch.
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      for (const p of ["/api/assistant/threads", "/api/assistant/thread?id=c1"]) {
        const status = (await fetch(withToken + p, { headers })).status
        if (status !== 401) open.push(`GET ${p} ${JSON.stringify(headers)} → ${status}`)
      }
    }
    const offRead = (await fetch(`${noToken}/api/assistant/threads`, { headers: { "X-Forwarded-For": "203.0.113.7" } })).status
    if (offRead !== 401) open.push(`GET /api/assistant/threads off the machine, no token set → ${offRead}`)
    for (const [m, p] of [["POST", "/api/assistant"], ["POST", "/api/assistant/delete"]]) {
      for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
        const status = await post(withToken, p, headers, m)
        if (status !== 401) open.push(`${m} ${p} ${JSON.stringify(headers)} → ${status}`)
      }
      const off = await post(noToken, p, { "X-Forwarded-For": "203.0.113.7" }, m)
      if (off !== 401) open.push(`${m} ${p} off the machine, no token set → ${off}`)
    }
    expect(open).toEqual([])
    // Past the guard, the proxy asks the node, which is not running here.
    expect(await post(withToken, "/api/assistant", { Authorization: "Bearer tok-wall" })).not.toBe(401)
    expect(await post(noToken, "/api/assistant")).not.toBe(401)
  })

  // #1609: the classic pages show the drawer, so on this machine they carry
  // the token its owner-only calls need; off the machine they never do.
  it("gives the drawer's pages the owner's token on this machine only", async () => {
    const wrong: string[] = []
    for (const p of ["/mesh", "/monitor", "/workflows", "/admin/projects", "/guests"]) {
      const on = await (await fetch(withToken + p)).text()
      if (!on.includes('id="ax-as"')) wrong.push(`${p}: no drawer`)
      if (!on.includes('window.AX_LOCAL_TOKEN = "tok-wall"')) wrong.push(`${p}: no token on this machine`)
      const off = await (await fetch(withToken + p, { headers: { "X-Forwarded-For": "203.0.113.7" } })).text()
      if (off.includes("tok-wall")) wrong.push(`${p}: token sent off the machine`)
    }
    expect(wrong).toEqual([])
    // The first-run wizard has no agents to ask and no drawer.
    expect(await (await fetch(withToken + "/setup")).text()).not.toContain('id="ax-as"')
  })

  // #1524: the workflow editor is a Wall page, and what it writes is the owner's.
  const EDITOR_WRITES: Array<[string, string]> = [
    ["POST", "/api/workflows"], ["PUT", "/api/workflows/deploy"], ["DELETE", "/api/workflows/deploy"],
    ["PUT", "/api/workflows/deploy/layout"], ["POST", "/api/workflows/editor/chat"],
  ]

  it("knows which workflow routes are the editor's writes (#1524)", () => {
    for (const [m, p] of EDITOR_WRITES) expect(isWorkflowEditorWrite(m, p), `${m} ${p}`).toBe(true)
    expect(isWorkflowEditorWrite("GET", "/api/workflows/deploy")).toBe(false)
    expect(isWorkflowEditorWrite("GET", "/api/workflows/deploy/layout")).toBe(false)
    // Checking a draft changes nothing; runs and settings have rules of their own.
    expect(isWorkflowEditorWrite("POST", "/api/workflows/deploy/validate")).toBe(false)
    expect(isWorkflowEditorWrite("POST", "/api/workflows/runs/r1/status")).toBe(false)
    expect(isWorkflowEditorWrite("POST", "/api/workflows/signal/go")).toBe(false)
    expect(isWorkflowEditorWrite("POST", "/api/workflows/required")).toBe(false)
  })

  it("refuses the editor's writes without the owner's token (#1524)", async () => {
    const open: string[] = []
    for (const [m, p] of EDITOR_WRITES) {
      for (const headers of [{}, { Authorization: "Bearer wrong" }, { "X-Agentx-Peer": "http://peer.example:4100" }]) {
        const status = await post(withToken, p, headers, m)
        if (status !== 401) open.push(`${m} ${p} ${JSON.stringify(headers)} → ${status}`)
      }
      const off = await post(noToken, p, { "X-Forwarded-For": "203.0.113.7" }, m)
      if (off !== 401) open.push(`${m} ${p} off the machine, no token set → ${off}`)
    }
    expect(open).toEqual([])
    expect(WRITES).toEqual([])
  })

  it("lets the owner save, lay out and delete a workflow (#1524)", async () => {
    const auth = { Authorization: "Bearer tok-wall" }
    // An empty body fails validation: the route answered, so the guard let it pass.
    expect(await post(withToken, "/api/workflows", auth)).toBe(400)
    expect(await post(withToken, "/api/workflows/deploy/layout", auth, "PUT")).not.toBe(401)
    expect(await post(withToken, "/api/workflows/deploy", auth, "DELETE")).toBe(200)
    // On this machine with no token set, the owner is whoever sits at it.
    expect(await post(noToken, "/api/workflows/deploy", {}, "DELETE")).toBe(200)
    expect(WRITES).toEqual(expect.arrayContaining(["delete deploy"]))
    // Checking a draft stays open to anyone who can read.
    expect(await post(withToken, "/api/workflows/deploy/validate", auth)).toBe(200)
  })
})
