// --- Editor-side types (V2 — dataflow DAG) ---
//
// Mirrors src/workflows/types.ts at the TYPE level only — no runtime Zod
// here because this code runs in the browser bundle. Validation happens
// server-side via POST /api/workflows/:id/validate; the editor highlights
// the returned issues inline.

export type NodeType =
  | "trigger.channel"
  | "trigger.manual"
  | "trigger.cron"
  | "trigger.hook"
  | "trigger.form"
  | "agent"
  | "transform"
  | "branch"
  | "gateway.parallel"
  | "rule"
  | "action.send"
  | "action.createIssue"
  | "action.setLabel"
  | "action.readLabel"
  | "action.react"
  | "action.editMessage"
  | "action.logTime"
  | "action.callHTTP"
  | "action.run"
  | "userTask"
  | "subProcess"
  | "signal.emit"
  | "signal.wait"
  | "timer.boundary"
  | "checkpoint"
  | "end"

export type ConditionKind = "equals" | "contains" | "matches" | "exists"

export interface Condition {
  kind: ConditionKind
  params: Record<string, unknown>
}

export interface WorkflowNode {
  id: string
  type: NodeType
  config: Record<string, unknown>
  position?: { x: number; y: number }
}

export interface WorkflowEdge {
  from: string
  fromPort?: string
  to: string
  toPort?: string
  label?: string
}

export interface Workflow {
  id: string
  version: 2
  title: string
  description?: string
  priority: number
  fanOut: boolean
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  envAllow: string[]
  retention: { maxRuns: number; maxDays: number }
  maxChildDepth?: number
  /** Mesh integration. Optional in the editor — populated by the server
   *  schema with a default of { allowRemote: false }. */
  mesh?: { allowRemote: boolean; peers?: string[] }
  created?: string
  updated?: string
}

export interface WorkflowLayout {
  version: 1
  nodes: Record<string, { x: number; y: number }>
}

export interface ValidationIssue {
  path: string
  message: string
}

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null

// Legacy alias types kept only to not break cross-file imports during
// incremental migration. Will be removed alongside the FSM remnants in
// the editor.
export type ActionKind = string
export type Action = { kind: string; params: Record<string, unknown> }
