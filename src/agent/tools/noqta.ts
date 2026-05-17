// --- noqta.tn workspace tools (registered with the agentic loop) ---
//
// When an agent runs on behalf of a noqta.tn user (e.g. the noqta-public
// agent serving the on-site chat / voice path), we expose 7 server-side
// primitives as native Anthropic tools the model can call. The agentic
// loop dispatches them by POSTing to {NOQTA_API_URL}/api/agent/tools
// with the server-held AGENTX_TOOLS_SECRET — the bearer NEVER enters
// the model's prompt context.
//
// The catalog mirrors the noqta.tn-side dispatcher in
// app/api/agent/tools/route.ts. Schemas must match — the agent will be
// confused if a field exists here but not there (or vice-versa).

import type { ToolDefinition } from "./definitions"

export const NOQTA_TOOL_NAMES = [
  "list_projects",
  "get_project",
  "create_task",
  "update_task",
  "add_deliverable",
  "list_attachments",
  "get_credit_balance",
] as const

export type NoqtaToolName = typeof NOQTA_TOOL_NAMES[number]

export const NOQTA_TOOLS: ToolDefinition[] = [
  {
    name: "list_projects",
    description:
      "List the noqta.tn user's active projects with per-project task counts. Use when the user asks 'what am I working on' or wants a project overview.",
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

export interface NoqtaToolContext {
  /** The noqta.tn user UUID this tool call impersonates. */
  userId: string
  /** Logical agent id (for the audit table's X-Agent-Id column). */
  agentId?: string
  /** Override the noqta.tn base URL — defaults to NOQTA_API_URL env or https://noqta.tn. */
  apiUrl?: string
}

/**
 * Execute a noqta-tool by POSTing to /api/agent/tools with the server-
 * held bearer. The bearer is read from env at call time (not embedded
 * in prompts). Returns the raw response body as a string for the
 * agentic loop's tool_result block.
 */
export async function executeNoqtaTool(
  toolName: NoqtaToolName | string,
  input: Record<string, unknown>,
  ctx: NoqtaToolContext,
): Promise<{ content: string; is_error: boolean }> {
  const bearer =
    process.env.NOQTA_AGENT_TOOLS_SECRET ||
    process.env.AGENTX_TOOLS_SECRET ||
    process.env.TELEGRAM_BOT_API_SECRET
  if (!bearer) {
    return {
      content: JSON.stringify({ ok: false, error: "NOQTA_AGENT_TOOLS_SECRET not set on this host" }),
      is_error: true,
    }
  }
  const baseUrl = ctx.apiUrl || process.env.NOQTA_API_URL || "https://noqta.tn"
  const url = `${baseUrl.replace(/\/$/, "")}/api/agent/tools`

  const body = { tool: toolName, user_id: ctx.userId, ...(input || {}) }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Agent-Id": ctx.agentId || "noqta-public",
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const MAX = 4 * 1024
    const trimmed = text.length > MAX ? text.slice(0, MAX) + "…(truncated)" : text
    if (!res.ok) {
      return { content: trimmed, is_error: true }
    }
    return { content: trimmed, is_error: false }
  } catch (err: any) {
    return {
      content: JSON.stringify({
        ok: false,
        error: "noqta tool RPC failed",
        detail: err?.message || "unknown",
      }),
      is_error: true,
    }
  }
}

export function isNoqtaTool(name: string): name is NoqtaToolName {
  return (NOQTA_TOOL_NAMES as readonly string[]).includes(name)
}
