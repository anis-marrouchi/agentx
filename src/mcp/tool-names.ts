/** Every tool the agentx MCP server (src/mcp/index.ts) defines, by name.
 *  Kept apart from that file so config validation can check a name
 *  without loading the server. test/session-profile-agentx-tools.test.ts
 *  fails when the two drift. */
export const AGENTX_TOOL_NAMES: readonly string[] = [
  "agentx_generate",
  "agentx_inspect",
  "agentx_skill_match",
  "agentx_detect_output_type",
  "agentx_channel_reply",
  "agentx_channel_label",
  "agentx_send",
  "agentx_send_agent",
  "agentx_recent",
  "agentx_events",
  "agentx_send_contact",
  "agentx_task",
  "agentx_agents",
  "agentx_voice_queue",
  "agentx_call_owner",
  "agentx_camera_ask",
  "agentx_camera_look",
  "agentx_health",
  "agentx_attach_next",
  "agentx_attach_answer",
  "agentx_crons",
  "agentx_schedule",
  "agentx_approval",
  "agentx_request",
  "agentx_debug",
  "agentx_wiki_query",
  "agentx_wiki_patch",
  "agentx_wiki_interview",
  "agentx_graph_review",
]

/** The tool sets `agentx serve --tools <set>` offers (#794). `full` is
 *  every tool and the default. */
export const MCP_TOOL_SETS = ["read", "full"] as const
export type McpToolSet = (typeof MCP_TOOL_SETS)[number]

/** The `read` set: tools that look but change nothing. They send no
 *  message, start no task, edit no file and switch nothing on or off. */
export const READ_TOOL_NAMES: readonly string[] = [
  "agentx_inspect",
  "agentx_skill_match",
  "agentx_detect_output_type",
  "agentx_recent",
  "agentx_events",
  "agentx_agents",
  "agentx_voice_queue",
  "agentx_health",
  "agentx_crons",
  "agentx_wiki_query",
]

export function isMcpToolSet(value: unknown): value is McpToolSet {
  return typeof value === "string" && (MCP_TOOL_SETS as readonly string[]).includes(value)
}

/** The names in `list` that are not agentx tools. */
export function unknownAgentxTools(list: readonly string[]): string[] {
  const known = new Set(AGENTX_TOOL_NAMES)
  return list.map((t) => t.trim()).filter((t) => t && !known.has(t))
}
