import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import Database from "better-sqlite3"
import { AgentXDaemon } from "../src/daemon"
import { AssistantStore } from "../src/daemon/assistant-store"
import { handleBoardRequest } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { acceptAttachments, attachedLine, safeUploadName } from "../src/daemon/assistant-upload"
import { answerSteps, assistantRuns } from "../src/daemon/assistant-runs"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { openDb, closeDb } from "../src/storage/sqlite"

// #2101 PR 2: the Hub chat's new routes, through the real daemon handler and
// the real dashboard proxy over sockets: files (POST /api/assistant/upload),
// one agent's conversations (GET /api/assistant/threads?agent=), voice
// (/api/assistant/voice/*), and who may call them (C4).

const MESH = "mesh-token"
const OWNER = "dashboard-owner-token"
const OFF_BOX = "100.64.0.9"
const LOCAL = "127.0.0.1"

const servers: Server[] = []
const home = process.cwd()
let tmp: string
let workspace: string
let db: Database.Database
let executed: string[]

function buildDaemon() {
  const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, mesh: { peers: [{ name: "peer", url: "http://peer.invalid", token: "peer-token" }] } })
  return Object.assign(Object.create(AgentXDaemon.prototype), {
    config,
    log: () => {},
    _assistant: new AssistantStore(db),
    registry: {
      list: () => [{ id: "helper", workspace }, { id: "other", workspace: join(tmp, "other") }],
      getAgent: (id: string) => (id === "helper" ? { workspace } : id === "other" ? { workspace: join(tmp, "other") } : undefined),
      execute: async (a: { message: string }) => { executed.push(a.message); return { content: "answer" } },
    },
  })
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function serveDaemon(daemon: { handleHttp: Function }, address: string): Promise<string> {
  return listen((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: address, configurable: true })
    void daemon.handleHttp(req, res)
  })
}
function serveBoard(daemonUrl: string): Promise<string> {
  const config = daemonConfigSchema.parse({ node: { id: "board", name: "board" }, dashboard: { token: OWNER, daemonUrl } })
  return listen((req, res) => { void handleBoardRequest(req, res, { boards: [], sources: new Map(), token: OWNER, config } as never) })
}
const owner = { Authorization: `Bearer ${OWNER}`, "X-Requested-With": "agentx-board" }
const up = (base: string, qs: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/assistant/upload?${qs}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", ...headers }, body })

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agentx-hub-chat-"))
  process.chdir(tmp)
  workspace = join(tmp, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, ".env"), "NOT_A_REAL_VALUE=1\n")
})
beforeEach(() => {
  db = new Database(":memory:")
  executed = []
  vi.stubEnv("MESH_TOKEN", MESH)
  vi.stubEnv("AGENTX_CHAT_SECRET", "")
  vi.stubEnv("TELEGRAM_BOT_API_SECRET", "")
  vi.stubEnv("AGENTX_ALLOWED_ORIGINS", "")
})
afterEach(() => { vi.unstubAllEnvs(); db.close() })
afterAll(async () => {
  for (const s of servers) { s.closeAllConnections?.(); await new Promise<void>((r) => s.close(() => r())) }
  process.chdir(home)
  rmSync(tmp, { recursive: true, force: true })
})

describe("POST /api/assistant/upload (#2101 R14)", () => {
  it("keeps the owner's file in the agent's uploads folder, out of git, under a plain name", async () => {
    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    const res = await up(board, "agent=helper&name=" + encodeURIComponent("../../etc/notes.txt"), "hello file", owner)
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.name).toBe("notes.txt")
    expect(d.size).toBe(10)
    expect(d.path.startsWith(join(workspace, "uploads") + "/")).toBe(true)
    expect(d.path.endsWith("-notes.txt")).toBe(true)
    expect(readFileSync(d.path, "utf8")).toBe("hello file")
    expect(readFileSync(join(workspace, "uploads", ".gitignore"), "utf8")).toBe("*\n")
  })

  it("refuses an uploads directory linked outside its workspace", async () => {
    const other = join(tmp, "other")
    const target = join(tmp, "upload-target")
    mkdirSync(other)
    mkdirSync(target)
    writeFileSync(join(target, "report.txt"), "demo")
    symlinkSync(target, join(other, "uploads"), "dir")

    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    expect((await up(board, "agent=other&name=new.txt", "demo", owner)).status).toBe(409)
    expect(acceptAttachments(other, [{ name: "report.txt", path: join(other, "uploads", "report.txt") }])).toEqual([])
    expect(existsSync(join(target, ".gitignore"))).toBe(false)
  })

  it("sends an uploaded file with the next message: its path in the prompt, its name in the thread", async () => {
    const daemon = buildDaemon()
    const board = await serveBoard(await serveDaemon(daemon, LOCAL))
    const file = await (await up(board, "agent=helper&name=chart.png", "png", owner)).json()
    const res = await fetch(`${board}/api/assistant`, {
      method: "POST", headers: { ...owner, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "helper", message: "What is in it?", attachments: [file, { name: "secrets", path: join(workspace, ".env") }] }),
    })
    expect(res.status).toBe(200)
    const { threadId } = await res.json()
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    expect(executed[0]).toContain(`- chart.png: ${file.path}`)
    expect(executed[0]).not.toContain(".env")
    const msgs = daemon._assistant.messages(threadId)
    expect(msgs[0].content).toBe("What is in it?\n\nAttached: chart.png")
    // The title stays the question.
    expect(daemon._assistant.thread(threadId).title).toBe("What is in it?")
  })

  it("asks a spoken question for a short answer", async () => {
    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    await fetch(`${board}/api/assistant`, { method: "POST", headers: { ...owner, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "helper", message: "Status?", spoken: true }) })
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    expect(executed[0]).toContain("They said this aloud")
  })

  it("refuses an unknown agent, a missing name, an empty file and a GET", async () => {
    const daemon = await serveDaemon(buildDaemon(), LOCAL)
    expect((await up(daemon, "agent=nobody&name=a.txt", "x")).status).toBe(404)
    expect((await up(daemon, "agent=helper&name=", "x")).status).toBe(400)
    expect((await up(daemon, "name=a.txt", "x")).status).toBe(400)
    expect((await up(daemon, "agent=helper&name=a.txt", "")).status).toBe(400)
    expect((await fetch(`${daemon}/api/assistant/upload?agent=helper&name=a.txt`)).status).toBe(405)
  })

  it("is the owner's alone on the dashboard, and mesh-gated on the daemon (C4)", async () => {
    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    expect((await up(board, "agent=helper&name=a.txt", "x")).status).toBe(401)
    expect((await up(board, "agent=helper&name=a.txt", "x", { Authorization: "Bearer wrong" })).status).toBe(401)
    expect(isMeshGatedPath("/api/assistant/upload")).toBe(true)
    const offBox = await serveDaemon(buildDaemon(), OFF_BOX)
    expect((await up(offBox, "agent=helper&name=a.txt", "x")).status).toBe(401)
    expect((await up(offBox, "agent=helper&name=a.txt", "x", { Authorization: `Bearer ${MESH}` })).status).toBe(200)
    expect(existsSync(join(workspace, "uploads"))).toBe(true)
  })
})

describe("attachments: only files uploaded for that agent", () => {
  it("drops paths outside uploads/, links out of it, and more than five", () => {
    const dir = join(workspace, "uploads")
    mkdirSync(dir, { recursive: true })
    const files = Array.from({ length: 7 }, (_, i) => { const p = join(dir, `f${i}.txt`); writeFileSync(p, "x"); return { name: `f${i}.txt`, path: p } })
    symlinkSync(join(workspace, ".env"), join(dir, "link.txt"))
    expect(acceptAttachments(workspace, files)).toHaveLength(5)
    expect(acceptAttachments(workspace, [{ name: "e", path: join(workspace, ".env") }])).toEqual([])
    expect(acceptAttachments(workspace, [{ name: "e", path: join(dir, "..", ".env") }])).toEqual([])
    expect(acceptAttachments(workspace, [{ name: "l", path: join(dir, "link.txt") }])).toEqual([])
    expect(acceptAttachments(workspace, [{ name: "r", path: "uploads/f0.txt" }])).toEqual([])
    expect(acceptAttachments(null, files)).toEqual([])
    expect(acceptAttachments(workspace, "nope")).toEqual([])
  })

  it("names files plainly", () => {
    expect(safeUploadName("../../.ssh/id_rsa")).toBe("id_rsa")
    expect(safeUploadName("C:\\Users\\me\\report final.pdf")).toBe("report-final.pdf")
    expect(safeUploadName(".hidden")).toBe("hidden")
    expect(safeUploadName("")).toBe("")
    expect(attachedLine([{ name: "a.png" }, { name: "b.pdf" }])).toBe("Attached: a.png, b.pdf")
  })
})

describe("GET /api/assistant/threads?agent= (#2101 R12)", () => {
  it("lists one agent's conversations, newest first, through the dashboard", async () => {
    const daemon = buildDaemon()
    const s: AssistantStore = daemon._assistant
    const a = s.createThread("helper", null, "first")
    s.createThread("other", null, "elsewhere")
    const b = s.createThread("helper", null, "second")
    db.prepare("UPDATE assistant_threads SET updated_at = ? WHERE id = ?").run(1, a.id)
    const board = await serveBoard(await serveDaemon(daemon, LOCAL))
    const res = await fetch(`${board}/api/assistant/threads?agent=helper`, { headers: owner })
    expect(res.status).toBe(200)
    expect((await res.json()).threads.map((t: any) => t.id)).toEqual([b.id, a.id])
    const all = await (await fetch(`${board}/api/assistant/threads`, { headers: owner })).json()
    expect(all.threads).toHaveLength(3)
    expect((await fetch(`${board}/api/assistant/threads?agent=helper`)).status).toBe(401)
  })

  it("reads them through the (agent_id, updated_at) index", () => {
    new AssistantStore(db)
    const idx = db.prepare("PRAGMA index_list(assistant_threads)").all() as Array<{ name: string }>
    expect(idx.map((i) => i.name)).toContain("assistant_threads_agent_recent")
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM assistant_threads WHERE agent_id = ? ORDER BY updated_at DESC").all("x") as Array<{ detail: string }>
    expect(plan.map((p) => p.detail).join(" ")).toContain("assistant_threads_agent_recent")
  })
})

describe("the Hub chat's voice routes (#2101 R14)", () => {
  it("are the owner's alone and POST only", async () => {
    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    for (const p of ["/api/assistant/voice/transcribe", "/api/assistant/voice/speak"]) {
      expect((await fetch(board + p, { method: "POST", body: "x" })).status).toBe(401)
      expect((await fetch(board + p, { headers: owner })).status).toBe(405)
    }
  })

  it("refuses a recording that is not audio before it reaches the daemon", async () => {
    const board = await serveBoard(await serveDaemon(buildDaemon(), LOCAL))
    const res = await fetch(`${board}/api/assistant/voice/transcribe`, { method: "POST", headers: { ...owner, "Content-Type": "text/plain" }, body: "x" })
    expect(res.status).toBe(415)
  })

  it("says only an answer the conversation holds", async () => {
    const daemon = buildDaemon()
    const s: AssistantStore = daemon._assistant
    const t = s.createThread("helper", null, "q")
    const seq = s.appendTurn(t.id, "q")
    s.resolve(t.id, seq, "The real answer.", "done")
    const board = await serveBoard(await serveDaemon(daemon, LOCAL))
    const say = (text: string, threadId = t.id) => fetch(`${board}/api/assistant/voice/speak`, {
      method: "POST", headers: { ...owner, "Content-Type": "application/json" }, body: JSON.stringify({ threadId, text }),
    })
    expect((await say("Something it never said")).status).toBe(404)
    expect((await say("The real answer.", "nope")).status).toBe(404)
    expect((await say("")).status).toBe(400)
  })
})

describe("the steps behind an answer (C1: read through getRunShape)", () => {
  let dir: string
  beforeEach(() => { closeDb(); dir = mkdtempSync(join(tmpdir(), "agentx-hub-runs-")) })
  afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })

  it("returns each answered run's time and tool steps with the start of their input", () => {
    const tdb = openDb({ path: join(dir, "db.sqlite") })!
    tdb.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at, duration_ms)
                 VALUES ('t1', 'helper', 'dashboard', 'assistant', 'ok', 1, 72001, 72000)`).run()
    const step = tdb.prepare(`INSERT INTO task_trace_steps (task_id, seq, name, action, status, input_summary, ms, started_at) VALUES (?,?,?,?,?,?,?,?)`)
    step.run("t1", 0, "tool_use", "Read", "in-flight", '{"file_path":"/a.ts"}', 5, 1)
    step.run("t1", 1, "tool_result", null, "ok", null, 5, 2)
    step.run("t1", 2, "tool_use", "Bash", "in-flight", "x".repeat(900), 5, 3)
    step.run("t1", 3, "tool_result", null, "error", null, 5, 4)
    const runs = assistantRuns(tdb, [
      { role: "user", taskId: null }, { role: "assistant", taskId: "t1" }, { role: "assistant", taskId: "missing" },
    ])
    expect(Object.keys(runs)).toEqual(["t1"])
    expect(runs.t1.ms).toBe(72000)
    expect(runs.t1.steps).toEqual([
      { tool: "Read", input: '{"file_path":"/a.ts"}', error: false },
      { tool: "Bash", input: "x".repeat(300), error: true },
    ])
    expect(assistantRuns(null, [{ role: "assistant", taskId: "t1" }])).toEqual({})
  })

  it("marks the call before a failed result", () => {
    expect(answerSteps([
      { name: "tool_use", action: "Grep", status: "in-flight", input: "p" },
      { name: "tool_result", action: null, status: "error" },
      { name: "text", action: null, status: null },
    ])).toEqual([{ tool: "Grep", input: "p", error: true }])
  })
})
