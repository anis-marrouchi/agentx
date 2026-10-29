import { layered, type Positions } from "./layout"
import { outPorts, portIndex, portY } from "./ports"
import type { WorkflowEdge, WorkflowNode } from "./types"

// --- Node geometry (#1524) ---
//
// One size per kind of step, so the canvas, the edges and the auto-arrange
// agree on where every box and port is. A box is drawn at exactly this size
// (Canvas.tsx sets its height), and a step with several ports grows to give
// each port its own row.

const NODE_W: Record<string, number> = { trigger: 220, branch: 240, action: 220, end: 160, agent: 240, checkpoint: 220, transform: 220 }
const NODE_H: Record<string, number> = { trigger: 46, branch: 92, action: 78, end: 46, agent: 104, checkpoint: 92, transform: 78 }
const PORT_ROW = 26

/** A V2 node type's visual category. */
export function nodeCategory(type: string): string {
  if (type.startsWith("trigger.")) return "trigger"
  if (type.startsWith("action.")) return "action"
  return type
}

export function nodeSize(n: WorkflowNode, edges: WorkflowEdge[] = []): { w: number; h: number } {
  const cat = nodeCategory(n.type)
  const ports = outPorts(n, edges).length
  const h = Math.max(NODE_H[cat] ?? 92, ports > 1 ? 18 + PORT_ROW * ports : 0)
  return { w: NODE_W[cat] ?? 220, h }
}

/** Where an edge leaves its step, in canvas coordinates. */
export function outPoint(n: WorkflowNode, edge: WorkflowEdge, edges: WorkflowEdge[]): { x: number; y: number } {
  const { w, h } = nodeSize(n, edges)
  const ports = outPorts(n, edges)
  const i = portIndex(ports, edge, n.type)
  return { x: (n.position?.x ?? 0) + w, y: (n.position?.y ?? 0) + portY(h, i, ports.length) }
}

/** Where an edge arrives: the middle of the step's left side. */
export function inPoint(n: WorkflowNode, edges: WorkflowEdge[]): { x: number; y: number } {
  const { h } = nodeSize(n, edges)
  return { x: n.position?.x ?? 0, y: (n.position?.y ?? 0) + h / 2 }
}

/** Auto-arrange a workflow: a position for every step (layout.ts). */
export function arrange(nodes: WorkflowNode[], edges: WorkflowEdge[]): Positions {
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  return layered(
    nodes.map((n) => ({ id: n.id, ...nodeSize(n, edges), ports: outPorts(n, edges).length })),
    edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => {
      const from = byId.get(e.from)!
      return { from: e.from, to: e.to, port: portIndex(outPorts(from, edges), e, from.type) }
    }),
  )
}

/** True when a step has no saved place, so the editor arranges on open. */
export function needsArrange(nodes: WorkflowNode[]): boolean {
  if (nodes.some((n) => !n.position)) return true
  // Everything piled on one spot is no layout either.
  return nodes.length > 1 && new Set(nodes.map((n) => `${n.position!.x},${n.position!.y}`)).size === 1
}
