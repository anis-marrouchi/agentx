import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { contextWithAdmissionPriority } from "../src/admission/queue"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting } from "../src/mcp/index"
import { A2AMesh } from "../src/a2a/mesh"
import { daemonConfigSchema } from "../src/daemon/config"

// #1807: the MCP and mesh paths that carry a send's priority: "critical"
// to the target's admission gate.

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

describe("agentx_send_agent priority", () => {
  const seen: Seen[] = []
  let server: Server
  beforeAll(async () => {
    server = capture(seen, () => ({ accepted: true, status: "queued", taskId: "snd-1", agent: "builder" }))
    process.env.AGENTX_DAEMON_URL = await listen(server)
    _resetDaemonUrlForTesting()
  })
  afterAll(() => {
    delete process.env.AGENTX_DAEMON_URL
    _resetDaemonUrlForTesting()
    server.close()
  })
  beforeEach(() => { seen.length = 0 })

  it("sends critical next to text", async () => {
    await _handleToolCallForTesting("agentx_send_agent", { agentId: "builder", text: "battery low", senderAgentId: "watch", priority: "critical" })
    expect(seen.find((s) => s.path === "/send/agent")!.body).toMatchObject({ agentId: "builder", priority: "critical" })
  })

  it("drops any other value", async () => {
    await _handleToolCallForTesting("agentx_send_agent", { agentId: "builder", text: "hi", senderAgentId: "watch", priority: "owner" })
    expect(seen.find((s) => s.path === "/send/agent")!.body).not.toHaveProperty("priority")
  })
})

describe("mesh.sendTask carries priority at the top level", () => {
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

  it("the peer's /task puts it in the run's context", async () => {
    await mesh.sendTask("p", "disk full", "beta", { senderAgentId: "guard", priority: "critical" }).catch(() => {})
    const post = seen.find((s) => s.path === "/task")!
    expect(post.body).toMatchObject({ agent: "beta", priority: "critical" })
    expect(contextWithAdmissionPriority(post.body)).toEqual({ admissionPriority: "critical" })
  })

  it("leaves it out when not given", async () => {
    await mesh.sendTask("p", "say hi", "beta", { senderAgentId: "guard" }).catch(() => {})
    expect(seen.find((s) => s.path === "/task")!.body).not.toHaveProperty("priority")
  })
})
