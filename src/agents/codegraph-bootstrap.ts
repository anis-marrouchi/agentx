import { execFile } from "child_process"
import { existsSync } from "fs"
import { resolve } from "path"
import type { AgentDef } from "@/daemon/config"
import type { McpServerMap } from "./agent-mcp"

// --- CodeGraph integration: per-agent semantic code-graph index ---
//
// CodeGraph (https://github.com/colbymchenry/codegraph) is a local
// tree-sitter → SQLite knowledge graph exposed to Claude Code / Codex via
// MCP. Opt-in per agent with `codegraph: true` on the agent's config.
//
// This module owns three responsibilities:
//   1. `effectiveMcpConfig(def)` — synthesize the codegraph MCP server
//      entry into the agent's MCP map. Used by the daemon's
//      installAgentMcpConfig pass so the workspace's .mcp.json picks
//      up `codegraph serve --mcp` automatically.
//   2. `bootstrapCodegraphIndexes(agents, log)` — at daemon boot, fire
//      off `codegraph init --index --quiet` in the background for any
//      opted-in workspace whose `.codegraph/` is missing. Throttled to
//      2 parallel jobs so a large fleet doesn't thrash the host.
//      Returns immediately; the indexes finish on their own.
//   3. Export the constant tool/CLI names that workspace-setup needs
//      to keep CLAUDE.md and settings.json in sync.

/** MCP tool names exposed by `codegraph serve --mcp`. Used to extend the
 *  per-workspace `.claude/settings.json` permissions.allow so claude
 *  doesn't prompt for permission on every call. Keep in sync with the
 *  upstream tool surface — additions are harmless, removals leave a
 *  stale allow entry (also harmless). */
export const CODEGRAPH_TOOLS = [
  "mcp__codegraph__codegraph_search",
  "mcp__codegraph__codegraph_context",
  "mcp__codegraph__codegraph_callers",
  "mcp__codegraph__codegraph_callees",
  "mcp__codegraph__codegraph_impact",
  "mcp__codegraph__codegraph_node",
  "mcp__codegraph__codegraph_status",
  "mcp__codegraph__codegraph_files",
] as const

/** MCP server stanza we inject into `.mcp.json` for opted-in agents. */
export const CODEGRAPH_MCP_SERVER: { command: string; args: string[] } = {
  command: "codegraph",
  args: ["serve", "--mcp"],
}

/** Markdown block appended to managed CLAUDE.md when codegraph is on.
 *  Tells the agent to prefer codegraph_* over grep, and to always spawn
 *  an Explore subagent for codegraph_explore so the large source-dump
 *  doesn't bloat the main session context. Mirrors the upstream-
 *  recommended wording from the README's "Global Instructions" block. */
export function codegraphClaudeMdSection(): string {
  return [
    "## CodeGraph",
    "",
    "This workspace has CodeGraph initialized — a semantic code-knowledge-graph indexed via tree-sitter. Use it instead of grep/find/Read for exploration.",
    "",
    "**ALWAYS spawn an Explore subagent for `codegraph_explore` / `codegraph_context`** — those tools return large source sections that would otherwise bloat the main session. Include this in the Explore prompt:",
    "",
    "> Use `codegraph_explore` as your PRIMARY tool — one call returns full source from all relevant files. Do not re-Read files codegraph_explore already returned. Fall back to grep/glob/Read only if codegraph returned no results.",
    "",
    "**In the main session, use these lightweight codegraph tools directly:**",
    "",
    "| Tool | Use for |",
    "|---|---|",
    "| `codegraph_search` | Find symbols by name across the codebase |",
    "| `codegraph_callers` / `codegraph_callees` | Trace call flow |",
    "| `codegraph_impact` | Check what's affected before editing a symbol |",
    "| `codegraph_node` | Get a single symbol's details |",
    "| `codegraph_files` | Indexed file structure (faster than ls) |",
    "| `codegraph_status` | Index health |",
    "",
  ].join("\n")
}

/** Return the MCP server map an agent should expose to .mcp.json,
 *  layering codegraph on top of the operator-declared `def.mcp` when
 *  `def.codegraph === true`. Operator-declared entries win on key
 *  collision (operator can override by declaring their own
 *  `mcp.codegraph` block with different args). */
export function effectiveMcpConfig(def: AgentDef): McpServerMap {
  const base: McpServerMap = ((def as any).mcp ?? {}) as McpServerMap
  if (!def.codegraph) return base
  if (base.codegraph) return base
  return { ...base, codegraph: { command: CODEGRAPH_MCP_SERVER.command, args: [...CODEGRAPH_MCP_SERVER.args] } }
}

const INDEX_DIR = ".codegraph"
const INIT_TIMEOUT_MS = 10 * 60 * 1000 // 10 min — Swift Compiler benchmark indexed 25k files in ~4 min
const MAX_PARALLEL = 2

/** Spawn `codegraph init --index --quiet` for one workspace. Returns the
 *  duration in ms on success, throws on failure. Caller decides whether
 *  to surface the error. */
function indexWorkspace(workspace: string): Promise<number> {
  const started = Date.now()
  return new Promise<number>((res, rej) => {
    execFile(
      "codegraph",
      ["init", "--index", "--quiet", workspace],
      { timeout: INIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err) => {
        if (err) rej(err)
        else res(Date.now() - started)
      },
    )
  })
}

/** Boot-time helper: kick off `codegraph init --index` for every
 *  opted-in workspace whose `.codegraph/` is missing. Fire-and-forget —
 *  the returned promise resolves once all background jobs settle, but
 *  callers (daemon start) don't need to await it. Indexing happens
 *  while the daemon is already serving traffic; cold dispatches before
 *  the index lands gracefully fall through to grep (the MCP server
 *  returns an empty result, and CLAUDE.md tells the agent to fall back).
 *
 *  Throttled to MAX_PARALLEL concurrent jobs so a fleet boot doesn't
 *  saturate CPU/disk. */
export async function bootstrapCodegraphIndexes(
  agents: Record<string, AgentDef>,
  log: (...args: unknown[]) => void = console.error,
): Promise<void> {
  const pending: Array<{ agentId: string; workspace: string }> = []
  for (const [agentId, def] of Object.entries(agents)) {
    if (!def.codegraph) continue
    if (def.tier !== "claude-code" && def.tier !== "codex-cli") continue
    if (!existsSync(def.workspace)) continue
    if (existsSync(resolve(def.workspace, INDEX_DIR))) continue
    pending.push({ agentId, workspace: def.workspace })
  }

  if (pending.length === 0) return

  log(`codegraph: indexing ${pending.length} workspace(s) in background (max ${MAX_PARALLEL} parallel)`)

  let i = 0
  const runners: Promise<void>[] = []
  for (let slot = 0; slot < Math.min(MAX_PARALLEL, pending.length); slot++) {
    runners.push((async () => {
      while (true) {
        const idx = i++
        if (idx >= pending.length) return
        const { agentId, workspace } = pending[idx]
        try {
          const ms = await indexWorkspace(workspace)
          log(`  codegraph: indexed ${agentId} in ${(ms / 1000).toFixed(1)}s`)
        } catch (err: any) {
          // codegraph binary missing surfaces as ENOENT — recoverable hint
          const hint = err?.code === "ENOENT"
            ? " (codegraph CLI not on PATH; install with `npm i -g @colbymchenry/codegraph`)"
            : ""
          log(`  codegraph: ${agentId} index failed: ${err?.message ?? err}${hint}`)
        }
      }
    })())
  }
  await Promise.allSettled(runners)
}
