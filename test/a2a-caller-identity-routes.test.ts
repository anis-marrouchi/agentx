import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { AgentXDaemon } from "../src/daemon"
import { daemonConfigSchema } from "../src/daemon/config"
import Database from "better-sqlite3"
import { DelegationManager } from "../src/a2a/delegation"
import { HandoffStore } from "../src/a2a/handoff-store"
import { SyncWaits } from "../src/daemon/delegation-wiring"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting } from "../src/mcp/index"

// #2007 piece 2: the caller-identity rule through the real route handlers
// (handleHttp over a real socket), with the registry and mesh stubbed.
// An agent's stream on /task gets a receipt; a phone-relay-shaped stream
// on /mesh/task stays a stream; a peer-shaped /task (parentEventId) naming
// a local agent stays synchronous.

const servers: Server[] = []
const home = process.cwd()
let tmp: string
const executed: string[] = []
const localRuns: Array<{ agent: string; context: Record<string, unknown> }> = []
let db: Database.Database

function buildDaemon() {
  const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
  const agents: Record<string, { id: string }> = { helper: { id: "helper" }, builder: { id: "builder" } }
  const delegations = new DelegationManager({
    timeoutMs: 60_000,
    runLocal: (agent, _m, context) => { localRuns.push({ agent, context }); return new Promise(() => {}) },
    runPeer: () => new Promise(() => {}),
    injectTurn: async () => ({ content: "" }),
    isChatBusy: () => false,
    canDeliver: () => false,
    deliver: async () => {},
    log: () => {},
    store: new HandoffStore(db),
  })
  return Object.assign(Object.create(AgentXDaemon.prototype), {
    config,
    log: () => {},
    delegations,
    syncWaits: new SyncWaits(),
    sendAgentDedupe: { get: () => null, put: () => {} },
    registry: {
      list: () => Object.values(agents),
      getAgent: (id: string) => agents[id],
      findRunningTurn: () => null,
      runningTaskOwner: () => null,
      refusalFor: () => null,
      slotHolders: () => ({ full: false, runIds: [] }),
      cancelChatTasks: () => {},
      execute: async (a: { message: string }) => {
        executed.push(a.message)
        return { content: "answer" }
      },
    },
    mesh: {
      directory: () => [],
      findAgentPeer: () => undefined,
      async *sendTaskStream() {
        yield { event: "text", data: { text: "streamed" } }
        yield { event: "done", data: {} }
      },
      sendTask: async () => "peer answer",
    },
  })
}

async function serve(daemon: { handleHttp: Function }): Promise<string> {
  const server = createServer((req, res) => { void daemon.handleHttp(req, res) })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (base: string, path: string, body: object, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })

let base: string

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "agentx-identity-routes-"))
  process.chdir(tmp)
  vi.stubEnv("MESH_TOKEN", "")
  db = new Database(":memory:")
  base = await serve(buildDaemon())
})

afterAll(async () => {
  vi.unstubAllEnvs()
  for (const s of servers) {
    s.closeAllConnections?.()
    await new Promise<void>((r) => s.close(() => r()))
  }
  db.close()
  process.chdir(home)
  rmSync(tmp, { recursive: true, force: true })
})

describe("the caller-identity rule through the real handlers", () => {
  it("gives an agent's stream on /task a 202 receipt, flagged streamIgnored", async () => {
    const r = await post(base, "/task", { agent: "helper", message: "status?", senderAgentId: "builder", stream: true })
    expect(r.status).toBe(202)
    const body = await r.json() as Record<string, unknown>
    expect(body).toMatchObject({ accepted: true, mode: "none", streamIgnored: true })
    expect(String(body.taskId)).toMatch(/^dlg-/)
  })

  it("keeps a phone-relay-shaped stream on /mesh/task a stream", async () => {
    const r = await post(base, "/mesh/task", { peer: "vps", agent: "helper", message: "hi", stream: true, context: { channel: "app", chatId: "app:c1" } })
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("text/event-stream")
    expect(await r.text()).toContain("streamed")
  })

  it("keeps a peer-shaped /task (parentEventId) naming a local agent synchronous (C1)", async () => {
    const r = await post(base, "/task", { agent: "helper", message: "from a peer", senderAgentId: "builder", parentEventId: "evt-1" })
    expect(r.status).toBe(200)
    expect(executed).toContain("from a peer")
  })
})

describe("reading a none hand-off the way its receipt says (review items 1, 2)", () => {
  it("reads it with GET /lookup?handoff=<id>&as=<caller>, and not as another agent", async () => {
    const r = await post(base, "/send/agent", { agentId: "helper", senderAgentId: "builder", text: "check the build" })
    expect(r.status).toBe(202)
    const { taskId } = await r.json() as { taskId: string }
    const ok = await fetch(`${base}/lookup?handoff=${taskId}&as=builder`)
    expect(ok.status).toBe(200)
    const body = await ok.json() as { text: string }
    expect(body.text).toContain(taskId)
    expect(body.text).toContain("running")
    expect((await fetch(`${base}/lookup?handoff=${taskId}&as=helper-x`)).status).toBe(404)
  })

  it("reads it with agentx_lookup as the agent the tool runs for", async () => {
    const r = await post(base, "/send/agent", { agentId: "helper", senderAgentId: "builder", text: "check the deploy" })
    const { taskId } = await r.json() as { taskId: string }
    vi.stubEnv("AGENTX_DAEMON_URL", base)
    vi.stubEnv("AGENTX_AGENT_ID", "builder")
    _resetDaemonUrlForTesting()
    try {
      const out = await _handleToolCallForTesting("agentx_lookup", { handoff: taskId })
      expect(out.content[0].text).toContain(taskId)
    } finally {
      vi.unstubAllEnvs()
      vi.stubEnv("MESH_TOKEN", "")
      _resetDaemonUrlForTesting()
    }
  })

  it("gives a named sender that is no local agent its label as the sender line", async () => {
    const before = localRuns.length
    const r = await post(base, "/send/agent", { agentId: "helper", senderAgentId: "watch-script", text: "battery low" })
    expect(r.status).toBe(202)
    expect(localRuns[before].context.sender).toBe("agent:watch-script")
  })
})
