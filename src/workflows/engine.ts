import type { Condition, Workflow, WorkflowEdge, WorkflowNode } from "./types"

// --- Engine (V2 — dataflow walk driver) ---
//
// Pure functions that decide what happens next given a workflow DAG + a
// completed node's output. No side effects — the dispatcher owns run-store
// writes, node handler execution, and mesh forwarding.
//
// The walk algorithm is simple: after a node completes, find its outgoing
// edges; for each edge, decide if it fires (always, for linear nodes; based
// on the selected port, for branch nodes); collect the target nodeIds into
// `nextPending`. The dispatcher picks them up on the next turn.

export interface WalkInput {
  workflow: Workflow
  /** The node that just completed. */
  fromNodeId: string
  /** For `branch` nodes, the port that was selected (e.g. "status", "new",
   *  "fallback"). For other node types, ignored. */
  selectedPort?: string
}

export interface WalkResult {
  /** Node ids the run should execute next. Usually 0 or 1 entries; can be
   *  >1 if the workflow deliberately fans out. */
  nextPending: string[]
}

/** Pure: given the workflow graph and the node that just completed, figure
 *  out what should run next. */
export function nextNodes(input: WalkInput): WalkResult {
  const { workflow, fromNodeId, selectedPort } = input
  const fromNode = workflow.nodes.find((n) => n.id === fromNodeId)
  if (!fromNode) return { nextPending: [] }
  const outgoing = workflow.edges.filter((e) => e.from === fromNodeId)

  // Branch nodes: only the edge whose fromPort matches the selectedPort fires.
  // Linear nodes: all outgoing edges fire (rare in v1; defaults to one).
  const firing = fromNode.type === "branch"
    ? outgoing.filter((e) => (e.fromPort ?? "") === (selectedPort ?? ""))
    : outgoing

  return { nextPending: firing.map((e) => e.to) }
}

// --- Branch condition evaluation ---
//
// A `branch` node's config is:
//   { cases: [ { when: Condition, to: portName } ], default: portName }
// Given the run's accumulated context, pick the first matching case or the
// default. Returns the port name the edge should leave from.

export function evaluateBranch(node: WorkflowNode, context: Record<string, unknown>): string {
  const cases = (node.config.cases as Array<{ when: Condition; to: string }> | undefined) ?? []
  const defaultPort = (node.config.default as string | undefined) ?? ""
  for (const c of cases) {
    if (conditionMatches(c.when, context)) return c.to
  }
  return defaultPort
}

function conditionMatches(cond: Condition, context: Record<string, unknown>): boolean {
  const p = (cond.params ?? {}) as Record<string, unknown>
  const path = String(p.path ?? "")
  const value = getByPath(context, path)
  switch (cond.kind) {
    case "equals":
      return value === p.value
    case "contains": {
      if (typeof value === "string") return value.includes(String(p.value ?? ""))
      if (Array.isArray(value)) return value.some((v) => v === p.value)
      return false
    }
    case "matches": {
      if (typeof value !== "string") return false
      try { return new RegExp(String(p.regex ?? "")).test(value) } catch { return false }
    }
    case "exists":
      return value !== undefined && value !== null && value !== ""
    default:
      return false
  }
}

/** Tiny dotted-path lookup that stops at non-objects. */
export function getByPath(ctx: unknown, path: string): unknown {
  if (!path) return undefined
  const parts = path.split(".")
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** The initial pending queue for a new run: the trigger node's successors.
 *  Called by the dispatcher when seeding a run's state. */
export function initialPendingFromTrigger(workflow: Workflow): { triggerId: string; pending: string[] } | null {
  const trigger = workflow.nodes.find((n) => n.type.startsWith("trigger."))
  if (!trigger) return null
  const successors = workflow.edges.filter((e) => e.from === trigger.id).map((e) => e.to)
  return { triggerId: trigger.id, pending: successors }
}

/** Return a node by id. Convenience used by the dispatcher + tests. */
export function findNode(workflow: Workflow, id: string): WorkflowNode | undefined {
  return workflow.nodes.find((n) => n.id === id)
}

/** Edges leaving a node — used for debugging and the editor overlay. */
export function outgoingEdges(workflow: Workflow, fromId: string): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.from === fromId)
}
