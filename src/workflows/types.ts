import { z } from "zod"

// --- Workflows (V2 — dataflow DAG) ---
//
// A workflow is a directed acyclic graph of nodes connected by edges.
// A run executes the graph by walking from the trigger, accumulating each
// node's output into a shared context. Prompts and action params template
// against the context via `{{<nodeId>.<path>}}`.
//
// This replaces the previous state-machine model (states + transitions +
// external label backend). The label-as-state pattern is re-expressible
// via a `checkpoint` node + `action.setLabel` + `action.readLabel`.
//
// Shape on disk (.agentx/workflows/):
//   <id>.json                      — one workflow definition
//   _runs/<run-id>.jsonl           — append-only run events (home-node only)
//   _index/<backend>__<entity>.json — entity -> active runId lookup
//
// JSON-on-disk: no YAML dep.

// --------------------------- Node types -----------------------------------

export const nodeTypeSchema = z.enum([
  // Entry points
  "trigger.channel",
  "trigger.manual",
  "trigger.cron",
  "trigger.hook",
  // Compute
  "agent",
  "transform",
  // Control flow
  "branch",
  // Side-effect sinks (per channel verb). Each action.* maps 1:1 to an
  // existing channel-adapter method. New verbs arrive as new entries.
  "action.send",
  "action.createIssue",
  "action.setLabel",
  "action.readLabel",
  "action.react",
  "action.editMessage",
  "action.logTime",
  "action.callHTTP",
  // Persistence / pause
  "checkpoint",
  // Terminal
  "end",
])
export type NodeType = z.infer<typeof nodeTypeSchema>

// --------------------------- Condition (branch evaluator) -----------------

export const conditionKindSchema = z.enum([
  "equals",     // params: { path, value }
  "contains",   // params: { path, value }
  "matches",    // params: { path, regex }
  "exists",     // params: { path }
])
export type ConditionKind = z.infer<typeof conditionKindSchema>

export const conditionSchema = z.object({
  kind: conditionKindSchema,
  params: z.record(z.unknown()).default({}),
})
export type Condition = z.infer<typeof conditionSchema>

// --------------------------- Nodes + edges --------------------------------

export const workflowNodeSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "node id must be identifier-safe"),
  type: nodeTypeSchema,
  /** Free-form per-type config. Each node handler validates its own shape
   *  at execution time via a local Zod schema; keeping the top-level schema
   *  permissive lets new node types ship without a round-trip through here. */
  config: z.record(z.unknown()).default({}),
  /** Optional UI position. Ignored by the engine; persisted to keep the
   *  editor layout alongside the workflow (no separate _layouts file). */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
})
export type WorkflowNode = z.infer<typeof workflowNodeSchema>

export const workflowEdgeSchema = z.object({
  /** Source node id. */
  from: z.string(),
  /** Optional source port. Used by `branch` nodes to select an outgoing
   *  case; default `"out"` for single-port nodes. */
  fromPort: z.string().optional(),
  /** Target node id. */
  to: z.string(),
  /** Reserved — `"in"` in v1. Kept for future multi-input nodes. */
  toPort: z.string().optional(),
  /** Optional label shown on the edge in the editor. */
  label: z.string().optional(),
})
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>

// --------------------------- Workflow -------------------------------------

export const workflowSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "workflow id must be lower-kebab"),
  /** Schema version. V2 = dataflow DAG. V1 workflows are not loadable. */
  version: z.literal(2).default(2),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Higher priority wins when multiple workflows match the same event.
   *  Default 0. Ties broken by id. */
  priority: z.number().int().default(0),
  /** If true, every matching workflow runs in parallel (each with its own
   *  run). Default: only the highest-priority match runs. */
  fanOut: z.boolean().default(false),
  nodes: z.array(workflowNodeSchema).refine(
    (ns) => ns.length > 0, { message: "workflow must have at least one node" },
  ),
  edges: z.array(workflowEdgeSchema).default([]),
  /** Env vars that templates + node configs may read via {{env.*}}. */
  envAllow: z.array(z.string()).default([]),
  retention: z.object({
    maxRuns: z.number().int().positive().default(500),
    maxDays: z.number().int().positive().default(90),
  }).default({ maxRuns: 500, maxDays: 90 }),
  created: z.string().optional(),
  updated: z.string().optional(),
})
export type Workflow = z.infer<typeof workflowSchema>

// --------------------------- DAG linter -----------------------------------
//
// Replaces the FSM-era `lintWorkflow` from V1. Checks:
//   - exactly one trigger.* node (v1 rule; multi-trigger out of scope)
//   - every edge's from/to references an existing node
//   - no unreachable nodes (except the trigger) — DFS from trigger
//   - no cycles unless every cycle has an agent or checkpoint on it (those
//     are the nodes that can pause or consume external events; cycles
//     without either would infinite-loop the walker)
//   - every branch node's edge.fromPort matches a case in its config
//   - at least one `end` or `checkpoint` is reachable (runs must terminate)

export function lintWorkflow(wf: Workflow): string[] {
  const issues: string[] = []
  const byId = new Map(wf.nodes.map((n) => [n.id, n] as const))

  // 1. exactly one trigger
  const triggers = wf.nodes.filter((n) => n.type.startsWith("trigger."))
  if (triggers.length === 0) issues.push("workflow must have exactly one trigger.* node (found 0)")
  if (triggers.length > 1) issues.push(`workflow has ${triggers.length} trigger.* nodes; v1 supports exactly one`)

  // 2. edge endpoints exist
  for (const e of wf.edges) {
    if (!byId.has(e.from)) issues.push(`edge references missing node: from="${e.from}"`)
    if (!byId.has(e.to))   issues.push(`edge references missing node: to="${e.to}"`)
  }

  // 3. reachability from trigger
  const trigger = triggers[0]
  if (trigger) {
    const adj = new Map<string, string[]>()
    for (const e of wf.edges) {
      if (!adj.has(e.from)) adj.set(e.from, [])
      adj.get(e.from)!.push(e.to)
    }
    const seen = new Set<string>()
    const stack = [trigger.id]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const next of adj.get(id) ?? []) stack.push(next)
    }
    for (const n of wf.nodes) {
      if (!seen.has(n.id)) issues.push(`node "${n.id}" is unreachable from trigger "${trigger.id}"`)
    }
    if (!wf.nodes.some((n) => seen.has(n.id) && (n.type === "end" || n.type === "checkpoint"))) {
      issues.push("no reachable `end` or `checkpoint` node — the run cannot terminate or pause")
    }
  }

  // 4. branch ports
  for (const n of wf.nodes) {
    if (n.type !== "branch") continue
    const cases = (n.config.cases as Array<{ to: string }> | undefined) ?? []
    const defaultPort = n.config.default as string | undefined
    const declared = new Set<string>(cases.map((c) => c.to))
    if (defaultPort) declared.add(defaultPort)
    const outgoing = wf.edges.filter((e) => e.from === n.id)
    for (const edge of outgoing) {
      const port = edge.fromPort ?? ""
      if (!declared.has(port)) {
        issues.push(`branch "${n.id}" has outgoing edge with port "${port}" not declared in cases or default`)
      }
    }
  }

  // 5. cycle detection — only flag cycles that would infinite-loop (no agent
  //    or checkpoint on the cycle).
  const onCycle = detectCyclesWithoutPauseNodes(wf)
  for (const nodeIds of onCycle) {
    issues.push(`cycle without agent/checkpoint: ${nodeIds.join(" -> ")}`)
  }

  return issues
}

function detectCyclesWithoutPauseNodes(wf: Workflow): string[][] {
  const adj = new Map<string, string[]>()
  for (const e of wf.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
  }
  const byId = new Map(wf.nodes.map((n) => [n.id, n] as const))
  const results: string[][] = []
  const color = new Map<string, 0 | 1 | 2>() // 0=unvisited, 1=in-progress, 2=done
  const stack: string[] = []
  const dfs = (id: string) => {
    if (color.get(id) === 1) {
      // cycle: slice from first occurrence
      const i = stack.indexOf(id)
      if (i >= 0) {
        const cycle = stack.slice(i).concat(id)
        const hasPause = cycle.some((nid) => {
          const t = byId.get(nid)?.type
          return t === "agent" || t === "checkpoint"
        })
        if (!hasPause) results.push(cycle)
      }
      return
    }
    if (color.get(id) === 2) return
    color.set(id, 1)
    stack.push(id)
    for (const next of adj.get(id) ?? []) dfs(next)
    stack.pop()
    color.set(id, 2)
  }
  for (const n of wf.nodes) if (color.get(n.id) !== 2) dfs(n.id)
  return results
}

// --------------------------- Run model ------------------------------------

export const runStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
])
export type RunStatus = z.infer<typeof runStatusSchema>

export const nodeExecutionStatusSchema = z.enum([
  "ok",
  "failed",
  "timeout",
  "skipped",
  "paused",
  "resumed",
])
export type NodeExecutionStatus = z.infer<typeof nodeExecutionStatusSchema>

export const nodeExecutionEntrySchema = z.object({
  at: z.string(),                     // ISO-8601
  nodeId: z.string(),
  /** Which upstream node outputs fed this execution. Usually one id, or
   *  empty for the trigger. */
  inputKeys: z.array(z.string()).default([]),
  status: nodeExecutionStatusSchema,
  /** The node's output bundle, if successful. Stored here so the full run
   *  history can be replayed without the live context. */
  output: z.record(z.unknown()).optional(),
  /** Per-(runId, nodeId, eventId) key used to drop duplicate webhook
   *  deliveries when a run is resumed from a checkpoint. */
  idempotencyKey: z.string(),
  note: z.string().optional(),
})
export type NodeExecutionEntry = z.infer<typeof nodeExecutionEntrySchema>

export const entityRefSchema = z.object({
  backend: z.string(),
  /** Stable identifier for the entity this run is scoped to. Used to key
   *  the entity index so webhook re-entry can find the active run. */
  id: z.string(),
})
export type EntityRef = z.infer<typeof entityRefSchema>

export const pausedAtSchema = z.object({
  nodeId: z.string(),
  checkpointName: z.string(),
  /** Filter applied to incoming events for resume. Same shape as the
   *  matching trigger.channel filter. */
  resumeMatch: z.record(z.unknown()).default({}),
})
export type PausedAt = z.infer<typeof pausedAtSchema>

export const workflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.literal(2),
  homeNode: z.string(),
  status: runStatusSchema,
  pausedAt: pausedAtSchema.optional(),
  /** Output bundles keyed by producing node id. Downstream nodes read via
   *  `{{<nodeId>.<path>}}` in templates. */
  context: z.record(z.record(z.unknown())).default({}),
  /** Node ids queued for execution next. The walk driver pops from this
   *  until it's empty or a checkpoint pauses the run. */
  pending: z.array(z.string()).default([]),
  entityRef: entityRefSchema,
  history: z.array(nodeExecutionEntrySchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkflowRun = z.infer<typeof workflowRunSchema>
