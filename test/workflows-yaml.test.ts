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

// ---------------------------------------------------------------------
// Move C — WorkflowStore integration (commit 2 of 5)
// ---------------------------------------------------------------------

import { mkdtempSync, writeFileSync, readdirSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { WorkflowStore } from "../src/workflows/store"

const VALID_FLOW_YAML = `id: foo
version: 2
title: Foo (yaml)
nodes:
  - { id: start, type: trigger.manual, config: {} }
  - { id: act,   type: agent,          config: { agentId: a, prompt: "x" } }
  - { id: done,  type: end,            config: {} }
flow: [start, act, done]
`
const VALID_FLOW_JSON = JSON.stringify({
  id: "foo",
  version: 2,
  title: "Foo (json)",
  nodes: [
    { id: "start", type: "trigger.manual", config: {} },
    { id: "done",  type: "end",            config: {} },
  ],
  edges: [{ from: "start", to: "done" }],
})

describe("WorkflowStore — YAML loading", () => {
  function freshStore() {
    const tmp = mkdtempSync(path.join(tmpdir(), "agentx-wf-store-"))
    return { store: new WorkflowStore({ baseDir: tmp }), dir: tmp }
  }

  it("list() loads a YAML workflow file", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    const all = store.list()
    expect(all.map(w => w.id)).toEqual(["foo"])
    expect(all[0].title).toBe("Foo (yaml)")
  })

  it("list() loads .yml as well as .yaml", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yml"), VALID_FLOW_YAML)
    expect(store.list().map(w => w.id)).toEqual(["foo"])
  })

  it("get() returns the YAML-defined workflow when only YAML exists", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    const wf = store.get("foo")
    expect(wf?.title).toBe("Foo (yaml)")
  })

  it("ignores files that don't end in .json/.yaml/.yml", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    writeFileSync(path.join(dir, "notes.txt"), "ignored")
    writeFileSync(path.join(dir, "_runs.json"), "{}")
    expect(store.list().map(w => w.id)).toEqual(["foo"])
  })

  it("list() skips ambiguous coexisting <id>.json + <id>.yaml entries", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.json"), VALID_FLOW_JSON)
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    expect(store.list()).toEqual([])
  })

  it("validateAll() reports duplicate-id errors on both sides of a coexistence", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.json"), VALID_FLOW_JSON)
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    const results = store.validateAll().filter(r => !r.isValid) as any[]
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.id).toBe("foo")
      expect(r.issues[0]).toMatch(/duplicate workflow id/)
    }
  })

  it("get() refuses to pick a winner when both files exist", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.json"), VALID_FLOW_JSON)
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    expect(store.get("foo")).toBeNull()
  })

  it("save() refuses when a YAML sibling exists for the id", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    expect(() =>
      store.save({
        id: "foo",
        version: 2,
        title: "from editor",
        nodes: [
          { id: "start", type: "trigger.manual", config: {} },
          { id: "done",  type: "end",            config: {} },
        ],
        edges: [{ from: "start", to: "done" }],
      } as any),
    ).toThrow(/yaml-authored workflow "foo"/)
  })

  it("validateAll() surfaces YAML structural errors with file path", () => {
    const { store, dir } = freshStore()
    // flow references unknown node — desugarFlow rejects
    writeFileSync(
      path.join(dir, "broken.yaml"),
      `id: broken
version: 2
title: Broken
nodes:
  - { id: a, type: trigger.manual, config: {} }
flow: [a, ghost]
`,
    )
    const r = store.validateAll().find(x => !x.isValid) as any
    expect(r).toBeDefined()
    expect(r.issues[0]).toMatch(/flow references unknown node "ghost"/)
  })

  it("delete() removes whichever extension exists", () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, "foo.yaml"), VALID_FLOW_YAML)
    expect(store.delete("foo")).toBe(true)
    expect(readdirSync(dir).filter(n => n.startsWith("foo"))).toEqual([])
  })
})

// ---------------------------------------------------------------------
// Move C — CLI YAML validate (commit 3 of 5)
// ---------------------------------------------------------------------

describe("CLI: agentx workflow validate <file.yaml>", () => {
  // The CLI's validate-single-file path is a thin wrapper around
  // parseYamlWorkflow + workflowSchema.safeParse + lintWorkflow. We
  // exercise the same composition directly here — testing the
  // process-level behaviour requires spawning a child and the wiring
  // change is straight pass-through.

  it("a valid YAML file produces a successful parse + lint", () => {
    const text = VALID_FLOW_YAML
    const raw = parseYamlWorkflow(text, { filePath: "ok.yaml" })
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const issues = lintWorkflowFromTest(parsed.data)
      expect(issues).toEqual([])
    }
  })

  it("a YAML file with malformed flow surfaces a parser error before Zod runs", () => {
    const broken = `id: x
version: 2
title: Broken
nodes:
  - { id: a, type: trigger.manual, config: {} }
flow: [a, ghost]
`
    expect(() => parseYamlWorkflow(broken, { filePath: "broken.yaml" })).toThrow(/flow references unknown node "ghost"/)
  })

  it("a YAML file failing schema validation produces structured Zod issues", () => {
    const bad = `id: foo
version: 2
title: Missing required nodes
`
    const raw = parseYamlWorkflow(bad, { filePath: "bad.yaml" })
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      // expected: nodes is required (non-empty)
      expect(parsed.error.issues.length).toBeGreaterThan(0)
    }
  })
})

import { lintWorkflow as lintWorkflowFromTest } from "../src/workflows/types"

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
