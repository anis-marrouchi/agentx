import { recordDecision } from "./audit"
import { getAutonomyHookPort } from "./autonomy-enforce"
import type { PreToolUsePayload } from "./check"
import type { Verdict } from "./types"
import { nameMatches, type PersonLimits } from "@/people/people"

// --- People permissions: per tool and per skill, enforced per run (#379) ---
//
// Same wiring as routine autonomy (autonomy-enforce.ts). A run whose person
// has deny lists is its own `claude` process, never a warm persistent one,
// with a PreToolUse hook on every tool that POSTs the call to the daemon's
// loopback /guard/check?person=1&task=<id>. The daemon judges it against the
// limits registered for that task here. The hook carries only the task id:
// the limits never leave the daemon, so nothing the run writes can change
// them. If the daemon cannot be reached, or holds no limits for the task,
// the call is blocked (fail closed).

const LIMIT_TTL_MS = 6 * 60 * 60 * 1000
const limitsByTask = new Map<string, { at: number; limits: PersonLimits }>()

function sweep(now: number): void {
  for (const [k, v] of limitsByTask) if (now - v.at > LIMIT_TTL_MS) limitsByTask.delete(k)
}

/** Called just before the run spawns. */
export function registerPersonLimits(taskId: string, limits: PersonLimits): void {
  const now = Date.now()
  sweep(now)
  limitsByTask.set(taskId, { at: now, limits })
}

/** Called when the run ends. */
export function clearPersonLimits(taskId: string): void {
  limitsByTask.delete(taskId)
}

/** The hook command. Exit 2 on transport failure = block (fail closed). */
export function personLimitHookCommand(port: string, taskId: string, agentId?: string): string {
  const q = new URLSearchParams({ person: "1", task: taskId, ...(agentId ? { agent: agentId } : {}) }).toString()
  const url = `http://127.0.0.1:${port}/guard/check?${q}`
  return `curl -sf --max-time 10 -H 'Content-Type: application/json' --data-binary @- '${url}' || ` +
    `{ echo '[agentx-people] guard unreachable: tool call blocked (fail-closed)' >&2; exit 2; }`
}

/** Add the person-limit hook to a run's claude args. Joins an existing
 *  `--settings` (the autonomy hook) rather than passing a second one. */
export function withPersonLimitHook(args: string[], taskId: string, agentId?: string): { args: string[] } | { error: string } {
  const port = getAutonomyHookPort()
  if (!port) return { error: "this person's tool and skill limits cannot be enforced: guard hook endpoint is not configured" }
  const entry = { matcher: "*", hooks: [{ type: "command", command: personLimitHookCommand(port, taskId, agentId), timeout: 15 }] }
  const out = [...args]
  const at = out.indexOf("--settings")
  if (at === -1) {
    out.push("--settings", JSON.stringify({ hooks: { PreToolUse: [entry] } }))
    return { args: out }
  }
  const settings = JSON.parse(out[at + 1])
  settings.hooks = settings.hooks ?? {}
  settings.hooks.PreToolUse = [...(settings.hooks.PreToolUse ?? []), entry]
  out[at + 1] = JSON.stringify(settings)
  return { args: out }
}

/** Why a tier cannot carry the hook, or null when it can. */
export function personLimitsUnsupported(tier: string | undefined): string | null {
  return tier === "claude-code" ? null
    : `this person's tool and skill limits are only enforceable on the claude-code tier (agent tier: ${tier ?? "unknown"}); refusing to run without them`
}

export interface PersonLimitBlock {
  personId: string
  tool: string
  /** The skill, when the call was the Skill tool. */
  skill: string | null
  reason: string
}

function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  })
}

/** What a call is denied for, or null when it may go ahead. */
function denialOf(limits: PersonLimits, tool: string, input: Record<string, unknown>): { skill: string | null; what: string } | null {
  if (limits.tools.some((p) => nameMatches(p, tool))) return { skill: null, what: tool }
  if (tool === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill : typeof input.command === "string" ? input.command : ""
    if (skill && limits.skills.some((p) => nameMatches(p, skill))) return { skill, what: `the skill ${skill}` }
  }
  return null
}

/**
 * Judge one PreToolUse payload from a limited run's hook. A denial is
 * written to the guard log and returned so the caller can keep it in the
 * person's trail. Never throws; an internal error denies the call.
 */
export function checkPersonLimitPayload(
  payload: PreToolUsePayload,
  opts: { root: string; taskId?: string | null; agentId?: string },
): { stdout: string; blocked: PersonLimitBlock | null } {
  const tool = payload.tool_name ?? "unknown"
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  try {
    const entry = opts.taskId ? limitsByTask.get(opts.taskId) : undefined
    if (!entry) return { stdout: denyOutput("[agentx-people] No limits are on record for this run, so the call is blocked (fail-closed)."), blocked: null }
    const { limits } = entry
    const denied = denialOf(limits, tool, input)
    if (!denied) return { stdout: "", blocked: null }
    const reason = `${limits.name} may not use ${denied.what}`
    const verdict: Verdict = {
      matched: true, action: "deny", effectiveAction: "deny", ruleId: "people.deny",
      severity: "high", message: reason, resolvedTarget: null,
    }
    recordDecision({
      root: opts.root,
      input: { tool, command: typeof input.command === "string" ? input.command : tool, agentId: opts.agentId },
      verdict,
      mode: "enforce",
      taskId: opts.taskId ?? null,
    })
    return {
      stdout: denyOutput(
        `[agentx-people] Blocked: ${reason} here (set by the owner). Do not work around it. ` +
        `Finish what you can without it and say in your answer what was not done and why.`,
      ),
      blocked: { personId: limits.personId, tool, skill: denied.skill, reason },
    }
  } catch (e: any) {
    return { stdout: denyOutput(`[agentx-people] Guard error (fail-closed): ${e?.message ?? e}`), blocked: null }
  }
}
