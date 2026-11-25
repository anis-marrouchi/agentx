import { describe, it, expect } from "vitest"
import { GATES, gatesWithoutRow, liveGateRules, type GateLiveFacts } from "../src/gates"
import { buildRulesBlock, type RuleRow } from "../src/agents/rules-registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { ResolvedPolicy } from "../src/guard/types"
import type { SeatMode } from "../src/decisions/store"

// #2085 §3: a rule whose gate is live for the agent goes out as one short
// line; any other state keeps its full text.

const G1 = "every-new-issue-is-complete-when-it-is-created"
const G3 = "check-before-you-repeat-a-status"

function facts(over: {
  adapter?: "off" | "shadow" | "enforce"
  tier?: string
  policyMode?: "warn" | "enforce" | "off"
  ruleMode?: "enforce"
  seats?: Record<string, SeatMode>
  acceptWake?: boolean
} = {}): GateLiveFacts {
  const config = daemonConfigSchema.parse({
    node: { id: "t", name: "t" },
    gates: { issueComplete: { adapter: over.adapter ?? "enforce" } },
    agents: { ops: { name: "Ops", tier: over.tier ?? "claude-code", workspace: "/tmp" } },
    requests: { promises: { acceptWake: over.acceptWake ?? true } },
  })
  const policy = {
    mode: over.policyMode ?? "warn",
    defaults: {},
    protectedResources: {},
    rules: [{ id: "issue-complete", check: "issue-complete", ...(over.ruleMode ? { mode: over.ruleMode } : {}) }],
  } as unknown as ResolvedPolicy
  return { config, seatMode: (s) => over.seats?.[s] ?? "off", policy: () => policy }
}

describe("liveGateRules", () => {
  it("G1 is live only with the adapter and the guard rule both enforcing, on Claude Code", () => {
    expect(liveGateRules(facts({ ruleMode: "enforce" }), "ops").has(G1)).toBe(true)
    expect(liveGateRules(facts({ policyMode: "enforce" }), "ops").has(G1)).toBe(true)
    expect(liveGateRules(facts(), "ops").has(G1)).toBe(false)
    expect(liveGateRules(facts({ ruleMode: "enforce", adapter: "shadow" }), "ops").has(G1)).toBe(false)
    expect(liveGateRules(facts({ ruleMode: "enforce", tier: "codex-cli" }), "ops").has(G1)).toBe(false)
    expect(liveGateRules(facts({ ruleMode: "enforce", policyMode: "off" }), "ops").has(G1)).toBe(false)
  })
  it("G2 needs acceptWake and the due-time seat active; G3 its seat active", () => {
    expect(liveGateRules(facts({ seats: { "due-time": "active" } }), "ops").has("R4")).toBe(true)
    expect(liveGateRules(facts({ seats: { "due-time": "shadow" } }), "ops").has("R4")).toBe(false)
    expect(liveGateRules(facts({ seats: { "due-time": "active" }, acceptWake: false }), "ops").has("R4")).toBe(false)
    expect(liveGateRules(facts({ seats: { "status-claim": "active" } }), "ops").has(G3)).toBe(true)
    expect(liveGateRules(facts({ seats: { "status-claim": "shadow" } }), "ops").has(G3)).toBe(false)
  })
  it("a gate that throws is not live", () => {
    const f = facts()
    f.policy = () => { throw new Error("bad policy") }
    expect(liveGateRules(f, "ops").has(G1)).toBe(false)
  })
  it("names gates whose rule has no Registry row", () => {
    expect(gatesWithoutRow([G1, "R4"]).map((g) => g.ruleId)).toEqual([G3])
    expect(gatesWithoutRow(GATES.map((g) => g.ruleId))).toEqual([])
  })
})

describe("buildRulesBlock with live gates", () => {
  const row = (id: string, title: string, text: string): RuleRow => ({ id, title, text, decided: "Anis", terms: [] } as unknown as RuleRow)
  const rows = [row("R4", "No due time without a check time", "A due time only means something if it comes with a check time."), row("R5", "Standing orders", "Standing orders become standing jobs.")]
  it("sends a checked rule as one short line, the others in full", () => {
    const block = buildRulesBlock(rows, { checked: new Set(["R4"]) })
    expect(block).toContain("- R4: No due time without a check time (checked by AgentX)")
    expect(block).not.toContain("comes with a check time")
    expect(block).toContain("- R5: Standing orders become standing jobs. (decided: Anis)")
  })
  it("keeps every full line with no live gate", () => {
    expect(buildRulesBlock(rows)).toContain("comes with a check time")
  })
})
