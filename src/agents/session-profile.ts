import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { agentxToolServer, type McpServerConfig, type McpServerMap } from "./agent-mcp"

// --- Session profiles (#615) ---
//
// A session's first turn used to carry the same start whatever started it:
// every MCP server the user has, every user-level skill and plugin, the
// global CLAUDE.md, plus the landscape, chat history and cross-chat
// context AgentX pushes into the prompt. A GitHub label event or a one-line
// agent-to-agent reply paid all of it. The `lean` profile gives such
// sessions only what the task needs up front and leaves the rest a tool
// call away:
//
//   claude flags   --strict-mcp-config --mcp-config {agentx (+ named)}
//                  --setting-sources project,local
//   prompt         no landscape / history / cross-chat; one line names the
//                  agentx MCP tools that fetch each on demand
//   system prompt  the project CLAUDE.md is not appended when Claude Code
//                  loads it from the workspace itself
//
// Chat channels (telegram, whatsapp, voice, dashboard …) keep the `full`
// start; only the channels listed in `session.profileByChannel`, or in
// DEFAULT_LEAN_CHANNELS when unlisted, are lean.
//
// A full claude-code session gets one flag of its own (#668): `--mcp-config`
// with this install's agentx tool server, on top of whatever the user and
// the workspace load. Without it the tools (agentx_approval among them)
// depended on the workspace .mcp.json being both written and approved,
// which a node with no user-level MCP servers never had.

export type SessionProfileName = "full" | "lean"

export type SettingSource = "user" | "project" | "local"

export interface LeanProfileConfig {
  mcpServers: string[]
  settingSources: SettingSource[]
  contextOnDemand: boolean
  /** Built-in Claude Code tools a lean session gets (`--tools`). Empty:
   *  every built-in tool, as today. The built-in tool schemas are about
   *  14k tokens of the first turn, so this is the lever that gets a lean
   *  start under 20k; an agent that lacks a tool it needs fails mid-task,
   *  so lists stay opt-in. */
  tools: string[]
  /** Per-channel tool lists; a non-empty entry wins over `tools`. */
  toolsByChannel: Record<string, string[]>
  /** The `agentx_` MCP tools a lean session lists (#696). Empty: every
   *  agentx tool, as today. Their descriptions are about 10k tokens of a
   *  lean first turn on Claude Code 2.1.291, now the largest share, so a
   *  short list is the next lever after `tools`. Opt-in for the same
   *  reason. */
  agentxTools: string[]
  /** Per-channel agentx tool lists; a non-empty entry wins over
   *  `agentxTools`. */
  agentxToolsByChannel: Record<string, string[]>
}

export interface SessionProfileConfig {
  profileByChannel: Record<string, SessionProfileName>
  lean: LeanProfileConfig
}

/** Channels that are lean unless `session.profileByChannel` says otherwise. */
export const DEFAULT_LEAN_CHANNELS: readonly string[] = ["github", "a2a", "workflow", "cron"]

/** Tiers whose sessions can reach the agentx MCP tools, so a lean start
 *  can hand them context on demand. Other tiers always start full. */
const LEAN_CAPABLE_TIERS: readonly string[] = ["claude-code", "codex-cli"]

export const DEFAULT_LEAN: LeanProfileConfig = {
  mcpServers: ["agentx"],
  settingSources: ["project", "local"],
  contextOnDemand: true,
  tools: [],
  toolsByChannel: {},
  agentxTools: [],
  agentxToolsByChannel: {},
}

/** The agentx tool server reads its tool list from this variable. */
export const AGENTX_MCP_TOOLS_ENV = "AGENTX_MCP_TOOLS"

/** agentx tools a shortened list always keeps: daemon prompts ask for
 *  them by name (request follow-ups, approval cards), whatever started
 *  the session. */
const AGENTX_CORE_TOOLS: readonly string[] = ["agentx_approval", "agentx_request"]

/** The tools the `[Context on demand]` line names; kept whenever a lean
 *  start relies on that line. */
const AGENTX_ON_DEMAND_TOOLS: readonly string[] = ["agentx_agents", "agentx_recent", "agentx_wiki_query"]

/** The built-in tools a lean session on `channel` gets: the channel's own
 *  list when one is set, else the shared `tools` list. Empty means every
 *  built-in tool (no `--tools` flag). An all-tools-off list is never
 *  produced: `--tools ""` is not a saving, it makes Claude Code load every
 *  MCP tool schema instead. */
export function leanTools(lean: LeanProfileConfig, channel?: string): string[] {
  const own = channel ? lean.toolsByChannel?.[channel] : undefined
  const list = own && own.length ? own : (lean.tools ?? [])
  return Array.from(new Set(list.map((t) => t.trim()).filter(Boolean)))
}

/** The agentx MCP tools a lean session on `channel` lists: the channel's
 *  own list when one is set, else the shared `agentxTools` list, plus the
 *  tools daemon prompts name (AGENTX_CORE_TOOLS, and the on-demand context
 *  tools when `contextOnDemand` is on). Empty means every agentx tool. */
export function leanAgentxTools(lean: LeanProfileConfig, channel?: string): string[] {
  const own = channel ? lean.agentxToolsByChannel?.[channel] : undefined
  const list = (own && own.length ? own : (lean.agentxTools ?? [])).map((t) => t.trim()).filter(Boolean)
  if (!list.length) return []
  const kept = [...AGENTX_CORE_TOOLS, ...(lean.contextOnDemand ? AGENTX_ON_DEMAND_TOOLS : []), ...list]
  return Array.from(new Set(kept))
}

/** `server` told to list only `tools`. Only a stdio server can be told:
 *  an http entry is returned as it is and lists every tool. */
export function withAgentxToolList(server: McpServerConfig, tools: string[]): McpServerConfig {
  if (!tools.length || server.type === "http") return server
  return { ...server, env: { ...(server.env ?? {}), [AGENTX_MCP_TOOLS_ENV]: tools.join(",") } }
}

/** The profile a channel's sessions start with. Listed channels win;
 *  unlisted ones fall back to DEFAULT_LEAN_CHANNELS. */
export function resolveSessionProfile(
  config: Partial<SessionProfileConfig> | undefined,
  channel: string,
  tier: string,
): SessionProfileName {
  if (!LEAN_CAPABLE_TIERS.includes(tier)) return "full"
  const listed = config?.profileByChannel?.[channel]
  if (listed) return listed
  return DEFAULT_LEAN_CHANNELS.includes(channel) ? "lean" : "full"
}

/** The lean settings with every default filled in. */
export function leanConfig(config: Partial<SessionProfileConfig> | undefined): LeanProfileConfig {
  return { ...DEFAULT_LEAN, ...(config?.lean ?? {}) }
}

/** Whether a lean session's Claude Code reads the workspace itself, so the
 *  project CLAUDE.md must not also be appended to the system prompt. */
export function leanLoadsWorkspace(lean: LeanProfileConfig): boolean {
  return lean.settingSources.includes("project")
}

/** The MCP servers a lean session loads: this install's `agentx` tool
 *  server plus the workspace .mcp.json entries named in `lean.mcpServers`.
 *  An operator-owned .mcp.json is read the same way; only the names decide. */
export function leanMcpServers(
  workspace: string,
  lean: LeanProfileConfig,
  agentx: McpServerConfig = agentxToolServer(),
  channel?: string,
): McpServerMap {
  const declared = readWorkspaceMcp(workspace)
  const kept: McpServerMap = {}
  for (const name of lean.mcpServers) {
    if (declared[name]) kept[name] = declared[name]
  }
  kept.agentx = withAgentxToolList(kept.agentx ?? declared.agentx ?? agentx, leanAgentxTools(lean, channel))
  return kept
}

function readWorkspaceMcp(workspace: string): McpServerMap {
  const file = resolve(workspace, ".mcp.json")
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    const servers = parsed?.mcpServers
    return servers && typeof servers === "object" ? servers as McpServerMap : {}
  } catch {
    return {}
  }
}

/** Flags appended to a lean `claude` spawn. `--strict-mcp-config` makes
 *  `--mcp-config` the only MCP source (no user-level connectors); the
 *  setting sources drop everything the operator's home directory would
 *  otherwise add. Resumed sessions carry them too: the flags describe the
 *  process, not the turn. */
export function leanClaudeArgs(
  workspace: string,
  lean: LeanProfileConfig,
  agentx: McpServerConfig = agentxToolServer(),
  channel?: string,
): string[] {
  const mcp = leanMcpServers(workspace, lean, agentx, channel)
  const args = [
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: mcp }),
    "--setting-sources", lean.settingSources.join(","),
  ]
  // Only ever next to --strict-mcp-config above: measured on its own,
  // `--tools` tripled the first turn by loading every MCP schema (#615).
  const tools = leanTools(lean, channel)
  if (tools.length) args.push("--tools", tools.join(","))
  return args
}

/** Flags appended to a full `claude` spawn: this install's agentx tool
 *  server, added to the user-level and workspace MCP servers rather than
 *  replacing them (no `--strict-mcp-config`). An `agentx` entry the
 *  operator declared in the workspace .mcp.json wins, as in lean sessions.
 *  Resumed sessions carry it too: the flag describes the process. */
export function fullClaudeArgs(
  workspace: string,
  agentx: McpServerConfig = agentxToolServer(),
): string[] {
  const declared = readWorkspaceMcp(workspace)
  return ["--mcp-config", JSON.stringify({ mcpServers: { agentx: declared.agentx ?? agentx } })]
}

/** The one line a lean prompt carries in place of the landscape, the chat
 *  history and the cross-chat context. Names the tool for each so the
 *  agent fetches only what the task turns out to need. */
export function onDemandContextNote(channel: string, chatId: string): string {
  return [
    "[Context on demand]",
    `Not pushed into this prompt, fetch with agentx MCP tools when the task needs them: ` +
    `the agent landscape (agentx_agents with landscape=true), ` +
    `earlier messages on this chat (agentx_recent with channel="${channel}", chatId="${chatId}"), ` +
    `today's other chats of yours (agentx_recent without chatId), ` +
    `and stored knowledge (agentx_wiki_query).`,
  ].join("\n")
}

/** What a lean start changes, for logs and the context benchmark. */
export function describeProfile(profile: SessionProfileName, lean: LeanProfileConfig, channel?: string): string {
  if (profile === "full") return "full"
  const parts = [
    `mcp=${lean.mcpServers.join("+") || "agentx"}`,
    `settings=${lean.settingSources.join(",") || "none"}`,
    lean.contextOnDemand ? "context=on-demand" : "context=pushed",
  ]
  const tools = leanTools(lean, channel)
  if (tools.length) parts.push(`tools=${tools.join("+")}`)
  const agentxTools = leanAgentxTools(lean, channel)
  if (agentxTools.length) parts.push(`agentx-tools=${agentxTools.length}`)
  return `lean (${parts.join(" ")})`
}
