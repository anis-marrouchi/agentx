import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { setLedgerForTesting, resetLedgerForTesting } from "../src/intent/instance"
import { recordGitLabTargetDispatch } from "../src/intent/sources/gitlab"
import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"

// A GitLab webhook on a node with `preferNode` set is forwarded to a mesh
// peer instead of running locally. Only registry.execute wrote ledger
// resolutions, so the adapter's `dispatched` decision on the forwarding
// node stayed open forever: the activity graph showed the MR as running
// and active-task safety treated its subject as busy (#27).

const AGENT = "atlas"
const PEER = "hq-local"
const PROJECT = "acme/soylent"

let tmp: string
let ledger: IntentLedger

function dispatch(iid: number) {
  return recordGitLabTargetDispatch(
    ledger,
    { entityKind: "merge_request", project: PROJECT, iid, action: "update", title: "t", description: "d", url: "u" },
    { agentId: AGENT, trigger: "default-route" },
    "{}",
    { agentId: AGENT, outcome: "dispatched" },
    () => 1,
  )
}

function makeMsg(id: string, intentRef?: { eventId: string; decidedBy: string }, viaPeer = true): IncomingMessage {
  return {
    id,
    channel: "gitlab",
    accountId: "default",
    sender: { id: "u1", name: "Alex Rivera", isBot: false },
    text: "[GitLab acme/soylent MR !60 update]",
    group: { id: `${PROJECT}:merge_request:60`, name: "soylent" },
    preferNode: viaPeer ? PEER : undefined,
    intentRef,
  } as any
}

describe("MessageRouter — mesh forwards resolve their intent decision", () => {
  let router: MessageRouter
  let sendTask: ReturnType<typeof vi.fn>
  let peerHealthy: boolean

  const adapter: any = {
    name: "gitlab",
    send: vi.fn(async () => "note-1"),
    react: vi.fn(),
    sendTyping: vi.fn(),
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-mesh-resolution-"))
    ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
    setLedgerForTesting(ledger)

    peerHealthy = true
    sendTask = vi.fn(async () => "done")
    router = new MessageRouter({ getAgent: () => undefined } as any, { channels: {} } as any)
    router.setMesh({
      directory: () => [{ peer: PEER, peerUrl: "u", healthy: peerHealthy, skills: [{ id: AGENT }], channels: [] }],
      findAgentPeer: (id: string) => (id === AGENT ? { peer: PEER, healthy: peerHealthy } : undefined),
      sendTask,
      onPeerChange: () => {},
    } as any)
  })

  afterEach(() => {
    resetLedgerForTesting()
    ledger.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("marks a preferNode forward completed once the peer answers", async () => {
    const d = dispatch(60)
    expect(ledger.getResolution(d.eventId, d.decidedBy)).toBeNull()

    await (router as any).processResolvedMessage(adapter, makeMsg("m1", d), AGENT, `${PROJECT}:merge_request:60`)

    const res = ledger.getResolution(d.eventId, d.decidedBy)
    expect(res?.status).toBe("completed")
    expect(res?.resultSummary).toBe("done")
    expect(res?.durationMs).not.toBeNull()
  })

  it("marks an agent-id forward completed when the agent is not local", async () => {
    const d = dispatch(61)
    await (router as any).processResolvedMessage(adapter, makeMsg("m2", d, false), AGENT, `${PROJECT}:merge_request:61`)

    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(ledger.getResolution(d.eventId, d.decidedBy)?.status).toBe("completed")
  })

  it("marks a failed forward failed, and a timed-out one timed-out", async () => {
    const failed = dispatch(62)
    sendTask.mockRejectedValueOnce(new Error("peer returned 500"))
    await (router as any).processResolvedMessage(adapter, makeMsg("m3", failed), AGENT, `${PROJECT}:merge_request:62`)
    expect(ledger.getResolution(failed.eventId, failed.decidedBy)?.status).toBe("failed")

    const slow = dispatch(63)
    sendTask.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
    await (router as any).processResolvedMessage(adapter, makeMsg("m4", slow), AGENT, `${PROJECT}:merge_request:63`)
    expect(ledger.getResolution(slow.eventId, slow.decidedBy)?.status).toBe("timed-out")
  })

  it("leaves a held message open, and cancels it when it expires unsent", async () => {
    peerHealthy = false
    const d = dispatch(64)
    const r = router as any
    await r.processResolvedMessage(adapter, makeMsg("m5", d), AGENT, `${PROJECT}:merge_request:64`)

    // Still waiting for the peer — genuinely in flight.
    expect(ledger.getResolution(d.eventId, d.decidedBy)).toBeNull()

    r.deferredByPeer.get(PEER)[0].deferredAt = Date.now() - 31 * 60 * 1000
    peerHealthy = true
    await r.replayDeferred(PEER)

    expect(sendTask).not.toHaveBeenCalled()
    expect(ledger.getResolution(d.eventId, d.decidedBy)?.status).toBe("canceled")
  })

  it("is a no-op for messages without an intentRef (ledger mode off)", async () => {
    await (router as any).processResolvedMessage(adapter, makeMsg("m6"), AGENT, `${PROJECT}:merge_request:65`)
    expect(sendTask).toHaveBeenCalledTimes(1)
  })
})
