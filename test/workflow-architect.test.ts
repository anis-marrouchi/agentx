import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TraceRecord, TraceStepRecord } from "../src/storage/traces"
import { architectWorkflowFromTrace } from "../src/workflows/architect"
import { architectOrBuildDraft } from "../src/workflows/absorb"

// --- Architect path tests ---
//
// We never call the real Anthropic API in tests — too slow, costs money,
// non-deterministic. Inject a fake fetch via the architect's `fetchImpl`
// hook (or via a wrapper around architectOrBuildDraft).
//
// What we lock in:
//   - Happy path: fake API returns a valid DAG → architect returns it
//     wrapped as a Workflow with the right metadata (id, sourceTaskIds,
//     generatedFrom, ownerAgent).
//   - Schema-fail-then-retry: first response is invalid, second is valid,
//     architect succeeds and combines token usage.
//   - Schema-fail twice: throws so caller can fall back.
//   - Missing API key: throws immediately.
//   - architectOrBuildDraft falls back to deterministic on any architect
//     failure (we cause failure by clearing ANTHROPIC_API_KEY).

const TRACE: TraceRecord = {
  taskId: "01TASK000000000000000000",
  agentId: "devops-agent",
  channel: "gitlab",
  chatId: "mtgl/mtgl_system:merge_request:959",
  messagePreview: "Deploy MR #959 to staging",
  status: "ok",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  durationMs: 10_000,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  totalTokens: 1200,
  model: "claude-sonnet-4-6",
  errorKind: undefined,
  errorMessage: undefined,
  workflowRunId: undefined,
  workflowId: undefined,
  workflowNodeId: undefined,
  parentTaskId: undefined,
  intentLedgerEventId: undefined,
}

const STEPS: TraceStepRecord[] = [
  { taskId: TRACE.taskId, seq: 1, at: 1_700_000_001_000, name: "tool_use", action: "Bash", status: "ok", inputSummary: "git pull", outputSummary: "ok", error: undefined, durationMs: 100 },
  { taskId: TRACE.taskId, seq: 2, at: 1_700_000_002_000, name: "tool_use", action: "Bash", status: "ok", inputSummary: "php artisan migrate", outputSummary: "ok", error: undefined, durationMs: 500 },
]

const VALID_DAG = {
  title: "MTGL MR deploy to staging",
  description: "Pull latest master, run migrations, restart services.",
  nodes: [
    { id: "trigger", type: "trigger.manual", config: { inputSchema: { type: "object" } } },
    { id: "deploy", type: "action.run", config: { command: "ssh staging \"cd /var/www && git pull && php artisan migrate --force\"" } },
    { id: "done", type: "end", config: { status: "completed", output: "{{deploy.stdout}}" } },
  ],
  edges: [
    { from: "trigger", to: "deploy" },
    { from: "deploy", to: "done" },
  ],
}

const INVALID_DAG = {
  title: "Bad DAG",
  description: "Missing trigger",
  nodes: [
    { id: "deploy", type: "action.run", config: { command: "echo" } },
    { id: "done", type: "end", config: {} },
  ],
  edges: [{ from: "deploy", to: "done" }],
}

function fakeAnthropicResponse(toolInput: unknown, usage = { input_tokens: 100, output_tokens: 50 }) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", name: "emit_workflow", input: toolInput }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-fake-key")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("architectWorkflowFromTrace", () => {
  it("emits a valid Workflow when the API returns a valid DAG", async () => {
    const fetchImpl = vi.fn(async () => fakeAnthropicResponse(VALID_DAG))
    const result = await architectWorkflowFromTrace(
      TRACE, STEPS, "mtgl-system-mr-deploy-staging-draft", [TRACE.taskId], 0.85,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result.workflow.id).toBe("mtgl-system-mr-deploy-staging-draft")
    expect(result.workflow.generatedFrom).toBe("llm-architect")
    expect(result.workflow.sourceTaskIds).toEqual([TRACE.taskId])
    expect(result.workflow.confidence).toBeCloseTo(0.85)
    expect(result.workflow.ownerAgent).toBe("devops-agent")
    expect(result.workflow.nodes.find((n) => n.type === "action.run")).toBeTruthy()
    expect(result.workflow.nodes.find((n) => n.type === "agent")).toBeUndefined()
    expect(result.usage.inputTokens).toBe(100)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("retries once with feedback when the first attempt is schema-invalid", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeAnthropicResponse(INVALID_DAG, { input_tokens: 100, output_tokens: 50 }))
      .mockResolvedValueOnce(fakeAnthropicResponse(VALID_DAG, { input_tokens: 110, output_tokens: 60 }))
    const result = await architectWorkflowFromTrace(
      TRACE, STEPS, "test-draft", [TRACE.taskId], 0.7,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result.workflow.id).toBe("test-draft")
    expect(result.usage.inputTokens).toBe(210) // sum of both attempts
    expect(result.usage.outputTokens).toBe(110)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Second call should include the feedback message.
    const secondCallBody = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string)
    expect(secondCallBody.messages.length).toBeGreaterThan(1)
    expect(JSON.stringify(secondCallBody.messages)).toMatch(/failed validation/i)
  })

  it("throws when both attempts produce invalid DAGs", async () => {
    const fetchImpl = vi.fn(async () => fakeAnthropicResponse(INVALID_DAG))
    await expect(architectWorkflowFromTrace(
      TRACE, STEPS, "test-draft", [TRACE.taskId], 0.7,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )).rejects.toThrow(/architect/i)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    await expect(architectWorkflowFromTrace(
      TRACE, STEPS, "test-draft", [TRACE.taskId], 0.7,
    )).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})

describe("architectOrBuildDraft fallback", () => {
  it("falls back to deterministic when no model is provided", async () => {
    const result = await architectOrBuildDraft(TRACE, STEPS, {})
    expect(result.usedLlm).toBe(false)
    // Deterministic shape: trigger → run_cleaned_task (agent) → done
    const agentNode = result.workflow.nodes.find((n) => n.type === "agent")
    expect(agentNode?.id).toBe("run_cleaned_task")
    expect(result.workflow.generatedFrom).toBe("task-trace")
  })

  it("falls back to deterministic when the architect path throws (no API key)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    const logs: string[] = []
    const result = await architectOrBuildDraft(TRACE, STEPS, {
      model: "claude-sonnet-4-6",
      log: (m) => logs.push(m),
    })
    expect(result.usedLlm).toBe(false)
    expect(result.error).toMatch(/ANTHROPIC_API_KEY/)
    expect(logs.some((l) => l.includes("falling back"))).toBe(true)
    // Falls back to single-agent-node draft.
    const agentNode = result.workflow.nodes.find((n) => n.type === "agent")
    expect(agentNode?.id).toBe("run_cleaned_task")
  })
})
