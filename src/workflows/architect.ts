import type { TraceRecord, TraceStepRecord } from "@/storage/traces"
import { lintWorkflow, workflowSchema, type Workflow } from "./types"

// --- LLM workflow architect ---
//
// The deterministic draft path produces a 3-node workflow: trigger → agent
// → end, with the entire procedure crammed into the agent's prompt. That's
// useful as a sanity-check skeleton but un-edittable in any meaningful
// way — there's no DAG structure for an operator to refine.
//
// This module asks an LLM to do the structural work: read the trace + step
// list, group related tool calls into semantic nodes, identify branching
// points, and emit a proper workflow DAG. We force tool_use so the response
// is structured JSON, validate against `workflowSchema`, and retry once
// with the validation errors as feedback if the first attempt failed.
//
// Failure modes:
//   - ANTHROPIC_API_KEY missing → throw (caller falls back to deterministic)
//   - API error / timeout → throw (caller falls back to deterministic)
//   - Both attempts produce schema-invalid workflows → throw (caller falls back)
//
// Why direct API instead of the agent registry: same reasoning as
// extract.structured — registry routing keeps a turn slot busy for >2s on
// warm cache, the SDK adds 10MB+ of dependencies, and the auth path
// (ANTHROPIC_API_KEY) is identical.

export interface ArchitectOptions {
  /** Anthropic model id. Defaults to claude-sonnet-4-6 — sonnet handles
   *  multi-step decomposition well; haiku is cheaper but tends to flatten
   *  branches. */
  model?: string
  /** Per-call timeout for each Anthropic round-trip. Default 90s. */
  timeoutMs?: number
  /** Cap output tokens. Default 4000 — enough for ~30-node workflows. */
  maxTokens?: number
  /** Hook used by tests to inject a fake fetch. Production uses global fetch. */
  fetchImpl?: typeof fetch
}

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const DEFAULT_MODEL = "claude-sonnet-4-6"

const ARCHITECT_SYSTEM = `You are a workflow architect for AgentX. Given a successful task trace, decompose it into a reusable workflow DAG that captures the procedure WITHOUT specific values that wouldn't apply to a future similar task.

Decomposition rules:
- Group related tool calls into one semantic node. Five Bash calls that pull a repo, install deps, run migrations, restart services, and verify status are ONE deploy node, not five.
- Use deterministic node types (action.run, action.builtin, transform, branch) when the work is mechanical.
- Use an "agent" node only when the step genuinely requires LLM reasoning (drafting prose, classifying intent, synthesizing output).
- Identify branching points: was there a conditional path the agent took based on the previous result? Model with a "branch" node and edges with fromPort labels.
- Parameterize specific values with template placeholders: {{trigger.input.issueId}}, {{trigger.input.message}}, {{previousNodeId.outputField}}.

Available node types:
- trigger.manual    config: { inputSchema: JSON-Schema-like }
- agent             config: { agentId, prompt }
- transform         config: { expression }            (jq-style)
- branch            config: { cases: [{ when, port }] }
- rule              config: { rows: [...] }           (DMN decision table)
- action.run        config: { command }               (shell)
- action.send       config: { channel, chatId, text }
- action.builtin    config: { name, input }           (typed built-in actions)
- extract.structured config: { prompt, schema }
- userTask          config: { form, assignee }
- checkpoint        config: { label }
- end               config: { status, output }

Edges connect nodes. Use fromPort for branch/rule outputs. Node ids must match /^[a-z0-9_]+$/.

Constraints:
- Exactly one trigger.* node, at least one "end" node, and the graph must be a DAG (no cycles).
- Every edge's from/to must reference an existing node id.
- Don't invent fields not in the spec above.`

/** JSON-Schema fed to the Anthropic forced tool_use. Shape mirrors the
 *  subset of workflowSchema that the LLM should produce — the rest of the
 *  workflow (status, sourceTaskIds, etc.) is filled in by the caller. */
const ARCHITECT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["title", "description", "nodes", "edges"],
  properties: {
    title: { type: "string", maxLength: 120 },
    description: { type: "string", maxLength: 600 },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: 30,
      items: {
        type: "object",
        required: ["id", "type", "config"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9_]*$", maxLength: 48 },
          type: {
            type: "string",
            enum: [
              "trigger.manual",
              "agent",
              "transform",
              "branch",
              "rule",
              "action.run",
              "action.send",
              "action.builtin",
              "extract.structured",
              "userTask",
              "checkpoint",
              "end",
            ],
          },
          config: { type: "object" },
        },
      },
    },
    edges: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          fromPort: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
}

function cap(s: string | null | undefined, n: number): string {
  const t = String(s ?? "").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function summarizeTraceForPrompt(trace: TraceRecord, steps: TraceStepRecord[]): string {
  const useful = steps.filter((s) => s.status !== "error" && s.name !== "system").slice(0, 40)
  const lines = useful.map((s, i) => {
    const label = [s.name, s.action].filter(Boolean).join(":")
    const inSummary = cap(s.inputSummary || "", 280)
    const outSummary = cap(s.outputSummary || "", 280)
    const parts = [inSummary && `in=${inSummary}`, outSummary && `out=${outSummary}`].filter(Boolean).join(" | ")
    return `${i + 1}. ${label}${parts ? `  ${parts}` : ""}`
  })
  return [
    `Original task message:`,
    cap(trace.messagePreview || "", 600),
    ``,
    `Agent: ${trace.agentId} (channel=${trace.channel || "unknown"}, chatId=${trace.chatId || "—"})`,
    `Outcome: ${trace.status}, steps=${steps.length}`,
    ``,
    `Procedure evidence (filtered, in order):`,
    ...lines,
  ].join("\n")
}

interface ArchitectDraftShape {
  title: string
  description: string
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; fromPort?: string; label?: string }>
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  feedback: string | null,
  opts: { maxTokens: number; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<{ data: ArchitectDraftShape; usage: { inputTokens: number; outputTokens: number } }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: userMessage },
  ]
  if (feedback) {
    messages.push({
      role: "assistant",
      content: "(previous attempt; will retry with corrections)",
    })
    messages.push({ role: "user", content: feedback })
  }

  const requestBody = {
    model,
    max_tokens: opts.maxTokens,
    system: systemPrompt,
    messages,
    tools: [{
      name: "emit_workflow",
      description: "Return the workflow DAG. Must be valid against the schema.",
      input_schema: ARCHITECT_OUTPUT_SCHEMA,
    }],
    tool_choice: { type: "tool", name: "emit_workflow" },
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  let res: Response
  try {
    res = await opts.fetchImpl(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(requestBody),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    throw new Error(`anthropic API ${res.status}: ${errBody.slice(0, 500)}`)
  }
  const body: any = await res.json()
  const blocks = Array.isArray(body.content) ? body.content : []
  const toolUse = blocks.find((b: any) => b?.type === "tool_use" && b?.name === "emit_workflow")
  if (!toolUse || !toolUse.input) {
    throw new Error("anthropic API returned no emit_workflow tool_use")
  }
  const usage = body.usage ?? {}
  return {
    data: toolUse.input as ArchitectDraftShape,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  }
}

function assembleWorkflow(
  raw: ArchitectDraftShape,
  trace: TraceRecord,
  steps: TraceStepRecord[],
  inferredId: string,
  sourceTaskIds: string[],
  confidence: number,
): Workflow {
  const channelTags = new Set<string>()
  if (trace.channel) channelTags.add(trace.channel)
  for (const s of steps) {
    if (s.action) channelTags.add(s.action.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
  }
  return workflowSchema.parse({
    id: inferredId,
    version: 2,
    title: cap(raw.title, 120) || `Draft: ${cap(trace.messagePreview, 72) || trace.taskId.slice(0, 8)}`,
    description: cap(raw.description, 600) || `LLM-architected from task trace ${trace.taskId}.`,
    status: "draft",
    state: "disabled",
    tags: Array.from(channelTags).slice(0, 12),
    entity: trace.chatId || undefined,
    generatedFrom: "llm-architect",
    sourceTaskIds,
    confidence,
    workflowVersion: "draft-1",
    ownerAgent: trace.agentId,
    nodes: raw.nodes,
    edges: raw.edges,
    envAllow: [],
    retention: { maxRuns: 500, maxDays: 90 },
    maxChildDepth: 5,
  })
}

/** Architect a workflow from a task trace using an LLM. Throws on any
 *  failure (caller falls back to deterministic single-node draft). */
export async function architectWorkflowFromTrace(
  trace: TraceRecord,
  steps: TraceStepRecord[],
  inferredId: string,
  sourceTaskIds: string[],
  confidence: number,
  opts: ArchitectOptions = {},
): Promise<{ workflow: Workflow; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set; LLM architect unavailable")

  const model = opts.model || DEFAULT_MODEL
  const fetchImpl = opts.fetchImpl || fetch
  const callOpts = {
    maxTokens: opts.maxTokens ?? 4000,
    timeoutMs: opts.timeoutMs ?? 90_000,
    fetchImpl,
  }

  const userMessage = summarizeTraceForPrompt(trace, steps)

  // First attempt.
  const firstAttempt = await callAnthropic(apiKey, model, ARCHITECT_SYSTEM, userMessage, null, callOpts)
  let raw = firstAttempt.data
  let usage = firstAttempt.usage

  let workflow: Workflow
  try {
    workflow = assembleWorkflow(raw, trace, steps, inferredId, sourceTaskIds, confidence)
    const lintIssues = lintWorkflow(workflow)
    if (lintIssues.length) throw new Error(`lint: ${lintIssues.join("; ")}`)
    return { workflow, usage, model }
  } catch (err: any) {
    // Retry once with structured feedback so the model can correct.
    const feedback = `Your previous response failed validation: ${err.message}. Re-emit emit_workflow with the corrections. Keep the same overall structure but fix the listed issues.`
    const retry = await callAnthropic(apiKey, model, ARCHITECT_SYSTEM, userMessage, feedback, callOpts)
    raw = retry.data
    usage = {
      inputTokens: usage.inputTokens + retry.usage.inputTokens,
      outputTokens: usage.outputTokens + retry.usage.outputTokens,
    }
    workflow = assembleWorkflow(raw, trace, steps, inferredId, sourceTaskIds, confidence)
    const lintIssues = lintWorkflow(workflow)
    if (lintIssues.length) throw new Error(`LLM architect retry still invalid: ${lintIssues.join("; ")}`)
    return { workflow, usage, model }
  }
}
