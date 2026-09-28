import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { setLedgerForTesting, resetLedgerForTesting } from "../src/intent/instance"
import { recordGitLabTargetDispatch } from "../src/intent/sources/gitlab"
import { MessageRouter } from "../src/channels/router"
import { isQueued, parseQueued, queuedMarker } from "../src/agents/queued"
import type { IncomingMessage } from "../src/channels/types"

// #282: a busy agent on a peer queues the message and the peer answers /task
// with the registry's queued marker. mesh.sendTask turns that into a thrown
// `Peer "p" /task error: 500: __queued__:collect:1`, and all three mesh paths
// in the router treated it as a failure: ❌ plus "I couldn't complete that —
// queued:collect:1 … Nothing is retrying in the background", on a message
// that was in fact accepted and answered later.

const AGENT = "helper-agent"
const PEER = "peer-one"
const PROJECT = "acme/widgets"
const CHAT = `${PROJECT}:issue:7`
const QUEUED_ERR = `Peer "${PEER}" /task error: 500: __queued__:collect:1`

describe("parseQueued — the one place that knows the queued marker", () => {
  it("reads the local answer", () => {
    expect(parseQueued(queuedMarker("collect", 2))).toEqual({ mode: "collect", pending: 2 })
    expect(parseQueued("__queued__:followup:1")).toEqual({ mode: "followup", pending: 1 })
    expect(parseQueued("__queued__")).toEqual({ mode: "collect", pending: 1 })
  })

  it("reads it through a mesh hop and a nested fallback chain", () => {
    expect(parseQueued(QUEUED_ERR)).toEqual({ mode: "collect", pending: 1 })
    expect(parseQueued(
      `Peer "a" /task error: 500: mesh fallback failed: Peer "b" /task error: 500: __queued__:collect:3`,
    )).toEqual({ mode: "collect", pending: 3 })
    expect(parseQueued(`Peer "a" agent error: __queued__:followup:1`)).toEqual({ mode: "followup", pending: 1 })
  })

  it("does not match real errors or text that only mentions the marker", () => {
    expect(isQueued(undefined)).toBe(false)
    expect(isQueued("")).toBe(false)
    expect(isQueued(`Peer "${PEER}" /task error: 500: Claude Code timed out after 15m.`)).toBe(false)
    expect(isQueued("the registry returns __queued__:collect:1 when busy, see docs")).toBe(false)
  })
})

describe("MessageRouter — a queued answer from a peer is not a failure", () => {
  let tmp: string
  let ledger: IntentLedger
  let router: MessageRouter
  let sendTask: ReturnType<typeof vi.fn>
  let adapter: any

  function dispatch(iid: number) {
    return recordGitLabTargetDispatch(
      ledger,
      { entityKind: "issue", project: PROJECT, iid, action: "note", title: "t", description: "d", url: "u" },
      { agentId: AGENT, trigger: "mention" },
      "{}",
      { agentId: AGENT, outcome: "dispatched" },
      () => 1,
    )
  }

  function makeMsg(id: string, opts: { preferNode?: boolean; intentRef?: any } = {}): IncomingMessage {
    return {
      id,
      channel: "gitlab",
      accountId: "default",
      sender: { id: "u1", name: "Sam Example", isBot: false },
      text: `@${AGENT} please take a look`,
      group: { id: CHAT, name: "widgets" },
      preferNode: opts.preferNode ? PEER : undefined,
      intentRef: opts.intentRef,
    } as any
  }

  const failureComments = () =>
    adapter.send.mock.calls.filter(([m]: any[]) => String(m.text).includes("couldn't complete that"))
  const crosses = () => adapter.react.mock.calls.filter((c: any[]) => c.includes("❌"))

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-mesh-queued-"))
    ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
    setLedgerForTesting(ledger)
    adapter = { name: "gitlab", send: vi.fn(async () => "note-1"), react: vi.fn(), sendTyping: vi.fn() }
    sendTask = vi.fn(async () => { throw new Error(QUEUED_ERR) })
    router = new MessageRouter({ getAgent: () => undefined } as any, { channels: {} } as any, undefined, () => {})
    router.setMesh({
      directory: () => [{ peer: PEER, peerUrl: "u", healthy: true, skills: [{ id: AGENT, name: AGENT }], channels: [] }],
      findAgentPeer: (id: string) => (id === AGENT ? { peer: PEER, healthy: true } : undefined),
      sendTask,
      onPeerChange: () => {},
    } as any)
  })

  afterEach(() => {
    resetLedgerForTesting()
    ledger.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("preferNode path: no ❌, no failure comment, intent resolves as queued", async () => {
    const d = dispatch(7)
    await (router as any).processResolvedMessage(adapter, makeMsg("m1", { preferNode: true, intentRef: d }), AGENT, CHAT)

    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(crosses()).toHaveLength(0)
    expect(adapter.send).not.toHaveBeenCalled()
    const res = ledger.getResolution(d.eventId, d.decidedBy)
    expect(res?.status).toBe("queued")
    expect(res?.resultSummary).toContain("queued on peer-one")
  })

  it("agent-id path: no ❌, no failure comment, intent resolves as queued", async () => {
    const d = dispatch(8)
    await (router as any).processResolvedMessage(adapter, makeMsg("m2", { intentRef: d }), AGENT, CHAT)

    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(crosses()).toHaveLength(0)
    expect(adapter.send).not.toHaveBeenCalled()
    expect(ledger.getResolution(d.eventId, d.decidedBy)?.status).toBe("queued")
  })

  it("text-match path: no ❌ and no failure comment", async () => {
    const routed = await (router as any).handleViaMesh(adapter, makeMsg("m3"))

    expect(routed).toBe(true)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(crosses()).toHaveLength(0)
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it("a queued answer neither uses up nor re-arms the one failure notice", async () => {
    await (router as any).processResolvedMessage(adapter, makeMsg("m4", { preferNode: true }), AGENT, CHAT)
    expect((router as any).meshFailureNotified.size).toBe(0)

    // A real failure afterwards still gets its one comment.
    sendTask.mockRejectedValueOnce(new Error(`Peer "${PEER}" /task error: 500: Claude Code timed out after 15m.`))
    await (router as any).processResolvedMessage(adapter, makeMsg("m5", { preferNode: true }), AGENT, CHAT)
    expect(failureComments()).toHaveLength(1)

    // A queued answer in between does not re-arm it: the outage is not over
    // until something actually succeeds.
    await (router as any).processResolvedMessage(adapter, makeMsg("m6", { preferNode: true }), AGENT, CHAT)
    sendTask.mockRejectedValueOnce(new Error(`Peer "${PEER}" /task error: 500: Claude Code timed out after 15m.`))
    await (router as any).processResolvedMessage(adapter, makeMsg("m7", { preferNode: true }), AGENT, CHAT)
    expect(failureComments()).toHaveLength(1)
  })

  it("a real mesh error still reacts ❌ and posts exactly one comment", async () => {
    sendTask.mockImplementation(async () => {
      throw new Error(`Peer "${PEER}" /task error: 500: Anthropic's API is temporarily overloaded.`)
    })
    const d = dispatch(9)
    await (router as any).processResolvedMessage(adapter, makeMsg("m8", { intentRef: d }), AGENT, CHAT)
    await (router as any).processResolvedMessage(adapter, makeMsg("m9"), AGENT, CHAT)

    expect(crosses()).toHaveLength(2)
    expect(failureComments()).toHaveLength(1)
    expect(failureComments()[0][0].text).toContain("temporarily overloaded")
    expect(ledger.getResolution(d.eventId, d.decidedBy)?.status).toBe("failed")
  })
})
