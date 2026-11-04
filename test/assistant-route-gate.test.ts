import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import Database from "better-sqlite3"
import { AgentXDaemon } from "../src/daemon"
import { AssistantStore } from "../src/daemon/assistant-store"
import { handleBoardRequest } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"

// The real daemon handler and the real dashboard proxy, over real sockets.
// Tests connect over loopback, so the socket address is forced to stand in for
// a caller on another machine.

const MESH = "mesh-token"
const PEER = "peer-token"
const OWNER = "dashboard-owner-token"
const OFF_BOX = "100.64.0.9"
const LOCAL = "127.0.0.1"
const FOREIGN = { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site" }

const servers: Server[] = []
const home = process.cwd()
let tmp: string
let workspace: string
let db: Database.Database
let executed: string[]
let peerAddress = LOCAL

function buildDaemon(meshConfig: object | undefined) {
  const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, ...(meshConfig ? { mesh: meshConfig } : {}) })
  return Object.assign(Object.create(AgentXDaemon.prototype), {
    config,
    log: () => {},
    _assistant: new AssistantStore(db),
    registry: {
      list: () => [{ id: "helper" }],
      getAgent: (id: string) => (id === "helper" ? { workspace } : undefined),
      execute: async (a: { message: string }) => {
        executed.push(a.message)
        return { content: "answer" }
      },
    },
  })
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A daemon whose callers appear to come from `address()`. */
function serveDaemon(daemon: { handleHttp: Function }, address: () => string): Promise<string> {
  return listen((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: address(), configurable: true })
    void daemon.handleHttp(req, res)
  })
}

const MESH_CONFIG = { peers: [{ name: "peer", url: "http://peer.invalid", token: PEER }] }

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/assistant/threads"],
  ["GET", "/api/assistant/thread?id=nope"],
  ["POST", "/api/assistant/delete"],
  ["POST", "/api/assistant"],
]

const call = (base: string, method: string, path: string, headers: Record<string, string> = {}, body?: object) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  })

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agentx-assistant-gate-"))
  process.chdir(tmp)
  workspace = join(tmp, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, ".env"), "NOT_A_REAL_VALUE=1\n")
  writeFileSync(join(workspace, "chart.png"), "png")
})

beforeEach(() => {
  db = new Database(":memory:")
  executed = []
  vi.stubEnv("MESH_TOKEN", MESH)
  vi.stubEnv("AGENTX_CHAT_SECRET", "")
  vi.stubEnv("TELEGRAM_BOT_API_SECRET", "")
  vi.stubEnv("AGENTX_ALLOWED_ORIGINS", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  db.close()
})

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections?.()
    await new Promise<void>((r) => s.close(() => r()))
  }
  process.chdir(home)
  rmSync(tmp, { recursive: true, force: true })
})

describe("daemon /api/assistant gate", () => {
  it.each(ROUTES)("%s %s answers 401 off the box with no credential or a wrong one", async (method, path) => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    expect((await call(base, method, path)).status).toBe(401)
    expect((await call(base, method, path, { Authorization: "Bearer wrong" })).status).toBe(401)
    expect((await call(base, method, path, { Authorization: `Bearer ${OWNER}` })).status).toBe(401)
  })

  it("runs no turn and writes no thread for a refused post", async () => {
    const daemon = buildDaemon(MESH_CONFIG)
    const base = await serveDaemon(daemon, () => OFF_BOX)
    const res = await call(base, "POST", "/api/assistant", {}, { agentId: "helper", message: "hello" })
    expect(res.status).toBe(401)
    expect(executed).toEqual([])
    expect(daemon._assistant.listThreads()).toEqual([])
  })

  it.each([MESH, PEER])("lets an accepted token through off the box", async (token) => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    const auth = { Authorization: `Bearer ${token}` }
    expect((await call(base, "GET", "/api/assistant/threads", auth)).status).toBe(200)
    expect((await call(base, "GET", "/api/assistant/thread?id=nope", auth)).status).toBe(404)
    expect((await call(base, "POST", "/api/assistant/delete", auth, { threadId: "nope" })).status).toBe(200)
    const posted = await call(base, "POST", "/api/assistant", auth, { agentId: "helper", message: "hello" })
    expect(posted.status).toBe(200)
    await vi.waitFor(() => expect(executed).toHaveLength(1))
  })

  it.each(ROUTES)("%s %s passes on loopback", async (method, path) => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => LOCAL)
    expect((await call(base, method, path)).status).not.toBe(401)
  })

  it.each(ROUTES)("%s %s refuses a page on another origin, loopback or not", async (method, path) => {
    for (const address of [LOCAL, OFF_BOX]) {
      const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => address)
      expect((await call(base, method, path, FOREIGN)).status).toBe(403)
    }
    expect(executed).toEqual([])
  })
})

describe("dashboard proxy to a gated daemon", () => {
  const owner = { Authorization: `Bearer ${OWNER}`, "X-Requested-With": "agentx-board" }

  function serveBoard(dashboard: object): Promise<string> {
    const config = daemonConfigSchema.parse({
      node: { id: "board", name: "board" },
      dashboard: { token: OWNER, ...dashboard },
    })
    return listen((req, res) => {
      void handleBoardRequest(req, res, { boards: [], sources: new Map(), token: OWNER, config } as never)
    })
  }

  it("keeps the drawer and Wall chat calls working on the same host", async () => {
    const daemonUrl = await serveDaemon(buildDaemon(MESH_CONFIG), () => LOCAL)
    const board = await serveBoard({ daemonUrl })

    const posted = await call(board, "POST", "/api/assistant", owner, { agentId: "helper", message: "hello" })
    expect(posted.status).toBe(200)
    const { threadId, seq } = await posted.json()
    expect(threadId).toBeTruthy()
    expect(seq).toBeDefined()
    await vi.waitFor(() => expect(executed).toHaveLength(1))

    expect((await call(board, "GET", "/api/assistant/threads", owner)).status).toBe(200)
    expect((await call(board, "GET", `/api/assistant/thread?id=${threadId}`, owner)).status).toBe(200)
    expect((await call(board, "POST", "/api/assistant/delete", owner, { threadId })).status).toBe(200)
  })

  it("still reaches a peer selected by node, with a token the peer accepts", async () => {
    peerAddress = OFF_BOX
    const peerUrl = await serveDaemon(buildDaemon(MESH_CONFIG), () => peerAddress)
    const board = await serveBoard({ daemonUrl: "http://127.0.0.1:1", daemons: [{ name: "peer", url: peerUrl, token: PEER }] })

    const posted = await call(board, "POST", "/api/assistant", owner, { agentId: "helper", message: "hello", node: peerUrl })
    expect(posted.status).toBe(200)
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    expect((await call(board, "GET", `/api/assistant/threads?node=${encodeURIComponent(peerUrl)}`, owner)).status).toBe(200)
  })

  it("reports the peer's refusal as the machine's, not as the owner signed out", async () => {
    const peerUrl = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    const board = await serveBoard({ daemonUrl: "http://127.0.0.1:1", daemons: [{ name: "peer", url: peerUrl, token: "not-accepted" }] })
    const res = await call(board, "POST", "/api/assistant", owner, { agentId: "helper", message: "hello", node: peerUrl })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("refused this dashboard's token")
    expect(executed).toEqual([])
  })

  it("no longer reaches a primary on another host with only dashboard.token", async () => {
    const daemonUrl = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    const board = await serveBoard({ daemonUrl })
    const res = await call(board, "GET", "/api/assistant/threads", owner)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("refused this dashboard's token")
  })

  it("still answers 401 to a viewer who is not the owner", async () => {
    const daemonUrl = await serveDaemon(buildDaemon(MESH_CONFIG), () => LOCAL)
    const board = await serveBoard({ daemonUrl })
    expect((await call(board, "GET", "/api/assistant/threads")).status).toBe(401)
  })
})

describe("daemon /agents/:id/workspace/* gate", () => {
  const read = (base: string, file: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/agents/helper/workspace/${file}`, { headers })

  it.each([".env", "chart.png"])("refuses %s off the box with no credential", async (file) => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    const res = await read(base, file)
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain("NOT_A_REAL_VALUE")
  })

  it("refuses off the box on a node with no secret and no mesh token at all", async () => {
    vi.stubEnv("MESH_TOKEN", "")
    const base = await serveDaemon(buildDaemon(undefined), () => OFF_BOX)
    expect((await read(base, ".env")).status).toBe(401)
  })

  it("is not opened by the mesh auth off switch", async () => {
    vi.stubEnv("AGENTX_MESH_AUTH", "off")
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    expect((await read(base, ".env")).status).toBe(401)
  })

  it("serves off the box with an accepted mesh token", async () => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    expect((await read(base, "chart.png", { Authorization: `Bearer ${MESH}` })).status).toBe(200)
  })

  it("serves off the box with the chat secret, and refuses a wrong one", async () => {
    vi.stubEnv("AGENTX_CHAT_SECRET", "chat-secret")
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => OFF_BOX)
    expect((await read(base, "chart.png", { Authorization: "Bearer chat-secret" })).status).toBe(200)
    expect((await read(base, "chart.png", { Authorization: "Bearer wrong" })).status).toBe(401)
  })

  it("passes on loopback only where no chat secret is set", async () => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => LOCAL)
    expect((await read(base, "chart.png")).status).toBe(200)
    vi.stubEnv("AGENTX_CHAT_SECRET", "chat-secret")
    expect((await read(base, "chart.png")).status).toBe(401)
    expect((await read(base, "chart.png", { Authorization: "Bearer chat-secret" })).status).toBe(200)
  })

  it("refuses a page on another origin, even on loopback or with a mesh token", async () => {
    const base = await serveDaemon(buildDaemon(MESH_CONFIG), () => LOCAL)
    expect((await read(base, ".env", FOREIGN)).status).toBe(401)
    expect((await read(base, ".env", { ...FOREIGN, Authorization: `Bearer ${MESH}` })).status).toBe(401)
  })
})
