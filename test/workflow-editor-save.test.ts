import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PassThrough } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { handleWorkflowsApi } from "../src/daemon/workflows-api"
import { LayoutStore, RunStore, WorkflowStore } from "../src/workflows"
import { graphToWorkflow, workflowToGraph } from "../src/web/workflow-editor/graph"

// #1538: an editor save rewrote fields it never showed (ownerAgent dropped,
// tags emptied, created reset, schema defaults written). These drive the
// real PUT route with what the editor sends.

let dir: string
let store: WorkflowStore

function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough
  req.method = method
  req.url = url
  return new Promise((done) => {
    let status = 0
    const res = {
      writeHead(s: number) { status = s },
      end(text: string) { done({ status, body: JSON.parse(text) }) },
    } as unknown as ServerResponse
    handleWorkflowsApi(req, res, {
      store,
      runs: new RunStore({ baseDir: dir }),
      layouts: new LayoutStore({ baseDir: dir }),
      requireScope: () => true,
    })
    req.end(body === undefined ? "" : JSON.stringify(body))
  })
}

/** What the editor PUTs after opening `id` and applying `edit`. */
async function editorSave(id: string, edit: (g: ReturnType<typeof workflowToGraph>) => void = () => {}) {
  const got = await call("GET", `/api/workflows/${id}`)
  const g = workflowToGraph(got.body.workflow, null)
  g.nodes = g.nodes.map((n, i) => ({ ...n, position: { x: 40 + i * 300, y: 80 } }))
  edit(g)
  return call("PUT", `/api/workflows/${id}`, graphToWorkflow(g).workflow)
}

const stored = {
  id: "owner-review",
  title: "Owner review",
  ownerAgent: "helper",
  tags: ["ops", "weekly"],
  state: "disabled",
  created: "2026-09-22",
  updated: "2026-09-22",
  nodes: [
    { id: "start", type: "trigger.manual", config: {} },
    { id: "done", type: "end", config: { status: "completed" } },
  ],
  edges: [{ from: "start", to: "done" }],
}

const YAML = [
  "# kept comment",
  "id: owner-review",
  "title: Owner review",
  "ownerAgent: helper",
  "tags: [ops]",
  "nodes:",
  "  - id: start",
  "    type: trigger.manual",
  "    config: {}",
  "  - id: done",
  "    type: end",
  "    config: { status: completed }",
  "edges:",
  "  - { from: start, to: done }",
  "",
].join("\n")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-editor-save-"))
  store = new WorkflowStore({ baseDir: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("editor save keeps the stored workflow (#1538)", () => {
  it("a save with only new positions leaves the file untouched", async () => {
    const path = join(dir, "owner-review.json")
    const text = JSON.stringify(stored, null, 2) + "\n"
    writeFileSync(path, text)
    const res = await editorSave("owner-review")
    expect(res.status).toBe(200)
    expect(readFileSync(path, "utf-8")).toBe(text)
  })

  it("an edit changes that field and the date, nothing else", async () => {
    const path = join(dir, "owner-review.json")
    writeFileSync(path, JSON.stringify(stored, null, 2) + "\n")
    const res = await editorSave("owner-review", (g) => {
      g.meta.title = "Owner review (renamed)"
      g.nodes[1] = { ...g.nodes[1], config: { status: "failed" } }
    })
    expect(res.status).toBe(200)
    const after = JSON.parse(readFileSync(path, "utf-8"))
    const today = new Date().toISOString().slice(0, 10)
    expect(after).toEqual({
      ...stored,
      title: "Owner review (renamed)",
      updated: today,
      nodes: [stored.nodes[0], { id: "done", type: "end", config: { status: "failed" } }],
    })
  })

  it("a changed node keeps the keys the editor does not send", async () => {
    const path = join(dir, "owner-review.json")
    const retry = { maxAttempts: 3, backoffMs: 500 }
    writeFileSync(path, JSON.stringify({ ...stored, nodes: [stored.nodes[0], { ...stored.nodes[1], retry }] }, null, 2) + "\n")
    await editorSave("owner-review", (g) => { g.nodes[1] = { ...g.nodes[1], config: { status: "failed" } } })
    const after = JSON.parse(readFileSync(path, "utf-8"))
    expect(after.nodes[1]).toEqual({ id: "done", type: "end", config: { status: "failed" }, retry })
  })

  it("clearing the description removes it", async () => {
    const path = join(dir, "owner-review.json")
    writeFileSync(path, JSON.stringify({ ...stored, description: "old" }, null, 2) + "\n")
    await editorSave("owner-review", (g) => { g.meta.description = undefined })
    expect(JSON.parse(readFileSync(path, "utf-8")).description).toBeUndefined()
  })

  it("a node with an inline position keeps it current", async () => {
    const path = join(dir, "owner-review.json")
    const withPos = { ...stored, nodes: [{ ...stored.nodes[0], position: { x: 1, y: 1 } }, stored.nodes[1]] }
    writeFileSync(path, JSON.stringify(withPos, null, 2) + "\n")
    await editorSave("owner-review")
    const after = JSON.parse(readFileSync(path, "utf-8"))
    expect(after.nodes[0].position).toEqual({ x: 40, y: 80 })
    expect(after.nodes[1].position).toBeUndefined()
  })

  it("a YAML workflow saved without changes stays as written", async () => {
    const path = join(dir, "owner-review.yaml")
    const text = YAML
    writeFileSync(path, text)
    const res = await editorSave("owner-review")
    expect(res.status).toBe(200)
    expect(readFileSync(path, "utf-8")).toBe(text)
  })

  it("a YAML edit keeps the comment and the keys the editor does not show", async () => {
    const path = join(dir, "owner-review.yaml")
    writeFileSync(path, YAML)
    const res = await editorSave("owner-review", (g) => { g.meta.title = "Renamed" })
    expect(res.status).toBe(200)
    const text = readFileSync(path, "utf-8")
    expect(text).toContain("# kept comment")
    expect(text).toContain("ownerAgent: helper")
    expect(text).toContain("title: Renamed")
    expect(text).not.toContain("matchCount")
  })
})
