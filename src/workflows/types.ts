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
  "trigger.form",
  // Compute
  "agent",
  "transform",
  // Control flow
  "branch",
  "gateway.parallel",
  "rule",
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
  // Registered action invocation — references an entry from the action
  // registry (.agentx/actions/<id>.json) by id, with templated inputs.
  // Lets operators define a reusable shell/http action once and call it
  // from many workflows without duplicating the command/url/headers.
  "action.run",
  // Built-in typed action invocation (improvement plan #6 + #9). Calls
  // a daemon-shipped action (http.fetch, mesh.delegate, extract.structured,
  // etc.) by name. Input is templated against the run context the same
  // way action.run is. Output is the validated builtin response so
  // downstream nodes can pipe typed data forward without reparsing.
  "action.builtin",
  // BPM: human tasks + composition + signals + intermediate timer
  "userTask",
  "subProcess",
  "signal.emit",
  "signal.wait",
  "timer.boundary",
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

/** Improvement plan #9b — per-node retry policy. When a node's
 *  handler returns `{ error }` (or throws), the dispatcher re-runs it
 *  up to `maxAttempts - 1` more times with exponential backoff
 *  (`backoffMs * 2^(attempt-1)`). Once all attempts are exhausted,
 *  the LAST error is what gets recorded as the node's failure.
 *  Defaults: maxAttempts=1 (no retry), backoffMs=1000.
 *
 *  Pause results (userTask, signalWait, timerWait) are NEVER retried —
 *  pausing is a normal lifecycle transition, not a failure. Only
 *  hard errors (`{error}` or thrown exceptions) trigger the retry. */
export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs: z.number().int().min(0).max(60_000).default(1000),
}).default({ maxAttempts: 1, backoffMs: 1000 })
export type RetryPolicy = z.infer<typeof retryPolicySchema>

export const workflowNodeSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "node id must be identifier-safe"),
  type: nodeTypeSchema,
  /** Free-form per-type config. Each node handler validates its own shape
   *  at execution time via a local Zod schema; keeping the top-level schema
   *  permissive lets new node types ship without a round-trip through here. */
  config: z.record(z.unknown()).default({}),
  /** Per-node retry on hard errors. See RetryPolicy. */
  retry: retryPolicySchema,
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
  /** Lifecycle state. The dispatcher and trigger registrar honor this:
   *   - active:      normal — triggers register, runs create + advance
   *   - disabled:    operator kill switch (config or admin action). No new
   *                  triggers, no new runs. In-flight runs continue.
   *   - quarantined: system set by the conflict detector when this workflow
   *                  would race with another dispatch path (e.g. a gitlab
   *                  agentMapping handles the same project the workflow
   *                  triggers on). Treated like `disabled` at runtime;
   *                  resolved by either fixing the conflict or operator
   *                  explicitly flipping the state back to `active`. */
  state: z.enum(["active", "disabled", "quarantined"]).default("active"),
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
  /** Safety rail on sub-process nesting depth. A parent at depth N may
   *  spawn children up to depth maxChildDepth - 1. Default 5. Override per
   *  workflow if a deeper composition is genuinely needed. */
  maxChildDepth: z.number().int().positive().default(5),
  /** Mesh integration. By default workflows are local — only triggers
   *  observed on the same node can fire them. Set `mesh.allowRemote: true`
   *  to opt the workflow into cross-mesh trigger fan-out: when a peer
   *  receives a channel event, it broadcasts it to mesh peers and any
   *  matching workflow with allowRemote runs on the peer that owns its
   *  definition. The opt-in is required because remote events carry
   *  reduced trust (sender provenance is mesh-token only) and can
   *  surprise authors who expected isolation. */
  mesh: z.object({
    allowRemote: z.boolean().default(false),
    /** Optional peer-name allowlist. When present, only triggers
     *  broadcast from these named peers are honored. Empty/unset = any
     *  authenticated peer. Useful for production workflows that should
     *  only accept events from a specific upstream node. */
    peers: z.array(z.string()).optional(),
  }).default({ allowRemote: false }),
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
    if (!wf.nodes.some((n) => seen.has(n.id) && isTerminalOrPauseNode(n.type))) {
      issues.push("no reachable `end`, `checkpoint`, `userTask`, `subProcess`, `signal.wait`, or `timer.boundary` node — the run cannot terminate or pause")
    }
  }

  // 4. branch ports (also applies to DMN-style `rule` nodes whose rows
  //    carry the same `{ to }` shape and a shared `default`).
  for (const n of wf.nodes) {
    if (n.type !== "branch" && n.type !== "rule") continue
    const cases = n.type === "branch"
      ? ((n.config.cases as Array<{ to: string }> | undefined) ?? [])
      : ((n.config.rules as Array<{ to?: string }> | undefined) ?? []).filter((r): r is { to: string } => typeof r.to === "string")
    const defaultPort = n.type === "branch"
      ? (n.config.default as string | undefined)
      : ((n.config.default as { to?: string } | undefined)?.to)
    const declared = new Set<string>(cases.map((c) => c.to))
    if (defaultPort) declared.add(defaultPort)
    const outgoing = wf.edges.filter((e) => e.from === n.id)
    for (const edge of outgoing) {
      const port = edge.fromPort ?? ""
      if (!declared.has(port)) {
        issues.push(`${n.type} "${n.id}" has outgoing edge with port "${port}" not declared in cases or default`)
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

function isTerminalOrPauseNode(type: NodeType): boolean {
  return type === "end"
      || type === "checkpoint"
      || type === "userTask"
      || type === "subProcess"
      || type === "signal.wait"
      || type === "timer.boundary"
}

function isPauseCapableNode(type: NodeType): boolean {
  // Nodes that either pause the run (checkpoint, userTask, subProcess,
  // signal.wait, timer.boundary) or consume an external event (agent).
  // A cycle is safe if it crosses at least one such node — otherwise the
  // walker would spin forever.
  return type === "agent"
      || type === "checkpoint"
      || type === "userTask"
      || type === "subProcess"
      || type === "signal.wait"
      || type === "timer.boundary"
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
          return t ? isPauseCapableNode(t) : false
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

// Discriminated `pausedAt` — each kind has its own resume path in the
// dispatcher. The original checkpoint shape is the `checkpoint` variant;
// new BPM nodes add userTask / subProcess / signalWait / timerWait.
export const pausedAtSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("checkpoint"),
    nodeId: z.string(),
    checkpointName: z.string(),
    /** Filter applied to incoming events for resume. Same shape as the
     *  matching trigger.channel filter. */
    resumeMatch: z.record(z.unknown()).default({}),
  }),
  z.object({
    kind: z.literal("userTask"),
    nodeId: z.string(),
    /** Task identifier — matches the record under _tasks/<taskId>.json. */
    taskId: z.string(),
    /** Assignee ref encoded as "actor:<id>" or "role:<id>". */
    assignee: z.string(),
    /** Concrete actors who currently see the task (resolved via role strategy). */
    assignedTo: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("subProcess"),
    nodeId: z.string(),
    childRunId: z.string(),
    childWorkflowId: z.string(),
  }),
  z.object({
    kind: z.literal("signalWait"),
    nodeId: z.string(),
    signalName: z.string(),
    /** Optional field-match filter against the emitted signal payload. */
    match: z.record(z.unknown()).default({}),
    scope: z.enum(["workflow", "global"]).default("workflow"),
  }),
  z.object({
    kind: z.literal("timerWait"),
    nodeId: z.string(),
    /** ISO-8601 instant when the timer should fire. */
    fireAt: z.string(),
  }),
])
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
  /** Per-`gateway.parallel(mode=join)` arrival tracker. Keys are join node
   *  ids; values are the upstream node ids that have already delivered.
   *  The join fires once when arrived.length === #incoming edges. Entries
   *  are deleted from the map on fire so repeated passes (rare, but
   *  possible via crash + retry) stay idempotent. */
  joinCounters: z.record(z.array(z.string())).default({}),
  entityRef: entityRefSchema,
  history: z.array(nodeExecutionEntrySchema).default([]),
  /** Parent run id if this run is a sub-process child. Root runs have no
   *  parent. */
  parentRunId: z.string().nullable().default(null),
  /** The parent node in the parent run that spawned this child. Null on
   *  root runs. */
  parentNodeId: z.string().nullable().default(null),
  /** Root ancestor. Self-referential on root runs. Lets queries fetch the
   *  entire composition tree in one shot. */
  rootRunId: z.string().nullable().default(null),
  /** Depth from root. 0 on root runs, N on Nth-level descendants. */
  depth: z.number().int().min(0).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkflowRun = z.infer<typeof workflowRunSchema>
