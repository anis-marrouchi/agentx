import { recordDecision } from "./audit"
import { autonomyLevelSchema, evaluateAutonomy, isRestricted, type AutonomyLevel } from "./autonomy"
import type { PreToolUsePayload } from "./check"
import type { Verdict } from "./types"

// --- Routine autonomy: per-task enforcement wiring ---
//
// Enforcement is PER SPAWN, never per agent. A restricted task (autonomy
// report|propose) is run as its own `claude` process with two extra flags:
//
//   --settings '{"hooks":{"PreToolUse":[{"matcher":"*", ...}]}}'
//       A PreToolUse hook on EVERY tool (native + MCP) that POSTs the call to
//       the daemon's loopback /guard/check with ?autonomy=<level>&task=<id>.
//       It layers on top of the workspace's own guard hook; Claude Code
//       applies the strictest decision, and hooks fire under
//       bypassPermissions too. If the daemon cannot be reached the hook
//       exits 2, which BLOCKS the call: a restricted routine fails closed,
//       unlike the workspace guard hook which fails open.
//   --disallowedTools Write,Edit,MultiEdit,NotebookEdit   (report only)
//       Belt and braces for the file-writing tools, independent of the hook.
//
// Because the flags live on that one process, other chats with the same
// agent — including the agent's warm persistent processes — are untouched,
// and the restricted task never reuses a warm process spawned without them
// (the runtime forces spawn-per-task for restricted levels).

export interface AutonomyBlock {
  ts: number
  tool: string
  /** Command or file path the call targeted, truncated. */
  target: string | null
  ruleId: string
  reason: string
}

const MAX_BLOCKS_PER_TASK = 50
const BLOCK_TTL_MS = 6 * 60 * 60 * 1000

let hookPort: string | null = null
const blocksByTask = new Map<string, { at: number; blocks: AutonomyBlock[] }>()

/** Set by the daemon at start from its bind address. Until it is set,
 *  restricted tasks refuse to run (there is nowhere to send the hook). */
export function setAutonomyHookPort(port: string | number | null): void {
  hookPort = port === null ? null : String(port)
}

export function getAutonomyHookPort(): string | null {
  return hookPort
}

/** The hook command. Exit 2 on transport failure = block (fail closed). */
export function autonomyHookCommand(port: string, agentId: string, level: AutonomyLevel, taskId: string): string {
  const q = new URLSearchParams({ agent: agentId, autonomy: level, task: taskId }).toString()
  const url = `http://127.0.0.1:${port}/guard/check?${q}`
  return `curl -sf --max-time 10 -H 'Content-Type: application/json' --data-binary @- '${url}' || ` +
    `{ echo '[agentx-autonomy] guard unreachable: tool call blocked (fail-closed)' >&2; exit 2; }`
}

/**
 * Extra `claude` CLI args for a restricted task, or an error explaining why
 * the task cannot be enforced (and so must not run). Empty for `act`.
 */
export function autonomyClaudeArgs(
  level: AutonomyLevel | undefined,
  agentId: string,
  taskId: string,
): { args: string[] } | { error: string } {
  if (!isRestricted(level)) return { args: [] }
  if (!hookPort) return { error: `autonomy "${level}" cannot be enforced: guard hook endpoint is not configured` }
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: autonomyHookCommand(hookPort, agentId, level, taskId), timeout: 15 }] },
      ],
    },
  }
  const args: string[] = []
  if (level === "report") args.push("--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit")
  args.push("--settings", JSON.stringify(settings))
  return { args }
}

/** Why a tier cannot enforce a restricted level, or null when it can. */
export function autonomyUnsupported(level: AutonomyLevel | undefined, tier: string | undefined): string | null {
  if (!isRestricted(level)) return null
  if (tier === "claude-code") return null
  return `autonomy "${level}" is only enforceable on the claude-code tier (agent tier: ${tier ?? "unknown"}); refusing to run it with full permissions`
}

// ---------------------------------------------------------------- blocks

function sweep(now: number): void {
  for (const [k, v] of blocksByTask) if (now - v.at > BLOCK_TTL_MS) blocksByTask.delete(k)
}

export function recordAutonomyBlock(taskId: string, block: AutonomyBlock): void {
  const now = Date.now()
  sweep(now)
  const entry = blocksByTask.get(taskId) ?? { at: now, blocks: [] }
  if (entry.blocks.length < MAX_BLOCKS_PER_TASK) entry.blocks.push(block)
  entry.at = now
  blocksByTask.set(taskId, entry)
}

/** Remove and return the blocks recorded for a task. */
export function takeAutonomyBlocks(taskId: string | undefined): AutonomyBlock[] {
  if (!taskId) return []
  const entry = blocksByTask.get(taskId)
  blocksByTask.delete(taskId)
  return entry?.blocks ?? []
}

// ---------------------------------------------------------------- daemon side

export interface AutonomyCheckResult {
  /** Body for the hook: "" = allow (defer to the other hooks). */
  stdout: string
  blocked: AutonomyBlock | null
}

function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })
}

/**
 * Judge one PreToolUse payload from a restricted task's hook. Blocks are
 * always enforced (no warn mode: the operator opted this routine into the
 * restriction), written to the guard log, and kept for the run result.
 * Never throws; an internal error denies the call.
 */
export function checkAutonomyPayload(
  payload: PreToolUsePayload,
  opts: { root: string; agentId?: string; level: string | null; taskId?: string | null },
): AutonomyCheckResult {
  const tool = payload.tool_name ?? "unknown"
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : undefined
  const filePath = typeof payload.tool_input?.file_path === "string"
    ? payload.tool_input.file_path
    : typeof payload.tool_input?.notebook_path === "string" ? payload.tool_input.notebook_path : undefined
  try {
    const parsed = autonomyLevelSchema.safeParse(opts.level)
    const decision = parsed.success
      ? evaluateAutonomy(parsed.data, { tool, command, filePath })
      : { allowed: false, ruleId: "autonomy.invalid", reason: `unknown autonomy level "${opts.level}"` }
    if (decision.allowed) return { stdout: "", blocked: null }

    const level = parsed.success ? parsed.data : "report"
    const ruleId = decision.ruleId ?? "autonomy"
    const reason = decision.reason ?? "blocked"
    const block: AutonomyBlock = {
      ts: Date.now(),
      tool,
      target: (command ?? filePath ?? null)?.slice(0, 300) ?? null,
      ruleId,
      reason,
    }
    const verdict: Verdict = {
      matched: true,
      action: "deny",
      effectiveAction: "deny",
      ruleId,
      severity: "high",
      message: reason,
      resolvedTarget: null,
    }
    recordDecision({
      root: opts.root,
      input: { tool, command: command ?? (filePath ? undefined : tool), filePath, agentId: opts.agentId },
      verdict,
      mode: "enforce",
      taskId: opts.taskId ?? null,
    })
    if (opts.taskId) recordAutonomyBlock(opts.taskId, block)
    return {
      stdout: denyOutput(
        `[agentx-autonomy] Blocked: this routine runs at autonomy "${level}" and ${reason} (rule: ${ruleId}). ` +
        `Do not work around it. Finish the task within the limit and list this step in your final answer as a recommendation.`,
      ),
      blocked: block,
    }
  } catch (e: any) {
    return { stdout: denyOutput(`[agentx-autonomy] Guard error (fail-closed): ${e?.message ?? e}`), blocked: null }
  }
}
