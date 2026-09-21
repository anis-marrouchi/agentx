// --- example.com workspace tools (registered with the agentic loop) ---
//
// When an agent runs on behalf of an example.com user (e.g. the acme-public
// agent serving the on-site chat / voice path), we expose 7 server-side
// primitives as native Anthropic tools the model can call. The agentic
// loop dispatches them by POSTing to {ACME_API_URL}/api/agent/tools
// with the server-held AGENTX_TOOLS_SECRET — the bearer NEVER enters
// the model's prompt context.
//
// The catalog mirrors the example.com-side dispatcher in
// app/api/agent/tools/route.ts. Schemas must match — the agent will be
// confused if a field exists here but not there (or vice-versa).

import type { ToolDefinition } from "./definitions"

export const ACME_TOOL_NAMES = [
  "list_projects",
  "get_project",
  "create_task",
  "update_task",
  "add_deliverable",
  "list_attachments",
  "get_credit_balance",
] as const

export type AcmeToolName = typeof ACME_TOOL_NAMES[number]

export const ACME_TOOLS: ToolDefinition[] = [
  {
    name: "list_projects",
    description:
      "List the example.com user's active projects with per-project task counts. Use when the user asks 'what am I working on' or wants a project overview.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    permission: "none",
  },
  {
    name: "get_project",
    description:
      "Get a single project with its tasks and recent conversations. Use after list_projects when the user picks one.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID from list_projects." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    permission: "none",
  },
  {
    name: "create_task",
    description:
      "Queue a new task for the user. Use when they ask you to build, fix, or work on something. CONFIRM the summary verbally first.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short task description (one sentence)." },
        project_id: { type: "string", description: "Optional — bind to a project." },
        conversation_id: {
          type: "string",
          description: "Optional — bind to the on-site conversation id (from [Context]).",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    permission: "none",
  },
  {
    name: "update_task",
    description:
      "Update a task's state (mark completed, cancel, record hours, write a result_summary). Status: queued|active|completed|cancelled.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: {
          type: "string",
          enum: ["queued", "active", "completed", "cancelled"],
        },
        summary: { type: "string" },
        result_summary: { type: "string" },
        hours_spent: { type: "number" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    permission: "none",
  },
  {
    name: "add_deliverable",
    description:
      "Record a shipped artefact against a task (repo URL, preview URL, design file, document, etc.). type: repo|preview|design|artifact|document|screenshot|figma|spreadsheet|presentation|video|audio|image|other.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        type: {
          type: "string",
          enum: [
            "repo", "preview", "design", "artifact", "document", "screenshot",
            "figma", "spreadsheet", "presentation", "video", "audio", "image", "other",
          ],
        },
        label: { type: "string", description: "Human label, e.g. 'Staging — workspace v2'." },
        url: { type: "string", description: "Public URL of the artefact." },
        file_size: { type: "number" },
      },
      required: ["task_id", "type", "label", "url"],
      additionalProperties: false,
    },
    permission: "none",
  },
  {
    name: "list_attachments",
    description:
      "List files the user has uploaded to the workspace. Filter by project_id and/or task_id.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
      },
      additionalProperties: false,
    },
    permission: "none",
  },
  {
    name: "get_credit_balance",
    description:
      "Get the user's live credit balance and 7-day burn rate. Use when the user asks 'how much do I have left' or before starting a big task.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    permission: "none",
  },
]

export interface AcmeToolContext {
  /** The example.com user UUID this tool call impersonates. */
  userId: string
  /** Logical agent id (for the audit table's X-Agent-Id column). */
  agentId?: string
  /** Override the example.com base URL — defaults to ACME_API_URL env or https://example.com. */
  apiUrl?: string
}

/**
 * Execute an acme-tool by POSTing to /api/agent/tools with the server-
 * held bearer. The bearer is read from env at call time (not embedded
 * in prompts). Returns the raw response body as a string for the
 * agentic loop's tool_result block.
 */
export async function executeAcmeTool(
  toolName: AcmeToolName | string,
  input: Record<string, unknown>,
  ctx: AcmeToolContext,
): Promise<{ content: string; is_error: boolean }> {
  const bearer =
    process.env.ACME_AGENT_TOOLS_SECRET ||
    process.env.AGENTX_TOOLS_SECRET ||
    process.env.TELEGRAM_BOT_API_SECRET
  if (!bearer) {
    return {
      content: JSON.stringify({ ok: false, error: "ACME_AGENT_TOOLS_SECRET not set on this host" }),
      is_error: true,
    }
  }
  const baseUrl = ctx.apiUrl || process.env.ACME_API_URL || "https://example.com"
  const url = `${baseUrl.replace(/\/$/, "")}/api/agent/tools`

  const body = { tool: toolName, user_id: ctx.userId, ...(input || {}) }

  // Hard timeout on the HTTP call. Without this, a slow or hung
  // /api/agent/tools response stalls the agentic loop indefinitely
  // (observed in prod: two voice turns stuck for 71+ min on the same
  // conversation before a manual daemon restart). 30s is generous for
  // a DB-backed RPC; the tool itself is supposed to be sub-second.
  // Tunable via ACME_TOOL_TIMEOUT_MS env.
  const timeoutMs = Number(process.env.ACME_TOOL_TIMEOUT_MS || 30_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Agent-Id": ctx.agentId || "acme-public",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    const MAX = 4 * 1024
    const trimmed = text.length > MAX ? text.slice(0, MAX) + "…(truncated)" : text
    if (!res.ok) {
      return { content: trimmed, is_error: true }
    }
    return { content: trimmed, is_error: false }
  } catch (err: any) {
    const aborted = err?.name === "AbortError"
    return {
      content: JSON.stringify({
        ok: false,
        error: aborted ? `acme tool RPC timed out after ${timeoutMs}ms` : "acme tool RPC failed",
        detail: err?.message || "unknown",
      }),
      is_error: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function isAcmeTool(name: string): name is AcmeToolName {
  return (ACME_TOOL_NAMES as readonly string[]).includes(name)
}
