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

export type SessionProfileName = "full" | "lean"

export type SettingSource = "user" | "project" | "local"

export interface LeanProfileConfig {
  mcpServers: string[]
  settingSources: SettingSource[]
  contextOnDemand: boolean
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
): McpServerMap {
  const declared = readWorkspaceMcp(workspace)
  const kept: McpServerMap = {}
  for (const name of lean.mcpServers) {
    if (declared[name]) kept[name] = declared[name]
  }
  if (!kept.agentx) kept.agentx = declared.agentx ?? agentx
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
): string[] {
  const mcp = leanMcpServers(workspace, lean, agentx)
  return [
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: mcp }),
    "--setting-sources", lean.settingSources.join(","),
  ]
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
export function describeProfile(profile: SessionProfileName, lean: LeanProfileConfig): string {
  if (profile === "full") return "full"
  const parts = [
    `mcp=${lean.mcpServers.join("+") || "agentx"}`,
    `settings=${lean.settingSources.join(",") || "none"}`,
    lean.contextOnDemand ? "context=on-demand" : "context=pushed",
  ]
  return `lean (${parts.join(" ")})`
}
