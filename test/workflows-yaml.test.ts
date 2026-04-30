import { describe, it, expect } from "vitest"
import {
  desugarFlow,
  parseYamlWorkflow,
  WorkflowYamlError,
} from "../src/workflows/yaml"
import { workflowSchema } from "../src/workflows/types"

// ---------------------------------------------------------------------
// Move C — YAML parser + flow desugaring (commit 1 of 5)
// ---------------------------------------------------------------------

describe("parseYamlWorkflow", () => {
  it("parses a minimal valid workflow", () => {
    const text = `
id: minimal
version: 2
title: Minimal
nodes:
  - id: trigger
    type: trigger.manual
    config: {}
  - id: done
    type: end
    config: { status: completed }
edges:
  - { from: trigger, to: done }
`
    const raw = parseYamlWorkflow(text) as any
    expect(raw.id).toBe("minimal")
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
  })

  it("throws WorkflowYamlError on empty file", () => {
    expect(() => parseYamlWorkflow("")).toThrow(WorkflowYamlError)
    expect(() => parseYamlWorkflow("   \n  \n")).toThrow(/empty file/)
  })

  it("rejects multi-document YAML", () => {
    const text = `
id: a
---
id: b
`
    expect(() => parseYamlWorkflow(text)).toThrow(/multi-document/)
  })

  it("preserves YAML comments and parses normally", () => {
    const text = `
# top comment
id: c
version: 2
title: With comments
nodes:
  - id: trigger    # inline comment
    type: trigger.manual
    config: {}
  - id: done
    type: end
    config: {}
edges:
  - { from: trigger, to: done }
`
    expect(() => parseYamlWorkflow(text)).not.toThrow()
  })

  it("surfaces YAML parse errors with line/column when available", () => {
    const text = "id: x\n  bad: indent\n"
    try {
      parseYamlWorkflow(text, { filePath: "foo.yaml" })
      throw new Error("expected throw")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowYamlError)
      expect(e.message).toMatch(/foo\.yaml/)
      expect(e.message).toMatch(/YAML parse error/)
    }
  })

  it("rejects top-level non-mapping documents", () => {
    expect(() => parseYamlWorkflow("- just\n- a\n- list")).toThrow(/top-level YAML must be a mapping/)
  })
})

describe("desugarFlow", () => {
  function nodes(...ids: Array<[string, string]>) {
    return ids.map(([id, type]) => ({ id, type, config: {} }))
  }

  it("synthesizes linear edges from flow:[a,b,c]", () => {
    const out = desugarFlow({
      id: "x",
      nodes: nodes(["a", "trigger.manual"], ["b", "agent"], ["c", "end"]),
      flow: ["a", "b", "c"],
    }) as any
    expect(out.flow).toBeUndefined()
    expect(out.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ])
  })

  it("single-id flow produces no edges", () => {
    const out = desugarFlow({
      nodes: nodes(["a", "end"]),
      flow: ["a"],
    }) as any
    expect(out.edges).toEqual([])
  })

  it("rejects flow referencing an unknown node id", () => {
    expect(() =>
      desugarFlow({
        nodes: nodes(["a", "trigger.manual"]),
        flow: ["a", "ghost"],
      }),
    ).toThrow(/flow references unknown node "ghost"/)
  })

  it("rejects branch nodes in flow with a clear message", () => {
    expect(() =>
      desugarFlow({
        nodes: nodes(["a", "trigger.manual"], ["b", "branch"]),
        flow: ["a", "b"],
      }),
    ).toThrow(/flow cannot include branch node "b"; use explicit edges/)
  })

  it("rejects every multi-port / suspending node type in flow", () => {
    const forbidden = [
      "branch",
      "gateway.parallel",
      "rule",
      "signal.wait",
      "userTask",
      "subProcess",
      "timer.boundary",
      "checkpoint",
    ]
    for (const t of forbidden) {
      expect(() =>
        desugarFlow({
          nodes: nodes(["a", "trigger.manual"], ["b", t]),
          flow: ["a", "b"],
        }),
      ).toThrow(new RegExp(`flow cannot include ${t.replace(".", "\\.")} node`))
    }
  })

  it("unions and dedups when flow + edges both present", () => {
    const out = desugarFlow({
      nodes: nodes(["a", "trigger.manual"], ["b", "agent"], ["c", "end"]),
      flow: ["a", "b", "c"],
      edges: [
        { from: "a", to: "b" },              // duplicate of synthesized
        { from: "a", to: "c", label: "skip" }, // explicit, kept
      ],
    }) as any
    expect(out.edges).toHaveLength(3)
    expect(out.edges).toContainEqual({ from: "a", to: "b" })
    expect(out.edges).toContainEqual({ from: "a", to: "c", label: "skip" })
    expect(out.edges).toContainEqual({ from: "b", to: "c" })
  })

  it("explicit fromPort prevents dedup against synthesized edge", () => {
    const out = desugarFlow({
      nodes: nodes(["a", "trigger.manual"], ["b", "agent"]),
      flow: ["a", "b"],
      edges: [{ from: "a", to: "b", fromPort: "case-x" }],
    }) as any
    // Two edges from a→b: one with port, one without.
    expect(out.edges).toHaveLength(2)
  })

  it("rejects non-array flow", () => {
    expect(() => desugarFlow({ nodes: [], flow: "a" })).toThrow(/flow must be an array/)
  })

  it("rejects non-string flow entries", () => {
    expect(() => desugarFlow({ nodes: [], flow: ["a", 42] as any })).toThrow(/flow entries must be strings/)
  })

  it("treats null flow as absent", () => {
    const out = desugarFlow({ nodes: nodes(["a", "end"]), flow: null }) as any
    expect("flow" in out).toBe(false)
  })

  it("passes through workflows with no flow key untouched", () => {
    const input = {
      id: "w",
      nodes: nodes(["a", "trigger.manual"], ["b", "end"]),
      edges: [{ from: "a", to: "b" }],
    }
    const out = desugarFlow(input) as any
    expect(out).toEqual(input)
  })
})

describe("end-to-end: YAML → desugar → workflowSchema", () => {
  it("flow-shorthand YAML validates against the canonical schema", () => {
    const text = `
id: e2e-flow
version: 2
title: Flow E2E
nodes:
  - id: start
    type: trigger.manual
    config: {}
  - id: act
    type: agent
    config: { agentId: coder, prompt: "hi" }
  - id: done
    type: end
    config: {}
flow: [start, act, done]
`
    const raw = parseYamlWorkflow(text)
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.edges.map(e => `${e.from}->${e.to}`)).toEqual([
        "start->act",
        "act->done",
      ])
    }
  })
})
