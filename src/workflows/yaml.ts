import yaml from "js-yaml"

// --- Move C — YAML workflow authoring ---
//
// Workflows are still defined by `workflowSchema` in types.ts; this
// module only provides:
//   1) parseYamlWorkflow(text) — js-yaml + a guard against multi-doc
//      streams (we only accept a single workflow per file in v1).
//   2) desugarFlow(raw) — expand the optional top-level `flow: [a,b,c]`
//      sugar into explicit edges, then strip the `flow` key so Zod
//      validation sees the canonical shape.
//
// Why a `flow:` shorthand? Linear sequences are the common case for
// authors and they're verbose to express via parallel `nodes:` +
// `edges:` lists. `flow:` lets you read a workflow top-to-bottom.
// Branches, parallel gateways, signals, and loops still require
// explicit edges — those have semantics that no array can imply.
//
// Sugar limits (enforced at parse time so authors get a clear error
// rather than a strange runtime behaviour):
//   - flow: cannot include node ids whose type is one of:
//     branch, gateway.parallel, rule, signal.wait, userTask,
//     subProcess, timer.boundary, checkpoint.
//   - flow: ids must reference real nodes in the same file.
//   - flow: and edges: may coexist; the result is union + dedup.
//   - Multi-document YAML (`---`) is rejected — one workflow per file.

/** Node types that have multi-port semantics or human/timed
 *  suspension and therefore must use explicit `edges:` rather than
 *  `flow:`. Mirroring this list in the doc keeps authors honest. */
const FLOW_FORBIDDEN_TYPES = new Set([
  "branch",
  "gateway.parallel",
  "rule",
  "signal.wait",
  "userTask",
  "subProcess",
  "timer.boundary",
  "checkpoint",
])

export interface ParseYamlOptions {
  /** Optional file path used only to enrich error messages. */
  filePath?: string
}

/** Thrown when the YAML structure is invalid before Zod ever sees it.
 *  Distinct class so the CLI can render parser errors with line/col
 *  hints without conflating them with schema errors. */
export class WorkflowYamlError extends Error {
  constructor(message: string, public readonly mark?: yaml.Mark) {
    super(message)
    this.name = "WorkflowYamlError"
  }
}

/** Parse and desugar — returns the JSON-shaped workflow object ready
 *  to feed `workflowSchema.safeParse()`. Does NOT validate the schema;
 *  callers (CLI, store) run Zod and surface its issues separately. */
export function parseYamlWorkflow(text: string, opts: ParseYamlOptions = {}): unknown {
  if (!text || text.trim() === "") {
    throw new WorkflowYamlError(
      `${prefix(opts)}empty file — workflow YAML must contain at least an id, version, title, and one node.`,
    )
  }

  // js-yaml's loadAll detects multi-doc streams. We support exactly
  // one document per file in v1 — multi-doc encourages copy-paste-edit
  // patterns that hide later docs from the validator.
  let docs: unknown[]
  try {
    docs = yaml.loadAll(text)
  } catch (e: any) {
    const mark = e?.mark as yaml.Mark | undefined
    throw new WorkflowYamlError(
      `${prefix(opts)}YAML parse error: ${e?.reason ?? e?.message ?? e}` +
        (mark ? ` (line ${mark.line + 1}, column ${mark.column + 1})` : ""),
      mark,
    )
  }
  if (docs.length === 0 || (docs.length === 1 && docs[0] == null)) {
    throw new WorkflowYamlError(`${prefix(opts)}YAML produced no document.`)
  }
  if (docs.length > 1) {
    throw new WorkflowYamlError(
      `${prefix(opts)}multi-document YAML is not supported in v1; one workflow per file.`,
    )
  }
  const raw = docs[0]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? "array" : typeof raw
    throw new WorkflowYamlError(`${prefix(opts)}top-level YAML must be a mapping (got ${got}).`)
  }

  return desugarFlow(raw as Record<string, unknown>, opts)
}

/** Expand `flow: [a,b,c]` into edges and strip the `flow` key. Also
 *  validates the rules listed at the top of this file. Pure function
 *  on the parsed-but-not-yet-validated object. */
export function desugarFlow(
  raw: Record<string, unknown>,
  opts: ParseYamlOptions = {},
): unknown {
  if (!("flow" in raw)) return raw

  const flow = raw.flow
  if (flow === undefined || flow === null) {
    // Treat null/undefined as if `flow:` weren't present — drop the key
    // and pass through.
    const out: Record<string, unknown> = { ...raw }
    delete out.flow
    return out
  }
  if (!Array.isArray(flow)) {
    throw new WorkflowYamlError(`${prefix(opts)}flow must be an array of node ids (got ${typeof flow}).`)
  }
  for (const item of flow) {
    if (typeof item !== "string") {
      throw new WorkflowYamlError(`${prefix(opts)}flow entries must be strings (got ${typeof item}).`)
    }
  }
  const flowIds = flow as string[]

  // Cross-check against the nodes[] in the same file. We only need id +
  // type for the flow-rule check; any malformed node entry is left for
  // Zod to surface with a precise path.
  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as Array<Record<string, unknown>>) : []
  const idToType = new Map<string, string>()
  for (const n of nodes) {
    if (n && typeof n === "object" && typeof n.id === "string" && typeof n.type === "string") {
      idToType.set(n.id, n.type)
    }
  }

  for (const id of flowIds) {
    if (!idToType.has(id)) {
      throw new WorkflowYamlError(`${prefix(opts)}flow references unknown node "${id}".`)
    }
    const type = idToType.get(id)!
    if (FLOW_FORBIDDEN_TYPES.has(type)) {
      throw new WorkflowYamlError(
        `${prefix(opts)}flow cannot include ${type} node "${id}"; use explicit edges for ${type} nodes.`,
      )
    }
  }

  // Synthesize linear edges. Single-id flows produce nothing — their
  // "edges" are degenerate. Use Map keyed by from→fromPort→to so we can
  // dedup against any pre-existing entries in raw.edges.
  const synthesized: Array<{ from: string; to: string }> = []
  for (let i = 0; i < flowIds.length - 1; i++) {
    synthesized.push({ from: flowIds[i], to: flowIds[i + 1] })
  }

  // Union with explicit edges, deduping on (from, fromPort, to). Explicit
  // edges win when a synthesized edge would shadow them — the explicit
  // form may carry a label or a port the sugar doesn't know about.
  const explicit: Array<Record<string, unknown>> = Array.isArray(raw.edges)
    ? (raw.edges as Array<Record<string, unknown>>)
    : []
  const seen = new Set<string>()
  const unioned: Array<Record<string, unknown>> = []

  for (const e of explicit) {
    if (!e || typeof e !== "object") continue
    const k = edgeKey(e.from, e.fromPort, e.to)
    if (k && !seen.has(k)) {
      seen.add(k)
      unioned.push(e)
    } else if (!k) {
      // Pass through ill-formed edges so Zod can surface them with a
      // precise path. Don't drop silently.
      unioned.push(e)
    }
  }
  for (const e of synthesized) {
    const k = edgeKey(e.from, undefined, e.to)
    if (k && !seen.has(k)) {
      seen.add(k)
      unioned.push(e)
    }
  }

  const out: Record<string, unknown> = { ...raw, edges: unioned }
  delete out.flow
  return out
}

function edgeKey(from: unknown, fromPort: unknown, to: unknown): string | null {
  if (typeof from !== "string" || typeof to !== "string") return null
  return `${from}::${typeof fromPort === "string" ? fromPort : ""}::${to}`
}

function prefix(opts: ParseYamlOptions): string {
  return opts.filePath ? `${opts.filePath}: ` : ""
}

/** Render a JSON workflow back to YAML. One-way (not lossless against
 *  `flow:` sugar — round-tripped output is always the canonical
 *  nodes/edges form). Used by `agentx workflow show --format yaml`. */
export function renderWorkflowYaml(workflow: unknown): string {
  return yaml.dump(workflow, { noRefs: true, lineWidth: 100, sortKeys: false })
}
