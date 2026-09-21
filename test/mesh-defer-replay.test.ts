import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { A2AMesh } from "../src/a2a/mesh"
import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"

// A mesh peer flap used to be permanently destructive. When peer-server's
// probe of hq-local failed three times, `hasMeshAgent` stopped counting
// devops-agent as known, the routing pipeline recorded
// `kind=drop unknown_agent:devops-agent`, and five @-mentions on
// acme/soylent#132 were discarded. The peer recovered 24 minutes later and
// nothing replayed them — the reporter just saw the agent ignore him.
//
// These tests pin the two halves of the fix: a down peer's agents stay
// *known*, and messages that arrive while it is down are held and replayed.

const AGENT = "devops-agent"
const PEER = "hq-local"

function meshConfig(): any {
  return {
    mesh: {
      peers: [{ name: PEER, url: "http://100.64.0.1:18800" }],
      healthCheck: { timeout: 5, interval: 60 },
    },
  }
}

describe("A2AMesh.findAgentPeer — down is not unknown", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("still resolves an agent on a peer that has gone unreachable", async () => {
    const mesh = new A2AMesh(meshConfig(), () => {})

    // One good probe teaches the mesh what the peer hosts.
    const state = (mesh as any).peers.get(PEER)
    state.client.getAgentCard = vi.fn(async () => ({
      name: "HQ-Local",
      skills: [{ id: AGENT, name: "DevOps" }],
    }))
    await mesh.discoverAll()

    expect(mesh.findAgentPeer(AGENT)).toEqual({ peer: PEER, healthy: true })

    // Now the link drops. Hysteresis needs three consecutive failures.
    state.client.getAgentCard = vi.fn(async () => { throw new Error("fetch failed") })
    await mesh.discoverAll()
    await mesh.discoverAll()
    await mesh.discoverAll()

    expect(state.healthy).toBe(false)
    // The agent is still known — its node is merely down.
    expect(mesh.findAgentPeer(AGENT)).toEqual({ peer: PEER, healthy: false })
  })

  it("does not resolve agents on a peer that was never reachable", async () => {
    const mesh = new A2AMesh(meshConfig(), () => {})
    const state = (mesh as any).peers.get(PEER)
    state.client.getAgentCard = vi.fn(async () => { throw new Error("fetch failed") })
    await mesh.discoverAll()

    expect(mesh.findAgentPeer(AGENT)).toBeUndefined()
  })

  it("fans peer-change events out to every listener", async () => {
    const mesh = new A2AMesh(meshConfig(), () => {})
    const seenA: string[] = []
    const seenB: string[] = []
    mesh.onPeerChange((e) => { seenA.push(e.delta) })
    mesh.onPeerChange((e) => { seenB.push(e.delta) })

    const state = (mesh as any).peers.get(PEER)
    state.client.getAgentCard = vi.fn(async () => ({ name: "HQ-Local", skills: [] }))
    await mesh.discoverAll()

    // The daemon's EventBus bridge used to displace the router's listener.
    expect(seenA).toEqual(["recovered"])
    expect(seenB).toEqual(["recovered"])
  })
})

describe("MessageRouter — deferred mesh delivery", () => {
  let router: MessageRouter
  let sent: string[]
  let sendTask: ReturnType<typeof vi.fn>
  let peerHealthy: boolean
  let recovered: (() => void) | undefined

  const adapter: any = {
    name: "gitlab",
    send: vi.fn(async () => "note-1"),
    react: vi.fn(),
    sendTyping: vi.fn(),
  }

  function makeMsg(id: string): IncomingMessage {
    return {
      id,
      channel: "gitlab",
      accountId: "default",
      sender: { id: "u1", name: "Alex Rivera", isBot: false },
      text: `@devops-acme are you still here ?`,
      group: { id: "acme/soylent:issue:132", name: "soylent" },
      preferNode: PEER,
    } as any
  }

  beforeEach(() => {
    sent = []
    peerHealthy = false
    sendTask = vi.fn(async (_peer: string, text: string) => {
      sent.push(text)
      return "on it"
    })
    router = new MessageRouter({ getAgent: () => undefined } as any, { channels: {} } as any)
    const fakeMesh: any = {
      directory: () => [{ peer: PEER, peerUrl: "u", healthy: peerHealthy, skills: [{ id: AGENT }], channels: [] }],
      findAgentPeer: (id: string) => (id === AGENT ? { peer: PEER, healthy: peerHealthy } : undefined),
      sendTask,
      onPeerChange: (cb: any) => { recovered = () => cb({ peer: PEER, healthy: true, skills: [AGENT], delta: "recovered" }) },
    }
    router.setMesh(fakeMesh)
  })

  it("holds a message while the peer is down, then replays it on recovery", async () => {
    const r = router as any
    await r.processResolvedMessage(adapter, makeMsg("108367"), AGENT, "acme/soylent:issue:132")

    // Nothing reached the peer, but nothing was thrown away either.
    expect(sendTask).not.toHaveBeenCalled()
    expect(router.getDeferredMeshCounts()).toEqual({ [PEER]: 1 })

    peerHealthy = true
    recovered!()
    await vi.waitFor(() => expect(sendTask).toHaveBeenCalledTimes(1))

    expect(sent[0]).toContain("are you still here")
    expect(router.getDeferredMeshCounts()).toEqual({})
  })

  it("does not hold the same message twice when the webhook is redelivered", async () => {
    const r = router as any
    await r.processResolvedMessage(adapter, makeMsg("108367"), AGENT, "acme/soylent:issue:132")
    await r.processResolvedMessage(adapter, makeMsg("108367"), AGENT, "acme/soylent:issue:132")

    expect(router.getDeferredMeshCounts()).toEqual({ [PEER]: 1 })
  })

  it("discards held messages older than the TTL instead of answering them late", async () => {
    const r = router as any
    await r.processResolvedMessage(adapter, makeMsg("108367"), AGENT, "acme/soylent:issue:132")

    // Age the entry past the 30-minute TTL.
    r.deferredByPeer.get(PEER)[0].deferredAt = Date.now() - 31 * 60 * 1000

    peerHealthy = true
    await r.replayDeferred(PEER)

    expect(sendTask).not.toHaveBeenCalled()
    expect(router.getDeferredMeshCounts()).toEqual({})
  })

  it("caps the queue so a peer that never returns cannot grow it without limit", async () => {
    const r = router as any
    for (let i = 0; i < 60; i++) {
      await r.processResolvedMessage(adapter, makeMsg(`n-${i}`), AGENT, "acme/soylent:issue:132")
    }
    expect(router.getDeferredMeshCounts()[PEER]).toBe(50)
  })
})
