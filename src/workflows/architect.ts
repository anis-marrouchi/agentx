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
- Prefer LINEAR workflows. Use branch ONLY when the procedure had a clear conditional fork that future runs will also need (e.g. "if migration → backup db first; else skip"). Don't invent branches the trace didn't actually exercise.
- Use deterministic node types (action.run, action.builtin, transform) when the work is mechanical.
- Use an "agent" node only when the step genuinely requires LLM reasoning (drafting prose, classifying intent, synthesizing output).
- Parameterize specific values with template placeholders: {{trigger.input.issueId}}, {{trigger.input.message}}, {{previousNodeId.outputField}}.

Available node types and their configs:
- trigger.manual         config: { inputSchema?: JSON-schema-like }
- agent                  config: { agentId: string, prompt: string }
- transform              config: { expression: string }                  (jq-style data shaping)
- action.run             config: { command: string }                     (shell, supports {{templates}})
- action.send            config: { channel: string, chatId: string, text: string }
- action.builtin         config: { name: string, input: object }         (e.g. name: "http.fetch")
- extract.structured     config: { prompt: string, schema: object }
- branch                 config: { cases: [{ when: <Condition>, to: <port-name> }, ...], default?: <port-name> }
- rule                   config: { rows: [...] }                         (DMN decision table)
- userTask               config: { form: object, assignee: string }
- checkpoint             config: { label: string }
- end                    config: { status: "completed"|"failed", output?: any }

Branch/rule mechanics — read carefully:
- The "to" field in cases is a PORT NAME (a string label), NOT a node id.
- Each outgoing edge from a branch must have fromPort equal to one of the port names declared in cases or in default.
- The edge.to field is the destination node id.

WORKED EXAMPLE — a deploy workflow with a conditional migration backup:
{
  "title": "MTGL deploy to staging",
  "description": "Pull master, optionally back up DB if migration, run migrations, rebuild caches.",
  "nodes": [
    { "id": "trigger",       "type": "trigger.manual", "config": {} },
    { "id": "pull",          "type": "action.run", "config": { "command": "ssh staging 'cd /var/www && git pull origin master'" } },
    { "id": "needs_backup",  "type": "branch", "config": { "cases": [{ "when": { "kind": "matches", "params": { "path": "pull.stdout", "pattern": "migrate" } }, "to": "yes" }], "default": "no" } },
    { "id": "backup_db",     "type": "action.run", "config": { "command": "ssh staging 'pg_dump app > /backups/{{trigger.input.timestamp}}.sql'" } },
    { "id": "migrate",       "type": "action.run", "config": { "command": "ssh staging 'cd /var/www && php artisan migrate --force'" } },
    { "id": "rebuild_cache", "type": "action.run", "config": { "command": "ssh staging 'cd /var/www && php artisan config:cache && php artisan route:cache'" } },
    { "id": "done",          "type": "end", "config": { "status": "completed" } }
  ],
  "edges": [
    { "from": "trigger",       "to": "pull" },
    { "from": "pull",          "to": "needs_backup" },
    { "from": "needs_backup",  "to": "backup_db",     "fromPort": "yes" },
    { "from": "needs_backup",  "to": "migrate",       "fromPort": "no"  },
    { "from": "backup_db",     "to": "migrate" },
    { "from": "migrate",       "to": "rebuild_cache" },
    { "from": "rebuild_cache", "to": "done" }
  ]
}

Notice: the branch's cases have to:"yes" and default:"no". The two outgoing edges have fromPort:"yes" and fromPort:"no" — matching the port names. Edge.to is always a node id.

Constraints:
- Exactly one trigger.* node and at least one "end" node.
- DAG only (no cycles).
- Every edge's from/to must reference an existing node id.
- Node ids match /^[a-z0-9][a-z0-9_]*$/.
- Don't invent fields not in the spec above. Don't add config keys you didn't see in this spec.`

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

/** Pull the first balanced JSON object out of free-form agent reply text.
 *  Agents tend to wrap JSON in fenced code blocks, prose preambles, or both.
 *  We scan for `{` and walk forward counting braces, ignoring braces inside
 *  string literals. Returns null if no balanced object is found. */
function extractFirstJsonObject(text: string): string | null {
  // Strip code fences first — they're the common case and the brace walker
  // doesn't need to handle them, but they're free to remove.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const haystack = fenced ? fenced[1] : text
  const start = haystack.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]
    if (escape) { escape = false; continue }
    if (ch === "\\" && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return haystack.slice(start, i + 1)
    }
  }
  return null
}

/** Dispatch a task to the agent registry over HTTP, ask the agent to emit
 *  workflow JSON, parse + validate. Same fallback semantics as the direct
 *  API path: throw on any failure so the caller can fall back to the
 *  deterministic single-node draft. Uses the daemon's POST /task endpoint
 *  rather than registry.execute() directly because the architect runs from
 *  the CLI process which doesn't have the registry in scope. */
async function callAgent(
  agentId: string,
  systemPrompt: string,
  userMessage: string,
  feedback: string | null,
  chatId: string,
  opts: { daemonUrl: string; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<{ data: ArchitectDraftShape; usage: { inputTokens: number; outputTokens: number } }> {
  // First-attempt: full system + spec + trace. Retry: short corrective
  // message — the agent already has its own prior reply in context via
  // claude --resume, so we don't need to repeat the spec. Stable chatId
  // (passed in from the caller) keeps both calls in the same session.
  const fullMessage = feedback
    ? [
        `Your previous response failed workflow-schema validation with these issues:`,
        feedback,
        ``,
        `Re-emit the corrected workflow as a single JSON object — same shape as before, but fix the listed issues. No prose, no code fences.`,
      ].join("\n")
    : [
        systemPrompt,
        "",
        "---",
        "",
        "Task trace to architect:",
        "",
        userMessage,
        "",
        "---",
        "",
        `Reply with ONLY a JSON object matching this shape (no prose, no fenced code block, no commentary):`,
        `{`,
        `  "title": "<short title>",`,
        `  "description": "<short description>",`,
        `  "nodes": [{ "id": "...", "type": "...", "config": {} }, ...],`,
        `  "edges": [{ "from": "...", "to": "...", "fromPort": "..." (optional), "label": "..." (optional) }, ...]`,
        `}`,
      ].join("\n")

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  let res: Response
  try {
    res = await opts.fetchImpl(`${opts.daemonUrl.replace(/\/+$/, "")}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentId,
        message: fullMessage,
        // Only the first call uses freshSession — the retry needs to see
        // the agent's prior reply (via --resume replay) so it can fix
        // its own output rather than start over from scratch.
        freshSession: feedback === null,
        context: { channel: "api", chatId },
      }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    throw new Error(`agent /task ${res.status}: ${errBody.slice(0, 500)}`)
  }
  const body: any = await res.json()
  const content = String(body.content ?? "").trim()
  if (body.error) throw new Error(`agent reported error: ${body.error}`)
  if (!content) throw new Error("agent returned empty content")

  const jsonStr = extractFirstJsonObject(content)
  if (!jsonStr) throw new Error(`agent reply has no JSON object (first 200 chars: ${content.slice(0, 200)})`)
  let parsed: unknown
  try { parsed = JSON.parse(jsonStr) } catch (e: any) {
    throw new Error(`agent reply JSON is unparseable: ${e.message}`)
  }
  if (!parsed || typeof parsed !== "object") throw new Error("agent reply is not a JSON object")
  const data = parsed as ArchitectDraftShape
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error("agent reply missing nodes/edges arrays")
  }

  const usage = body.usage ?? {}
  return {
    data,
    usage: {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    },
  }
}

/** Architect a workflow via the agent registry instead of direct Anthropic
 *  API. Mirrors `architectWorkflowFromTrace` but routes the LLM call through
 *  POST /task → registry.execute → claude-code subprocess (or codex-cli).
 *  Operators don't need a raw ANTHROPIC_API_KEY — the agent's own session
 *  token handles auth. Trade-off: ~5-10s per call vs ~2s for direct API,
 *  fine for cron use. */
export async function architectWorkflowViaAgent(
  trace: TraceRecord,
  steps: TraceStepRecord[],
  inferredId: string,
  sourceTaskIds: string[],
  confidence: number,
  opts: { agentId: string; daemonUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = { agentId: "" },
): Promise<{ workflow: Workflow; usage: { inputTokens: number; outputTokens: number }; via: string }> {
  if (!opts.agentId) throw new Error("architectWorkflowViaAgent: agentId is required")
  const daemonUrl = opts.daemonUrl || "http://127.0.0.1:18800"
  const fetchImpl = opts.fetchImpl || fetch
  const callOpts = {
    daemonUrl,
    timeoutMs: opts.timeoutMs ?? 180_000, // 3 min — agent dispatch is slower than direct API
    fetchImpl,
  }
  const userMessage = summarizeTraceForPrompt(trace, steps)
  // Stable per-trace chatId so the retry's --resume replay surfaces the
  // agent's first reply. SessionStore keys on (agentId, channel, chatId);
  // sessions persist past the call but the unique-per-trace shape means
  // unrelated absorbs don't share context.
  const chatId = `architect-${trace.taskId.toLowerCase()}`

  const first = await callAgent(opts.agentId, ARCHITECT_SYSTEM, userMessage, null, chatId, callOpts)
  let usage = first.usage
  let raw = first.data

  let workflow: Workflow
  try {
    workflow = assembleWorkflow(raw, trace, steps, inferredId, sourceTaskIds, confidence)
    const lintIssues = lintWorkflow(workflow)
    if (lintIssues.length) throw new Error(`lint: ${lintIssues.join("; ")}`)
    return { workflow, usage, via: `agent:${opts.agentId}` }
  } catch (err: any) {
    const retry = await callAgent(opts.agentId, ARCHITECT_SYSTEM, userMessage, err.message, chatId, callOpts)
    raw = retry.data
    usage = {
      inputTokens: usage.inputTokens + retry.usage.inputTokens,
      outputTokens: usage.outputTokens + retry.usage.outputTokens,
    }
    workflow = assembleWorkflow(raw, trace, steps, inferredId, sourceTaskIds, confidence)
    const lintIssues = lintWorkflow(workflow)
    if (lintIssues.length) throw new Error(`agent architect retry still invalid: ${lintIssues.join("; ")}`)
    return { workflow, usage, via: `agent:${opts.agentId}` }
  }
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
