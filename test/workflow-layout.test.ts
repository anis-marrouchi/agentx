import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { arrange, needsArrange, nodeSize, outPoint, inPoint } from "../src/web/workflow-editor/geometry"
import { backEdges, layered } from "../src/web/workflow-editor/layout"
import { outPorts, portIndex } from "../src/web/workflow-editor/ports"
import type { Workflow, WorkflowNode } from "../src/web/workflow-editor/types"

// #1524: the editor's auto-arrange. The four examples are shaped like the
// owner's saved workflows (a deploy with a retry loop, a sweep with a
// classifier, a merge check with a retry, a WhatsApp intake with
// follow-up ports), with neutral names.

const DIR = join(__dirname, "../docs/public/examples/editor")
const EXAMPLES: Workflow[] = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")))

function placed(wf: Workflow): WorkflowNode[] {
  const pos = arrange(wf.nodes, wf.edges)
  return wf.nodes.map((n) => ({ ...n, position: pos[n.id] }))
}

describe("auto-arrange (#1524)", () => {
  it("has the four example workflows", () => {
    expect(EXAMPLES.map((w) => w.id)).toEqual(["demo-deploy", "demo-merge-verify", "demo-owner-sweep", "demo-whatsapp-intake"])
  })

  it("places every step, loops included, and never overlaps two steps", () => {
    for (const wf of EXAMPLES) {
      const nodes = placed(wf)
      for (const n of nodes) expect(n.position, `${wf.id}/${n.id}`).toBeDefined()
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], sa = nodeSize(a, wf.edges), sb = nodeSize(b, wf.edges)
        const apart = a.position!.x + sa.w <= b.position!.x || b.position!.x + sb.w <= a.position!.x
          || a.position!.y + sa.h <= b.position!.y || b.position!.y + sb.h <= a.position!.y
        expect(apart, `${wf.id}: ${a.id} overlaps ${b.id}`).toBe(true)
      }
    }
  })

  it("runs left to right: every edge but a loop's goes to a later column", () => {
    for (const wf of EXAMPLES) {
      const nodes = placed(wf)
      const by = new Map(nodes.map((n) => [n.id, n] as const))
      const loops = backEdges(nodes.map((n) => ({ id: n.id, w: 1, h: 1, ports: 1 })),
        wf.edges.map((e) => ({ from: e.from, to: e.to, port: portIndex(outPorts(by.get(e.from)!, wf.edges), e, by.get(e.from)!.type) })))
      wf.edges.forEach((e, i) => {
        if (loops.has(i)) return
        expect(by.get(e.from)!.position!.x, `${wf.id}: ${e.from} → ${e.to}`).toBeLessThan(by.get(e.to)!.position!.x)
      })
    }
  })

  it("leaves out exactly the edges that close a loop", () => {
    const deploy = EXAMPLES.find((w) => w.id === "demo-deploy")!
    const merge = EXAMPLES.find((w) => w.id === "demo-merge-verify")!
    const loops = (wf: Workflow) => [...backEdges(wf.nodes.map((n) => ({ id: n.id, w: 1, h: 1, ports: 1 })),
      wf.edges.map((e) => ({ from: e.from, to: e.to, port: 0 })))].map((i) => `${wf.edges[i].from}→${wf.edges[i].to}`)
    expect(loops(deploy)).toEqual(["fix→test"])
    expect(loops(merge)).toEqual(["pause→verify"])
    expect(loops(EXAMPLES.find((w) => w.id === "demo-whatsapp-intake")!)).toEqual([])
  })

  it("keeps a branch's cases in their order, top to bottom", () => {
    const wf = EXAMPLES.find((w) => w.id === "demo-whatsapp-intake")!
    const y = new Map(placed(wf).map((n) => [n.id, n.position!.y] as const))
    expect(y.get("lookup")!).toBeLessThan(y.get("open_issue")!)
    expect(y.get("open_issue")!).toBeLessThan(y.get("ask_person")!)
    const sweep = EXAMPLES.find((w) => w.id === "demo-owner-sweep")!
    const ys = new Map(placed(sweep).map((n) => [n.id, n.position!.y] as const))
    expect(["ask_review", "ask_answer", "close_stale", "unsure"].map((id) => ys.get(id)!))
      .toEqual(["ask_review", "ask_answer", "close_stale", "unsure"].map((id) => ys.get(id)!).sort((a, b) => a - b))
  })

  it("lines a straight run up on one height", () => {
    const wf = EXAMPLES.find((w) => w.id === "demo-merge-verify")!
    const nodes = placed(wf)
    const by = new Map(nodes.map((n) => [n.id, n] as const))
    // merged → wait → verify: each edge leaves and arrives at the same height.
    for (const [a, b] of [["merged", "wait"], ["wait", "verify"]]) {
      const e = wf.edges.find((x) => x.from === a && x.to === b)!
      expect(Math.abs(outPoint(by.get(a)!, e, wf.edges).y - inPoint(by.get(b)!, wf.edges).y)).toBeLessThan(2)
    }
  })

  it("gives the same layout every time", () => {
    for (const wf of EXAMPLES) expect(arrange(wf.nodes, wf.edges)).toEqual(arrange([...wf.nodes], [...wf.edges]))
  })

  it("survives a self-loop, a step on its own and an edge to nowhere", () => {
    const pos = layered(
      [{ id: "a", w: 100, h: 40, ports: 1 }, { id: "b", w: 100, h: 40, ports: 1 }, { id: "lone", w: 100, h: 40, ports: 1 }],
      [{ from: "a", to: "a", port: 0 }, { from: "a", to: "b", port: 0 }, { from: "b", to: "ghost", port: 0 }],
    )
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "lone"])
    expect(pos.a.x).toBeLessThan(pos.b.x)
  })

  it("arranges a workflow on open when its steps have no place", () => {
    expect(needsArrange([{ id: "a", type: "end", config: {} }])).toBe(true)
    expect(needsArrange([
      { id: "a", type: "end", config: {}, position: { x: 0, y: 0 } },
      { id: "b", type: "end", config: {}, position: { x: 0, y: 0 } },
    ])).toBe(true)
    expect(needsArrange([
      { id: "a", type: "end", config: {}, position: { x: 0, y: 0 } },
      { id: "b", type: "end", config: {}, position: { x: 300, y: 0 } },
    ])).toBe(false)
  })
})

describe("output ports (#1524)", () => {
  const node = (type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id: "n", type: type as WorkflowNode["type"], config })

  it("draws a branch's cases and default, in order", () => {
    const n = node("branch", { cases: [{ to: "ok" }, { to: "retry" }], default: "broken" })
    expect(outPorts(n).map((p) => p.name)).toEqual(["ok", "retry", "broken"])
  })

  it("draws a classifier's labels and its unsure port", () => {
    expect(outPorts(node("classify", { labels: { a: "", b: "" } })).map((p) => p.name)).toEqual(["a", "b", "unsure"])
    expect(outPorts(node("classify", { labels: ["x", "y"] })).map((p) => p.name)).toEqual(["x", "y", "unsure"])
  })

  it("leaves a follow-up step's main port unnamed, as the engine reads it", () => {
    const ports = outPorts(node("owner.ask"))
    expect(ports.map((p) => p.name)).toEqual([undefined, "no", "expired"])
    expect(ports[0].label).toBe("yes")
    expect(portIndex(ports, { from: "n", to: "x" }, "owner.ask")).toBe(0)
    expect(portIndex(ports, { from: "n", fromPort: "yes", to: "x" }, "owner.ask")).toBe(0)
    expect(portIndex(ports, { from: "n", fromPort: "expired", to: "x" }, "owner.ask")).toBe(2)
  })

  it("still shows an edge on a port the step does not declare", () => {
    const n = node("branch", { cases: [{ to: "ok" }], default: "no" })
    expect(outPorts(n, [{ from: "n", fromPort: "typo", to: "x" }]).map((p) => p.name)).toEqual(["ok", "no", "typo"])
  })

  it("gives a plain step one port and an end none", () => {
    expect(outPorts(node("agent"))).toEqual([{ name: undefined, label: "" }])
    expect(outPorts(node("end"))).toEqual([])
  })
})
