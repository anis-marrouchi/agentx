import type { WorkflowEdge, WorkflowNode } from "./types"

// --- Output ports (#1524) ---
//
// The ports a step can leave on, in the order the canvas draws them top to
// bottom and the layout keeps them. They mirror what the engine fires
// (src/workflows/engine.ts, nodes/classify.ts, FOLLOW_UP_PORTS):
//
//   branch          each case's `to`, then `default`
//   rule            each row's `to`, then `default.to`
//   classify        each label, then `unsure`
//   owner.ask       yes (main), no, expired
//   person.message  sent (main), declined
//   person.wait     reply (main), timeout
//   anything else   one port, the main one
//
// The main port has no name: an edge leaves on it with no `fromPort`. An
// edge naming a port the step does not declare still gets a port of its
// own, after the declared ones, so nothing on disk is hidden.

export interface OutPort {
  /** The edge's `fromPort`; undefined for the main port. */
  name: string | undefined
  /** What the canvas prints next to it; empty for a lone main port. */
  label: string
}

const FOLLOW_UP: Record<string, { main: string; other: string[] }> = {
  "owner.ask": { main: "yes", other: ["no", "expired"] },
  "person.message": { main: "sent", other: ["declined"] },
  "person.wait": { main: "reply", other: ["timeout"] },
}

const UNSURE = "unsure"

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** The ports a node declares in its config, by name. */
function declared(node: WorkflowNode): string[] {
  const c = (node.config ?? {}) as Record<string, unknown>
  if (node.type === "branch") {
    const cases = Array.isArray(c.cases) ? (c.cases as Array<{ to?: unknown }>) : []
    return [...cases.map((x) => str(x?.to)), str(c.default)]
  }
  if (node.type === "rule") {
    const rows = Array.isArray(c.rules) ? (c.rules as Array<{ to?: unknown }>) : []
    return [...rows.map((x) => str(x?.to)), str((c.default as { to?: unknown } | undefined)?.to)]
  }
  if (node.type === "classify") {
    const labels = Array.isArray(c.labels) ? (c.labels as unknown[]).map(String)
      : c.labels && typeof c.labels === "object" ? Object.keys(c.labels as object) : []
    return [...labels, UNSURE]
  }
  return []
}

/** Every port the node leaves on, declared first, then any an edge names. */
export function outPorts(node: WorkflowNode, edges: WorkflowEdge[] = []): OutPort[] {
  if (node.type === "end") return []
  const fu = FOLLOW_UP[node.type]
  const ports: OutPort[] = fu
    ? [{ name: undefined, label: fu.main }, ...fu.other.map((p) => ({ name: p, label: p }))]
    : declared(node).filter(Boolean).map((p) => ({ name: p, label: p }))
  const seen = new Set(ports.map((p) => p.name ?? ""))
  // A follow-up step's main port answers to its own name too.
  if (fu) seen.add(fu.main)
  for (const e of edges) {
    if (e.from !== node.id) continue
    const key = e.fromPort ?? ""
    if (seen.has(key)) continue
    seen.add(key)
    ports.push({ name: e.fromPort, label: e.fromPort ?? "" })
  }
  if (!ports.length) ports.push({ name: undefined, label: "" })
  return ports
}

/** Which of the node's ports an edge leaves on. */
export function portIndex(ports: OutPort[], edge: WorkflowEdge, nodeType?: string): number {
  const fu = nodeType ? FOLLOW_UP[nodeType] : undefined
  const name = fu && edge.fromPort === fu.main ? undefined : edge.fromPort
  const i = ports.findIndex((p) => (p.name ?? "") === (name ?? ""))
  return i < 0 ? 0 : i
}

/** A port's height on a node of height h: spread evenly, one in the middle. */
export function portY(h: number, index: number, count: number): number {
  return (h * (index + 1)) / (count + 1)
}
