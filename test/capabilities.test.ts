import { describe, it, expect } from "vitest"
import { agentCanHandleIntent } from "../src/agents/capabilities"
import type { AgentDef } from "../src/daemon/config"

// Phase 5 (drop-condition fallback) — registered intents per agent.

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "test",
    workspace: "/tmp/x",
    tier: "claude-code",
    mentions: [],
    intents: [],
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
