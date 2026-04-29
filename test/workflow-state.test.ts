import { describe, it, expect } from "vitest"
import { workflowSchema } from "../src/workflows/types"

// Smoke tests for the new workflow.state field. Lifecycle gating itself
// (dispatcher + trigger registrar honoring state) is covered indirectly by
// existing integration suites; here we just pin the schema contract because
// that's the surface external configs depend on.

const baseWorkflow = {
  id: "test-wf",
  title: "Test",
  nodes: [{ id: "t1", type: "trigger.channel", position: { x: 0, y: 0 }, config: {} }],
  edges: [],
}

describe("workflowSchema state field", () => {
  it("defaults to active when omitted", () => {
    const parsed = workflowSchema.parse(baseWorkflow)
    expect(parsed.state).toBe("active")
  })

  it("accepts active, disabled, quarantined", () => {
    for (const state of ["active", "disabled", "quarantined"] as const) {
      const parsed = workflowSchema.parse({ ...baseWorkflow, state })
      expect(parsed.state).toBe(state)
    }
  })

  it("rejects unknown states", () => {
    expect(() => workflowSchema.parse({ ...baseWorkflow, state: "paused" })).toThrow()
    expect(() => workflowSchema.parse({ ...baseWorkflow, state: "" })).toThrow()
  })
})
