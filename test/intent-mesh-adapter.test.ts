import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildMeshEventInput,
  buildMeshPolicyFromLegacy,
  recordMeshDispatch,
  type MeshTaskProjection,
} from "../src/intent/sources/mesh"

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-mesh-adapter-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const meshTaskWithChannelContext: MeshTaskProjection = {
  agentId: "mtgl-v2",
  senderAgentId: "atlas",
  context: {
    chatId: "mtgl/mtgl-system-v2:issue:709",
    channel: "gitlab",
    project: "mtgl/mtgl-system-v2",
  },
}

const meshTaskBare: MeshTaskProjection = {
  agentId: "ksi-v2",
}

describe("buildMeshEventInput", () => {
  it("with channel context: subject = chat:<chatId>, project = forwarded project", () => {
    const input = buildMeshEventInput(meshTaskWithChannelContext, "{}", () => 999)
    expect(input).toEqual({
      ts: 999,
      source: "mesh",
      sourceEventId: null,
      project: "mtgl/mtgl-system-v2",
      subject: "chat:mtgl/mtgl-system-v2:issue:709",
      intent: "mesh.gitlab",
      rawJson: "{}",
    })
  })

  it("bare A2A task: subject = mesh:agent:<id>, project null, intent = mesh.task", () => {
    const input = buildMeshEventInput(meshTaskBare, "{}", () => 1)
    expect(input.subject).toBe("mesh:agent:ksi-v2")
    expect(input.intent).toBe("mesh.task")
    expect(input.project).toBeNull()
  })

  it("sourceEventId is always null — mesh protocol has no stable request id", () => {
    expect(buildMeshEventInput(meshTaskWithChannelContext, "{}", () => 1).sourceEventId).toBeNull()
    expect(buildMeshEventInput(meshTaskBare, "{}", () => 1).sourceEventId).toBeNull()
  })
})

describe("buildMeshPolicyFromLegacy", () => {
  it("decidedBy is the stable string 'mesh-receiver'", () => {
    expect(
      buildMeshPolicyFromLegacy({ outcome: "dispatched", agentId: "x" }).decidedBy,
    ).toBe("mesh-receiver")
  })

  it("dispatched flows through verbatim", () => {
    const decided = buildMeshPolicyFromLegacy({
      outcome: "dispatched", agentId: "mtgl-v2", reason: "from atlas",
    }).decide({} as any)
    expect(decided).toEqual({ agentId: "mtgl-v2", outcome: "dispatched", reason: "from atlas" })
  })
})

describe("recordMeshDispatch", () => {
  it("each call writes a fresh event row (sourceEventId=null = no idempotency)", () => {
    for (let i = 0; i < 3; i++) {
      recordMeshDispatch(
        ledger, meshTaskBare, "{}",
        { agentId: "ksi-v2", outcome: "dispatched", reason: null },
        () => 1 + i,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(3)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(3)
  })

  it("agreement: dispatched/X = dispatched/X → no divergence", () => {
    recordMeshDispatch(
      ledger, meshTaskWithChannelContext, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: "from atlas" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("active-task safety engages on (project, chatId) — second mesh task on same chat → ledger=deduped vs legacy=dispatched → divergence", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    // First task: ledger and legacy both dispatched.
    recordMeshDispatch(
      ledger, meshTaskWithChannelContext, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: null },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
    // Second task to same chat: ledger detects active task (project +
    // subject set) → deduped; legacy still dispatched → divergence.
    recordMeshDispatch(
      ledger, meshTaskWithChannelContext, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: null },
      () => 2,
    )
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0].ledgerOutcome).toBe("deduped")
    expect(divergences[0].legacyOutcome).toBe("dispatched")
  })
})
