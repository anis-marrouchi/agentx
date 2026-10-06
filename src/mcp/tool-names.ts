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

/** The names in `list` that are not agentx tools. */
export function unknownAgentxTools(list: readonly string[]): string[] {
  const known = new Set(AGENTX_TOOL_NAMES)
  return list.map((t) => t.trim()).filter((t) => t && !known.has(t))
}
