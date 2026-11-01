// --- MCP server policy: secret headers and tool allow lists (#1698) ---
//
// Two per-server settings that make a hosted MCP endpoint (a connector
// service, for instance) safe to declare in agentx.json:
//
//   headersEnv  header name -> NAME of an environment variable. The value
//               is read by the daemon when it connects (orchestrator tier),
//               and written to .mcp.json only as a `${NAME}` placeholder
//               that Claude Code expands at spawn. The secret itself never
//               lands in agentx.json or in a synced file. (`${VAR}` inside
//               plain `headers` is expanded when agentx.json loads, so it
//               would end up in .mcp.json in clear text.)
//
//   allowTools  the only tools of that server an agent may use. Exact
//               names, `*` as a wildcard. The orchestrator tier never lists
//               the others; the claude-code tier's guard hook refuses them.
//
// Pure helpers only: no I/O, so mcp-client, agent-mcp, the runtime and the
// daemon's /guard/check can all share them.

/** An environment variable name as agentx accepts it elsewhere (`tokenEnv`). */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface McpPolicyFields {
  headers?: Record<string, string>
  headersEnv?: Record<string, string>
  allowTools?: string[]
}

/** Headers to send on every request: the literal `headers`, then each
 *  `headersEnv` entry read from `env`. An unset or empty variable is left
 *  out, so the server answers 401 instead of receiving an empty key. */
export function resolveHttpHeaders(
  spec: McpPolicyFields,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(spec.headers ?? {}) }
  for (const [header, name] of Object.entries(spec.headersEnv ?? {})) {
    const value = env[name]?.trim()
    if (value) out[header] = value
  }
  return out
}

/** Headers as written into a file another program reads (.mcp.json):
 *  `headersEnv` entries become `${NAME}` placeholders that program expands
 *  from its own environment. The secret value is never looked up here. */
export function placeholderHeaders(spec: McpPolicyFields): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(spec.headers ?? {}) }
  for (const [header, name] of Object.entries(spec.headersEnv ?? {})) out[header] = `\${${name}}`
  return Object.keys(out).length > 0 ? out : undefined
}

/** Environment variable names a server's `headersEnv` needs. */
export function headerEnvNames(spec: McpPolicyFields): string[] {
  return [...new Set(Object.values(spec.headersEnv ?? {}))]
}

function wildcardToRegExp(pattern: string): RegExp {
  const body = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${body}$`)
}

/** Is `tool` (the server's own tool name, without `mcp__<server>__`) on
 *  the list? No list means every tool is allowed; an empty list allows none. */
export function toolAllowed(allowTools: string[] | undefined, tool: string): boolean {
  if (!allowTools) return true
  return allowTools.some((p) => (p.includes("*") ? wildcardToRegExp(p).test(tool) : p === tool))
}

/** Reason to refuse a namespaced `mcp__<server>__<tool>` call, or null.
 *  Only servers with an `allowTools` list are checked; a call to any other
 *  server, or to a tool that is not an MCP tool, is not this check's call. */
export function mcpAllowListDenial(
  toolName: string,
  servers: Record<string, McpPolicyFields> | undefined,
): string | null {
  if (!servers || !toolName.startsWith("mcp__")) return null
  // Longest server name first, so `a__b` wins over `a` for `mcp__a__b__x`.
  const names = Object.keys(servers).sort((a, b) => b.length - a.length)
  for (const server of names) {
    const prefix = `mcp__${server}__`
    if (!toolName.startsWith(prefix)) continue
    const list = servers[server]?.allowTools
    if (!list) return null
    const tool = toolName.slice(prefix.length)
    if (toolAllowed(list, tool)) return null
    return `[agentx-mcp] "${tool}" is not on the allowTools list of MCP server "${server}". Allowed: ${list.join(", ") || "(none)"}.`
  }
  return null
}

/** Hook matcher (a regular expression over tool names) covering every
 *  server that has an `allowTools` list, or null when none does. */
export function allowListHookMatcher(servers: Record<string, McpPolicyFields> | undefined): string | null {
  const names = Object.entries(servers ?? {})
    .filter(([, s]) => Array.isArray(s?.allowTools))
    .map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (names.length === 0) return null
  return `mcp__(${names.join("|")})__.*`
}
