import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { inboundTaskRaw, recordMeshDispatch } from "../src/intent/sources/mesh"
import { upstreamRequest } from "../src/daemon/app-chat-relay"
import { buildFleetSnapshot } from "../src/daemon/activity-graph-panel"
import { delegatorOf } from "../src/web/activity-graph/transit"
import { A2AMesh } from "../src/a2a/mesh"
import { daemonConfigSchema } from "../src/daemon/config"

// #276: a turn started on the phone app (typed or spoken, for an agent on
// this node or on a mesh peer) must reach the activity graph as a person on
// the phone, never as agent-to-agent traffic. Each case follows the real
// path: the relay's upstream body, the mesh hop for a peer, the ledger row
// the receiving daemon records, and the snapshot the Activity map reads.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-app-initiator-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** What the receiving daemon's /task records (see recordInboundDispatch). */
function receive(body: { agent: string; message: string; senderAgentId?: string; context?: Record<string, unknown> }) {
  recordMeshDispatch(
    ledger,
    { agentId: body.agent, senderAgentId: body.senderAgentId, context: body.context as any },
    inboundTaskRaw(body.agent, body.senderAgentId, body.context, body.message),
    { agentId: body.agent, outcome: "dispatched", reason: null },
  )
}

/** The body a mesh peer's /task gets when this daemon's /mesh/task relays
 *  it (index.ts passes body.context straight to sendTaskStream). */
async function throughPeer(body: Record<string, any>): Promise<any> {
  let got: any = null
  const peer = createServer(async (req, res) => {
    let raw = ""
    for await (const c of req) raw += c
    got = JSON.parse(raw)
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(`event: done\ndata: {"content":"ok"}\n\n`)
  })
  await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(peer.address() as any).port}`
  const mesh = new A2AMesh(daemonConfigSchema.parse({ node: { id: "a", name: "a" }, mesh: { enabled: true, peers: [{ name: body.peer, url }] } }), () => {})
  const st = (mesh as any).peers.get(body.peer)
  st.healthy = true
  st.agents = [{ id: body.agent }]
  for await (const _ of mesh.sendTaskStream(body.peer, body.message, body.agent, { context: body.context })) { /* drain */ }
  peer.close()
  return got
}

function onlyDispatch() {
  const snap = buildFleetSnapshot(ledger.db, null, 6)
  expect(snap.dispatches).toHaveLength(1)
  const d = snap.dispatches[0]
  return { d, initiator: snap.initiators.find((i) => i.id === d.initiatorId), channel: snap.channels.find((c) => c.id === d.channelId) }
}

describe("a phone turn has a person on the phone as its initiator (#276)", () => {
  const cases = [
    { node: "local", spoken: false, kind: "app" },
    { node: "local", spoken: true, kind: "voice" },
    { node: "peer-b", spoken: false, kind: "app" },
    { node: "peer-b", spoken: true, kind: "voice" },
  ] as const

  for (const c of cases) {
    it(`${c.spoken ? "spoken" : "typed"} turn for an agent on ${c.node === "local" ? "this node" : "a mesh peer"}`, async () => {
      const { path: route, body } = upstreamRequest({ node: c.node, agent: "alpha", message: "Hello", chatId: "app:c1", spoken: c.spoken })
      expect(route).toBe(c.node === "local" ? "/task" : "/mesh/task")
      const received = c.node === "local" ? body : await throughPeer(body)
      expect(received.senderAgentId).toBeUndefined()
      receive(received)

      const { d, initiator, channel } = onlyDispatch()
      expect(d.initiatorKind).toBe(c.kind)
      expect(d.initiatorKind).not.toBe("a2a")
      expect(d.channelId).toBe("app")
      expect(channel?.label).toBe("Phone app")
      expect(initiator).toMatchObject({ id: "operator", name: "operator" })
      expect(delegatorOf(d)).toBeNull()
    })
  }

  it("keeps the phone's session key: spoken and typed turns share channel and chat id", () => {
    const typed = upstreamRequest({ node: "local", agent: "alpha", message: "a", chatId: "app:c1" }).body.context as any
    const spoken = upstreamRequest({ node: "local", agent: "alpha", message: "b", chatId: "app:c1", spoken: true }).body.context as any
    expect([typed.channel, typed.chatId]).toEqual([spoken.channel, spoken.chatId])
  })
})

describe("agent-to-agent calls stay a2a", () => {
  it("an MCP agentx_task call from another agent", () => {
    receive({ agent: "alpha", message: "Check this", senderAgentId: "atlas", context: { channel: "mcp", sender: "agent:atlas", chatId: "mcp:atlas:alpha:x" } })
    const { d } = onlyDispatch()
    expect(d.initiatorKind).toBe("a2a")
    expect(delegatorOf(d)).toBe("atlas")
  })

  it("an agent delegating from inside a phone conversation", () => {
    receive({ agent: "alpha", message: "Draft it", senderAgentId: "atlas", context: { channel: "app", chatId: "app:c1", sender: "operator" } })
    const { d } = onlyDispatch()
    expect(d.initiatorKind).toBe("a2a")
    expect(delegatorOf(d)).toBe("atlas")
  })

  it("a legacy agent:<id> sender with no senderAgentId", () => {
    receive({ agent: "alpha", message: "Go", context: { channel: "a2a", sender: "agent:atlas", chatId: "a2a:atlas:alpha" } })
    expect(onlyDispatch().d.initiatorKind).toBe("a2a")
  })

  it("a bare mesh /task with no context", () => {
    receive({ agent: "alpha", message: "Go" })
    expect(onlyDispatch().d.initiatorKind).toBe("a2a")
  })
})
