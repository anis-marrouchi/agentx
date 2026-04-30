import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  agentCanHandleIntent,
  delegationChainDepth,
  withinDelegationBudget,
} from "../src/agents/capabilities"
import { IntentLedger } from "../src/intent/ledger"
import type { AgentDef } from "../src/daemon/config"

// Phase 5 (drop-condition fallback) — registered intents per agent.

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "test",
    workspace: "/tmp/x",
    tier: "claude-code",
    mentions: [],
    intents: [],
    maxDelegationDepth: 5,
    contextReferences: false,
    maxConcurrent: 1,
    maxExecutionMinutes: 20,
    permissionMode: "default",
    queueMode: "collect",
    heartbeat: { enabled: false, intervalMinutes: 30 },
    ...overrides,
  } as unknown as AgentDef
}

describe("agentCanHandleIntent", () => {
  it("permissive default: empty intents list handles everything", () => {
    const a = agent({ intents: [] })
    expect(agentCanHandleIntent(a, "issue.opened")).toBe(true)
    expect(agentCanHandleIntent(a, "anything.at-all")).toBe(true)
    expect(agentCanHandleIntent(a, null)).toBe(true)
  })

  it("explicit intents list: only listed intents are handled", () => {
    const a = agent({ intents: ["issue.opened", "issue.commented"] })
    expect(agentCanHandleIntent(a, "issue.opened")).toBe(true)
    expect(agentCanHandleIntent(a, "issue.commented")).toBe(true)
    expect(agentCanHandleIntent(a, "merge_request.opened")).toBe(false)
    expect(agentCanHandleIntent(a, "cron.fired")).toBe(false)
  })

  it("null/undefined intent always passes (best-effort classifier)", () => {
    const a = agent({ intents: ["issue.opened"] })
    // Even with a strict list, a null intent (router DM with no
    // classification) is allowed through. Reason: the classifier is
    // best-effort and we don't want to halt dispatches just because
    // the intent string wasn't computed.
    expect(agentCanHandleIntent(a, null)).toBe(true)
    expect(agentCanHandleIntent(a, undefined)).toBe(true)
  })

  it("missing agent → false (defensive default)", () => {
    expect(agentCanHandleIntent(undefined, "any.intent")).toBe(false)
  })

  it("exact-string match (no globs / prefix matching in v0)", () => {
    const a = agent({ intents: ["issue.*"] })
    // The literal string "issue.*" is in the list, but "issue.opened"
    // is not. v0 is exact-string only — adding globs is a follow-up
    // when real production data shows the pattern is needed.
    expect(agentCanHandleIntent(a, "issue.opened")).toBe(false)
    expect(agentCanHandleIntent(a, "issue.*")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase 8 — delegationChainDepth + withinDelegationBudget
// ---------------------------------------------------------------------------

describe("Phase 8 — delegation budget (chain-depth check)", () => {
  let tmp: string
  let ledger: IntentLedger

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-delegation-"))
    ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
  })

  afterEach(() => {
    ledger.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  // Use a base ts close to "now" so the default 6h window includes
  // every fixture row. Each record gets a unique millisecond.
  const baseTs = Date.now() - 60 * 1000 // 1 minute ago
  let counter = 0
  function record(agentId: string, project = "p1", subject = "s1", offsetMs = 0) {
    const ts = baseTs + offsetMs + counter++
    const event = ledger.recordEvent({
      ts, source: "gitlab", sourceEventId: `${agentId}-${ts}`,
      project, subject, intent: "test", rawJson: "{}",
    })
    ledger.recordDecision({
      eventId: event.id, decidedAt: ts, decidedBy: "router",
      agentId, outcome: "dispatched", reason: null,
    })
  }

  beforeEach(() => { counter = 0 })

  it("delegationChainDepth counts distinct agents on the slot", () => {
    record("agent-a")
    record("agent-b")
    record("agent-c")
    expect(delegationChainDepth(ledger, "p1", "s1")).toBe(3)
  })

  it("delegationChainDepth ignores other slots", () => {
    record("agent-a", "p1", "s1")
    record("agent-b", "p1", "s2") // different subject
    record("agent-c", "p2", "s1") // different project
    expect(delegationChainDepth(ledger, "p1", "s1")).toBe(1)
  })

  it("delegationChainDepth respects the recency window", () => {
    // Insert one row OUTSIDE the 6h default window (10h ago) and one
    // INSIDE (1m ago). Only the inside row counts.
    record("agent-a", "p1", "s1", -10 * 60 * 60 * 1000) // baseTs - 10h
    record("agent-b") // ~baseTs (≈ 1m ago)
    expect(delegationChainDepth(ledger, "p1", "s1")).toBe(1)
  })

  it("delegationChainDepth returns 0 for null project or subject", () => {
    expect(delegationChainDepth(ledger, null, "s1")).toBe(0)
    expect(delegationChainDepth(ledger, "p1", null)).toBe(0)
  })

  it("withinDelegationBudget: 0 in chain → first dispatch always allowed (depth 1 ≤ max=5)", () => {
    const a = agent({ maxDelegationDepth: 5 })
    expect(withinDelegationBudget(ledger, a, "agent-a", "p1", "s1")).toBe(true)
  })

  it("withinDelegationBudget: dispatching to a NEW agent at chain-depth=N succeeds when N+1 ≤ max", () => {
    record("agent-a")
    record("agent-b")
    const newAgent = agent({ maxDelegationDepth: 3 })
    // Chain has 2 agents. Adding agent-c → projected depth 3, ≤ max 3 → allowed.
    expect(withinDelegationBudget(ledger, newAgent, "agent-c", "p1", "s1")).toBe(true)
  })

  it("withinDelegationBudget: dispatching to a NEW agent past max → refused", () => {
    record("agent-a")
    record("agent-b")
    record("agent-c")
    const newAgent = agent({ maxDelegationDepth: 3 })
    // Chain has 3 agents. Adding agent-d → projected depth 4, > max 3 → refused.
    expect(withinDelegationBudget(ledger, newAgent, "agent-d", "p1", "s1")).toBe(false)
  })

  it("withinDelegationBudget: re-dispatching to an agent ALREADY in the chain doesn't grow depth", () => {
    record("agent-a")
    record("agent-b")
    record("agent-c")
    const reDispatchAgent = agent({ maxDelegationDepth: 3 })
    // Chain has 3 agents (a, b, c). Re-dispatching to agent-b (already
    // there) → projected depth 3, == max 3 → still allowed.
    expect(withinDelegationBudget(ledger, reDispatchAgent, "agent-b", "p1", "s1")).toBe(true)
  })

  it("withinDelegationBudget: maxDelegationDepth=0 disables the agent entirely", () => {
    const disabled = agent({ maxDelegationDepth: 0 })
    expect(withinDelegationBudget(ledger, disabled, "agent-x", "p1", "s1")).toBe(false)
  })

  it("withinDelegationBudget: missing agent → false (defensive)", () => {
    expect(withinDelegationBudget(ledger, undefined, "ghost", "p1", "s1")).toBe(false)
  })
})
