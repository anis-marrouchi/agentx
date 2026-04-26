import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- Agent MCP config: per-agent .mcp.json sync ---
//
// Centralizes which MCP servers each agent's Claude Code session loads.
// Without this, operators hand-write `<workspace>/.mcp.json` per agent —
// painful to keep in sync across 22 workspaces, easy to drift.
//
// Ownership model: agentx-managed files carry a top-level
// `"_agentxManaged": true` marker. The Claude Code MCP loader ignores
// unknown top-level fields, so the marker is invisible to the runtime
// but lets us safely round-trip without clobbering operator edits.
//
//   - file missing                       → write fresh (we own it)
//   - file present + marker is true      → overwrite (we own it)
//   - file present + marker missing/false→ skip (operator owns it)
//
// Operator can opt out by either deleting the marker line or removing
// the file entirely after editing — agentx will respect the choice on
// the next boot.

const MARKER = "_agentxManaged"

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpServerMap = Record<string, McpServerConfig>

export type SyncResult =
  | "installed"            // wrote a fresh .mcp.json (no prior file)
  | "updated"              // overwrote an agentx-managed file
  | "removed"              // deleted an agentx-managed file (config now empty)
  | "skipped-operator-owned" // file exists without our marker — left alone
  | "noop"                 // no config + no file — nothing to do

export function syncMcpToWorkspace(workspacePath: string, mcp: McpServerMap): SyncResult {
  const mcpPath = resolve(workspacePath, ".mcp.json")
  const fileExists = existsSync(mcpPath)
  const parsed = fileExists ? tryParseJson(mcpPath) : null
  // Three states for an existing file:
  //   parsed === null && fileExists   → unparseable; treat as operator-
  //                                     owned so we don't clobber a
  //                                     half-saved edit.
  //   parsed && marker !== true        → operator-owned, skip.
  //   parsed && marker === true        → ours, safe to rewrite/remove.
  const isManaged = parsed !== null && parsed[MARKER] === true
  if (fileExists && !isManaged) return "skipped-operator-owned"

  const hasConfig = Object.keys(mcp).length > 0
  if (!hasConfig && !fileExists) return "noop"
  if (!hasConfig && isManaged) {
    unlinkSync(mcpPath)
    return "removed"
  }

  const next = { [MARKER]: true, mcpServers: mcp }
  writeFileSync(mcpPath, JSON.stringify(next, null, 2) + "\n")
  return fileExists ? "updated" : "installed"
}

function tryParseJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return null }
}
