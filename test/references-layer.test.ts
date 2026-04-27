import { describe, it, expect } from "vitest"
import { buildAgentContext, type ContextInput } from "../src/agents/context"

const baseInput: ContextInput = {
  channel: "telegram",
  agentId: "devops-agent",
  agentName: "DevOps",
  sender: "Anis",
  message: "ssh in and restart agentx",
}

describe("references layer", () => {
  it("renders the verified-references block when references is set", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      references:
        "[Verified References — deterministic, do not re-query]\n- ksi.ssh.clawd-mac (ssh): clawd-server { user=clawd host=64.226.102.124 }",
    })
    expect(ctx).toContain("[Verified References")
    expect(ctx).toContain("ksi.ssh.clawd-mac")
    expect(ctx).toContain("user=clawd")
    expect(ctx).toContain("host=64.226.102.124")
  })

  it("renders the references block before the intent layer (priority 4.7 < 5)", () => {
    const ctx = buildAgentContext({
      ...baseInput,
      // explicit intent so the intent layer is emitted
      intent: {
        path: ["devops"],
        pathLabel: "DevOps",
        pathId: "x",
        status: "approved",
      },
      references: "[Verified References — deterministic, do not re-query]\n- ksi.ssh.clawd-mac (ssh): clawd-server",
    })
    const refsIdx = ctx.indexOf("[Verified References")
    const intentIdx = ctx.indexOf("[Intent path")
    expect(refsIdx).toBeGreaterThan(0)
    expect(intentIdx).toBeGreaterThan(0)
    expect(refsIdx).toBeLessThan(intentIdx)
  })

  it("omits the references layer when not provided", () => {
    const ctx = buildAgentContext(baseInput)
    expect(ctx).not.toContain("[Verified References")
  })

  it("trims to the per-layer budget (500 tokens ≈ 2000 chars)", () => {
    const huge = Array.from({ length: 200 })
      .map((_, i) => `- ksi.test.${i}: ${"x".repeat(80)}`)
      .join("\n")
    const block = `[Verified References — deterministic, do not re-query]\n${huge}`
    const ctx = buildAgentContext({ ...baseInput, references: block })
    // The references segment should be capped at ≈ 2000 chars (500 tokens × 4).
    // We grab from the references header up to the next blank line.
    const start = ctx.indexOf("[Verified References")
    const segment = ctx.slice(start).split("\n\n")[0]
    expect(segment.length).toBeLessThanOrEqual(2010)
  })
})
