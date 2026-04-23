import type { Workflow, WorkflowEdge, WorkflowLayout, WorkflowNode } from "./types"

// Re-export so legacy import sites that pulled GraphNode/GraphEdge from this
// module still work. V2 uses the same node/edge shape as the server, so
// these are just aliases.
export type GraphNode = WorkflowNode
export type GraphEdge = WorkflowEdge & { id?: string }

// --- Graph model (V2 passthrough) ---
//
// In V2, the server's Workflow shape IS a node-and-edge DAG — the same
// representation the editor canvas speaks. This module used to fold an FSM
// (states + transitions) into a DAG and back, losing fidelity on round-trip.
// V2 makes that folding unnecessary: load/save is a near-identity copy.
//
// We still keep the separation so the editor has room to layer UI-only
// state (like collapsed sections in future) without polluting the server
// shape. And layout positions live in a separate `_layouts/<id>.json` file
// so the Workflow JSON stays behaviour-only.

export interface GraphModel {
  meta: {
    id: string
    version: 2
    title: string
    description?: string
    priority: number
    fanOut: boolean
    envAllow: string[]
    retention: Workflow["retention"]
  }
  nodes: WorkflowNode[]
  /** `id` is derived by workflowToGraph and optional on incoming models so
   *  upstream code that manipulates edges before hydration still type-checks. */
  edges: (WorkflowEdge & { id?: string })[]
}

export function workflowToGraph(wf: Workflow, layout?: WorkflowLayout | null): GraphModel {
  const layoutMap = layout?.nodes ?? {}
  const nodes: WorkflowNode[] = wf.nodes.map((n) => ({
    ...n,
    position: n.position ?? layoutMap[n.id] ?? undefined,
  }))
  const edges = wf.edges.map((e, i) => ({
    ...e,
    id: deriveEdgeId(e, i),
  }))
  return {
    meta: {
      id: wf.id,
      version: 2,
      title: wf.title,
      description: wf.description,
      priority: wf.priority,
      fanOut: wf.fanOut,
      envAllow: wf.envAllow,
      retention: wf.retention,
    },
    nodes,
    edges,
  }
}

export function graphToWorkflow(g: GraphModel): { workflow: Workflow; layout: WorkflowLayout } {
  const workflow: Workflow = {
    id: g.meta.id,
    version: 2,
    title: g.meta.title,
    description: g.meta.description,
    priority: g.meta.priority,
    fanOut: g.meta.fanOut,
    nodes: g.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      config: n.config ?? {},
      position: n.position,
    })),
    edges: g.edges.map((e) => {
      const { id: _id, ...rest } = e
      return rest
    }),
    envAllow: g.meta.envAllow,
    retention: g.meta.retention,
  }
  const layout: WorkflowLayout = {
    version: 1,
    nodes: Object.fromEntries(g.nodes
      .filter((n) => n.position)
      .map((n) => [n.id, { x: n.position!.x, y: n.position!.y }])),
  }
  return { workflow, layout }
}

export function blankGraph(id: string): GraphModel {
  return {
    meta: {
      id: /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : "new-workflow",
      version: 2,
      title: "New workflow",
      priority: 0,
      fanOut: false,
      envAllow: [],
      retention: { maxRuns: 500, maxDays: 90 },
    },
    nodes: [
      { id: "trigger", type: "trigger.manual", config: {}, position: { x: 40, y: 80 } },
      { id: "end",     type: "end",            config: { status: "completed" }, position: { x: 400, y: 80 } },
    ],
    edges: [
      { id: "e-trigger-end", from: "trigger", to: "end" },
    ],
  }
}

/** Stable id per edge so the UI can track which edge is which across
 *  re-renders. Derived from the endpoints + port so the same edge keeps
 *  the same id unless the user actually rewires it. */
function deriveEdgeId(e: WorkflowEdge, index: number): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_")
  const parts = [safe(e.from), e.fromPort ? safe(e.fromPort) : "out", safe(e.to), String(index)]
  return `e-${parts.join("-")}`
}

// Kept for import-compat during incremental rollout; editor code can
// remove the constant once we drop the legacy V1 shim paths.
export const TRIGGER_NODE_ID = "__trigger__"
