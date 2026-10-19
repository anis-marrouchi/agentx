import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { contextWithTaskType, taskTypeOf } from "../src/watchers/due"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting } from "../src/mcp/index"
import { A2AMesh } from "../src/a2a/mesh"
import { daemonConfigSchema } from "../src/daemon/config"

// #1057 review follow-up: the HTTP, MCP and mesh paths that carry a
// task's `taskType` (#1049) to the run's context.

type Seen = { path: string; body: Record<string, any> }

function capture(seen: Seen[], answer: (path: string) => unknown): Server {
  return createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(answer(req.url ?? "")))
    })
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("POST /task top-level taskType", () => {
  it("joins the context, also when there is none", () => {
    expect(contextWithTaskType({ message: "hi", taskType: "report" })).toEqual({ taskType: "report" })
    expect(contextWithTaskType({ taskType: " report ", context: { channel: "a2a" } })).toEqual({ channel: "a2a", taskType: "report" })
  })

  it("never overrides a type already in the context", () => {
    expect(contextWithTaskType({ taskType: "report", context: { taskType: "code" } })).toEqual({ taskType: "code" })
  })

  it("leaves a body without one as it is", () => {
    expect(contextWithTaskType({ message: "hi" })).toBeUndefined()
    const ctx = { channel: "mcp" }
    expect(contextWithTaskType({ context: ctx, taskType: "  " })).toBe(ctx)
  })

  it("reads /send/agent's top-level field the same way", () => {
    expect(taskTypeOf({ agentId: "b", text: "x", taskType: " code " })).toBe("code")
    expect(taskTypeOf({ agentId: "b", text: "x", taskType: 7 })).toBeUndefined()
    expect(taskTypeOf({ taskType: "x".repeat(80) })).toHaveLength(64)
  })
})

describe("MCP tools send taskType to the daemon", () => {
  const seen: Seen[] = []
  let server: Server
  beforeAll(async () => {
    server = capture(seen, (path) => path === "/send/agent"
      ? { accepted: true, status: "queued", taskId: "snd-1", agent: "builder" }
      : { result: "done" })
    process.env.AGENTX_DAEMON_URL = await listen(server)
    _resetDaemonUrlForTesting()
  })
  afterAll(() => {
    delete process.env.AGENTX_DAEMON_URL
    _resetDaemonUrlForTesting()
    server.close()
  })
  beforeEach(() => { seen.length = 0 })

  it("agentx_send_agent puts it next to text", async () => {
    await _handleToolCallForTesting("agentx_send_agent", { agentId: "builder", text: "write the report", senderAgentId: "front", taskType: " report " })
    const post = seen.find((s) => s.path === "/send/agent")!
    expect(post.body).toMatchObject({ agentId: "builder", text: "write the report", taskType: "report" })
  })

  it("agentx_send_agent leaves it out when not given", async () => {
    await _handleToolCallForTesting("agentx_send_agent", { agentId: "builder", text: "say hi", senderAgentId: "front" })
    expect(seen.find((s) => s.path === "/send/agent")!.body).not.toHaveProperty("taskType")
  })

  it("agentx_task puts it at the top level of /task", async () => {
    await _handleToolCallForTesting("agentx_task", { agent: "builder", message: "fix the bug", senderAgentId: "front", taskType: "code" })
    const post = seen.find((s) => s.path === "/task")!
    expect(post.body).toMatchObject({ agent: "builder", message: "fix the bug", taskType: "code" })
    // What the daemon's /task route then gives the run.
    expect(contextWithTaskType(post.body)).toMatchObject({ channel: "mcp", taskType: "code" })
  })
})

describe("mesh.sendTask carries taskType at the top level", () => {
  const seen: Seen[] = []
  let peer: Server
  let mesh: A2AMesh
  beforeAll(async () => {
    peer = capture(seen, () => ({ result: "ok" }))
    const url = await listen(peer)
    mesh = new A2AMesh(daemonConfigSchema.parse({ node: { id: "a", name: "a" }, mesh: { enabled: true, peers: [{ name: "p", url }] } }), () => {})
    const st = (mesh as any).peers.get("p")
    st.healthy = true
    st.agents = [{ id: "beta" }]
  })
  afterAll(() => { peer.close() })
  beforeEach(() => { seen.length = 0 })

  it("sends it without adding a context", async () => {
    await mesh.sendTask("p", "write the report", "beta", { senderAgentId: "front", taskType: "report" }).catch(() => {})
    const post = seen.find((s) => s.path === "/task")!
    expect(post.body).toMatchObject({ agent: "beta", message: "write the report", taskType: "report" })
    expect(post.body).not.toHaveProperty("context")
    expect(contextWithTaskType(post.body)).toEqual({ taskType: "report" })
  })

  it("leaves it out when not given", async () => {
    await mesh.sendTask("p", "say hi", "beta", { senderAgentId: "front" }).catch(() => {})
    expect(seen.find((s) => s.path === "/task")!.body).not.toHaveProperty("taskType")
  })
})
