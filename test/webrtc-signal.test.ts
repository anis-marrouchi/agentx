import { describe, it, expect, vi } from "vitest"
import type { ServerResponse } from "http"
import { WebRtcSignalBroker, type WebRtcSignal } from "../src/channels/webrtc-signal"

// Minimal SSE-like ServerResponse stub — collects writes into a buffer so we
// can assert what was fanned out.
function fakeRes() {
  const chunks: string[] = []
  return {
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: () => {},
    chunks,
  } as unknown as ServerResponse & { chunks: string[] }
}

function signal(partial: Partial<WebRtcSignal>): WebRtcSignal {
  return {
    kind: "offer",
    callId: "c1",
    from: "alice",
    to: "bob",
    sdp: "v=0...",
    ...partial,
  }
}

describe("WebRtcSignalBroker", () => {
  it("fans out incoming signals to matching subscribers only", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    const bobCall1 = fakeRes()
    const bobCall2 = fakeRes()
    const aliceCall1 = fakeRes()
    broker.subscribe("c1", "bob", bobCall1)
    broker.subscribe("c2", "bob", bobCall2)
    broker.subscribe("c1", "alice", aliceCall1)

    broker.handleIncoming(signal({ callId: "c1", to: "bob" }))

    expect(bobCall1.chunks).toHaveLength(1)
    expect(bobCall1.chunks[0]).toContain("event: signal")
    expect(bobCall1.chunks[0]).toContain("\"callId\":\"c1\"")
    expect(bobCall2.chunks).toHaveLength(0) // different callId
    expect(aliceCall1.chunks).toHaveLength(0) // different recipient
  })

  it("forwards outgoing signals via the mesh forwarder", async () => {
    const broker = new WebRtcSignalBroker("alice", [], () => {})
    const forwarder = vi.fn(async () => true)
    broker.setForwarder(forwarder)

    const out = signal({ from: "alice", to: "bob" })
    const result = await broker.handleOutgoing(out)

    expect(result.ok).toBe(true)
    expect(forwarder).toHaveBeenCalledWith("bob", out)
  })

  it("loops back outgoing signals addressed to self instead of forwarding", async () => {
    const broker = new WebRtcSignalBroker("alice", [], () => {})
    const forwarder = vi.fn(async () => true)
    broker.setForwarder(forwarder)
    const loopRes = fakeRes()
    broker.subscribe("c1", "alice", loopRes)

    await broker.handleOutgoing(signal({ from: "alice", to: "alice", callId: "c1" }))

    expect(forwarder).not.toHaveBeenCalled()
    expect(loopRes.chunks).toHaveLength(1)
  })

  it("rejects inbound offers from peers not in allowedCallers", () => {
    const broker = new WebRtcSignalBroker("bob", ["alice"], () => {})
    const subRes = fakeRes()
    broker.subscribe("c1", "bob", subRes)

    const bad = broker.handleIncoming(signal({ from: "mallory", to: "bob", kind: "offer" }))
    expect(bad.ok).toBe(false)
    expect(subRes.chunks).toHaveLength(0)

    const good = broker.handleIncoming(signal({ from: "alice", to: "bob", kind: "offer" }))
    expect(good.ok).toBe(true)
    expect(subRes.chunks).toHaveLength(1)
  })

  it("allows ICE/answer/hangup without gating (only offer/ring gate)", () => {
    const broker = new WebRtcSignalBroker("bob", ["alice"], () => {})
    const subRes = fakeRes()
    broker.subscribe("c1", "bob", subRes)

    // Not in allowedCallers but not an offer — passes (offer is the gate).
    const r = broker.handleIncoming(signal({ from: "mallory", to: "bob", kind: "ice" }))
    expect(r.ok).toBe(true)
    expect(subRes.chunks).toHaveLength(1)
  })

  it("fails outgoing when no forwarder is wired", async () => {
    const broker = new WebRtcSignalBroker("alice", [], () => {})
    const r = await broker.handleOutgoing(signal({ from: "alice", to: "bob" }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/forwarder/)
  })

  it("matches subscribers by normalized name (case/hyphen-insensitive)", () => {
    const broker = new WebRtcSignalBroker("Clawd Server", [], () => {})
    const sub = fakeRes()
    // Subscriber uses the self-reported node.name verbatim...
    broker.subscribe("c1", "Clawd Server", sub)
    // ...but the incoming signal uses the hyphenated peer-list spelling.
    broker.handleIncoming(signal({ callId: "c1", to: "clawd-server" }))
    expect(sub.chunks).toHaveLength(1)
  })

  it("normalizes allowedCallers too", () => {
    const broker = new WebRtcSignalBroker("bob", ["MacBook-Local"], () => {})
    const sub = fakeRes()
    broker.subscribe("c1", "bob", sub)
    // Signal's `from` uses a different spelling — should still be allowed.
    const r = broker.handleIncoming(signal({ from: "macbook_local", to: "bob", kind: "offer" }))
    expect(r.ok).toBe(true)
    expect(sub.chunks).toHaveLength(1)
  })

  it("buffers signals with no subscriber and flushes them on subscribe", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    // Offer arrives before callee opens the page.
    broker.handleIncoming(signal({ kind: "offer", callId: "c1", to: "bob" }))
    broker.handleIncoming(signal({ kind: "ice", callId: "c1", to: "bob", sdp: undefined, candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } }))
    const sub = fakeRes()
    broker.subscribe("c1", "bob", sub)
    // Both buffered signals should have been flushed.
    expect(sub.chunks).toHaveLength(2)
    expect(sub.chunks[0]).toContain("\"kind\":\"offer\"")
    expect(sub.chunks[1]).toContain("\"kind\":\"ice\"")
  })

  it("does not cross-flush buffered signals into a different callId/recipient", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    broker.handleIncoming(signal({ callId: "c1", to: "bob" }))
    const otherCall = fakeRes()
    const otherRecipient = fakeRes()
    broker.subscribe("c2", "bob", otherCall)
    broker.subscribe("c1", "alice", otherRecipient)
    expect(otherCall.chunks).toHaveLength(0)
    expect(otherRecipient.chunks).toHaveLength(0)
  })

  it("fires ring handler and dedups by callId", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    const calls: string[] = []
    broker.setRingHandler((s) => { calls.push(s.callId) })

    broker.handleIncoming(signal({ kind: "ring", callId: "c1" }))
    broker.handleIncoming(signal({ kind: "ring", callId: "c1" })) // dup — suppressed
    broker.handleIncoming(signal({ kind: "ring", callId: "c2" }))

    expect(calls).toEqual(["c1", "c2"])
  })

  it("does not fan out or buffer ring signals", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    broker.setRingHandler(() => {})
    broker.handleIncoming(signal({ kind: "ring", callId: "c1", to: "bob" }))
    // A subscriber joining later should NOT receive the ring.
    const sub = fakeRes()
    broker.subscribe("c1", "bob", sub)
    expect(sub.chunks).toHaveLength(0)
  })

  it("removes dead subscribers when write throws", () => {
    const broker = new WebRtcSignalBroker("bob", [], () => {})
    const dead = {
      write: () => { throw new Error("EPIPE") },
      end: () => {},
    } as unknown as ServerResponse
    broker.subscribe("c1", "bob", dead)
    expect(broker.subscriberCount).toBe(1)

    broker.handleIncoming(signal({ callId: "c1", to: "bob" }))
    expect(broker.subscriberCount).toBe(0)
  })
})
