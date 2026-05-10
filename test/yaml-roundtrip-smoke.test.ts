import { describe, it, expect } from "vitest"
import { parseYamlWorkflow } from "../src/workflows/yaml"
import { workflowSchema } from "../src/workflows/types"
import { renderWorkflowYamlPreservingComments } from "../src/workflows/yaml-roundtrip"

const RICH_YAML = `# Workflow: Merge & Deploy (rich)
#
# Multi-node version. Per-node comments below must
# survive an editor save.

id: rich-merge
project: ksi/int.ksi.tn
version: 2
title: "KSI — Merge & Deploy (rich)"
status: active

envAllow:
  - GITLAB_TOKEN

flow:
  - trigger
  - capture-start
  - done

nodes:
  - id: trigger
    type: trigger.hook
    config:
      event: on:gitlab-mr

  # Capture start time so the recap can compute elapsed wall-clock.
  - id: capture-start
    type: action.builtin
    config:
      name: file.write_jsonl
      input:
        path: /tmp/recap.jsonl
        records:
          - phase: start

  - id: done
    type: end
    config:
      status: completed
`

describe("yaml round-trip — comment preservation", () => {
  it("keeps doc-level header + per-node commentBefore through an edit", () => {
    const raw = parseYamlWorkflow(RICH_YAML, { filePath: "rich.yaml" })
    const wf = workflowSchema.parse(raw)
    wf.title = "KSI — Merge & Deploy (rich, edited)"
    const node = wf.nodes.find((n) => n.id === "capture-start")!
    ;(node.config as any).input.records[0].phase = "start-edited"
    const out = renderWorkflowYamlPreservingComments(RICH_YAML, wf)
    expect(out).toContain("Workflow: Merge & Deploy (rich)")
    expect(out).toContain("Multi-node version")
    expect(out).toContain("Capture start time so the recap")
    expect(out).toContain("(rich, edited)")
    expect(out).toContain("start-edited")
  })

  it("drops a removed node and its comment, keeps surviving comments", () => {
    const raw = parseYamlWorkflow(RICH_YAML, { filePath: "rich.yaml" })
    const wf = workflowSchema.parse(raw)
    wf.nodes = wf.nodes.filter((n) => n.id !== "capture-start")
    wf.edges = wf.edges
      .filter((e) => e.from !== "capture-start" && e.to !== "capture-start")
      .concat([{ from: "trigger", to: "done" }])
    if (Array.isArray((wf as any).flow)) {
      ;(wf as any).flow = ((wf as any).flow as string[]).filter((id: string) => id !== "capture-start")
    }
    const out = renderWorkflowYamlPreservingComments(RICH_YAML, wf)
    expect(out).toContain("Workflow: Merge & Deploy (rich)")
    expect(out).not.toContain("Capture start time")
    expect(out).not.toContain("capture-start")
  })

  it("appends a brand-new node without a comment", () => {
    const raw = parseYamlWorkflow(RICH_YAML, { filePath: "rich.yaml" })
    const wf = workflowSchema.parse(raw)
    wf.nodes.splice(wf.nodes.length - 1, 0, {
      id: "extra",
      type: "action.run",
      config: { command: "echo hi" },
    } as any)
    const out = renderWorkflowYamlPreservingComments(RICH_YAML, wf)
    expect(out).toContain("Capture start time so the recap")
    expect(out).toContain("extra")
    expect(out).toContain("echo hi")
  })
})
