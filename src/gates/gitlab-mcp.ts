/**
 * G1 (#2085 v3 Q, v4 U′): which MCP tools create a GitLab issue.
 *
 * A server is a GitLab server when its key, or its command, arguments or
 * URL, names GitLab (`noqta_gitlab_server`, `npx @zereight/mcp-gitlab`, a
 * `…/gitlab/mcp` URL). Its issue-create tool goes by one of a few names,
 * depending on the server package.
 */
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

/** Tool names a GitLab MCP server uses for "create an issue". */
export const GITLAB_CREATE_ISSUE_TOOLS = ["create_issue", "create_gitlab_issue", "gitlab_create_issue"] as const

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export interface McpServerSpec {
  command?: unknown
  args?: unknown
  url?: unknown
  allowTools?: string[]
}

export function isGitlabServer(name: string, spec?: McpServerSpec | null): boolean {
  if (/gitlab/i.test(name)) return true
  if (!spec || typeof spec !== "object") return false
  const words = [spec.command, ...(Array.isArray(spec.args) ? spec.args : []), spec.url]
  return words.some((w) => typeof w === "string" && /gitlab/i.test(w))
}

/** The GitLab servers of a server map, by key. */
export function gitlabServers(servers?: Record<string, McpServerSpec | null> | null): string[] {
  return Object.entries(servers ?? {}).filter(([name, spec]) => isGitlabServer(name, spec)).map(([name]) => name)
}

/** A server key that names GitLab, any case (hook matchers take no flags). */
const GITLAB_NAMED_SERVER = "[A-Za-z0-9_-]*[Gg][Ii][Tt][Ll][Aa][Bb][A-Za-z0-9_-]*"

/** An anchored hook matcher for the create tools of every server whose key
 *  names GitLab, wherever it is set up (agent config, workspace .mcp.json,
 *  user settings), plus the listed `servers`. Servers in `skip` are left
 *  out (they have a hook already). Never matches `create_issue_note`. */
export function gitlabCreateMatcher(servers: string[], skip: string[] = []): string {
  const names = [GITLAB_NAMED_SERVER, ...servers.filter((s) => !skip.includes(s)).map(escapeRe)]
  const not = skip.length ? `(?!(?:${skip.map(escapeRe).join("|")})__)` : ""
  return `^mcp__${not}(?:${names.join("|")})__(?:${GITLAB_CREATE_ISSUE_TOOLS.join("|")})$`
}

/** Is `tool` a GitLab issue create? A server whose key names GitLab is
 *  known by its name alone; any other must be in `servers` (the agent's
 *  configured GitLab servers). */
export function isGitlabCreateTool(tool: string, servers: string[] = []): boolean {
  const m = tool.match(/^mcp__(.+)__([A-Za-z0-9_]+)$/)
  if (!m || !(GITLAB_CREATE_ISSUE_TOOLS as readonly string[]).includes(m[2])) return false
  return /gitlab/i.test(m[1]) || servers.includes(m[1])
}

/** The servers of a workspace's `.mcp.json`, which a full session loads
 *  besides the agent's own list. Empty when there is none. */
export function workspaceMcpServers(workspace: string): Record<string, McpServerSpec & Record<string, any>> {
  const file = resolve(workspace, ".mcp.json")
  if (!existsSync(file)) return {}
  try {
    const servers = JSON.parse(readFileSync(file, "utf-8"))?.mcpServers
    return servers && typeof servers === "object" ? servers : {}
  } catch {
    return {}
  }
}
