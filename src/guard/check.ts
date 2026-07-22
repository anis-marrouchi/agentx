import { loadPolicy } from "./policy"
import { evaluate } from "./engine"
import { recordDecision } from "./audit"
import type { GuardInput, GuardMode, ResolvedPolicy, Verdict } from "./types"

// --- `agentx guard check`: the PreToolUse hook entrypoint ---
//
// Claude Code fires PreToolUse for every tool call and pipes a JSON payload on
// stdin. We resolve the command's real target, evaluate policy, audit the
// verdict, and emit Claude Code's decision on stdout.
//
// Contract (confirmed against the Claude Code hooks docs):
//   - stdin: { hook_event_name, tool_name, tool_input:{command|file_path}, cwd, ... }
//   - to BLOCK: exit 0 + stdout JSON with
//       hookSpecificOutput.permissionDecision = "deny" | "ask"
//   - to ALLOW: exit 0 with no permissionDecision (normal permission flow)
//   - exit 2 also blocks (stderr shown) — we prefer the JSON form so the
//     reason reaches the model cleanly. We NEVER exit 2/nonzero.
//
// Phase 1 ships mode=warn: deny/escalate are computed + audited but downgraded
// to allow, with a one-line systemMessage so operators see the would-be block.

export interface PreToolUsePayload {
  hook_event_name?: string
  tool_name?: string
  tool_input?: { command?: string; file_path?: string; [k: string]: unknown }
  cwd?: string
  permission_mode?: string
  session_id?: string
}

/** Map a PreToolUse payload to the engine's GuardInput. */
export function payloadToInput(p: PreToolUsePayload, agentId?: string, env?: string): GuardInput {
  return {
    tool: p.tool_name ?? "Bash",
    command: p.tool_input?.command,
    filePath: p.tool_input?.file_path,
    cwd: p.cwd,
    agentId,
    env,
  }
}

export interface RunGuardOptions {
  root: string
  agentId?: string
  env?: string
  /** Force a mode regardless of policy (used by `guard test --enforce`). */
  modeOverride?: GuardMode
  taskId?: string | null
  /** Skip the audit write (dry-run in `guard test`). */
  noAudit?: boolean
}

export interface GuardResult {
  verdict: Verdict
  policy: ResolvedPolicy
  mode: GuardMode
  ms: number
}

/** Core: load policy, evaluate, audit. Shared by the stdin hook and `guard test`. */
export function runGuard(input: GuardInput, opts: RunGuardOptions): GuardResult {
  const start = Date.now()
  let policy = loadPolicy(opts.root, input.agentId ?? opts.agentId)
  const mode = opts.modeOverride ?? policy.mode
  if (opts.modeOverride) policy = { ...policy, mode: opts.modeOverride }

  const verdict = evaluate(input, policy)
  const ms = Date.now() - start

  if (!opts.noAudit) {
    recordDecision({ root: opts.root, input, verdict, mode, taskId: opts.taskId, ms })
  }
  return { verdict, policy, mode, ms }
}

/** Build the human-readable reason handed to the model on deny/ask. */
export function verdictReason(v: Verdict): string {
  const bits = [v.message ?? `Blocked by guardrail policy.`]
  const meta: string[] = []
  if (v.ruleId) meta.push(`rule: ${v.ruleId}`)
  if (v.resolvedTarget) meta.push(`target: ${v.resolvedTarget}`)
  return `[agentx-guard] ${bits[0]}${meta.length ? ` (${meta.join(", ")})` : ""}`
}

/** Produce the exact stdout JSON (or empty) for a verdict. Exported for tests. */
export function decisionOutput(v: Verdict): { stdout: string } {
  if (v.effectiveAction === "deny" || v.effectiveAction === "ask") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: v.effectiveAction,
          permissionDecisionReason: verdictReason(v),
        },
      }),
    }
  }
  // allow / warn. In warn mode, surface a would-block signal to the operator.
  if (v.matched && (v.action === "deny" || v.action === "escalate")) {
    const target = v.resolvedTarget ? `, target: ${v.resolvedTarget}` : ""
    return {
      stdout: JSON.stringify({
        systemMessage: `[agentx-guard] WARN — would ${v.action}: ${v.ruleId}${target}. ${v.message ?? ""}`.trim(),
        suppressOutput: true,
      }),
    }
  }
  return { stdout: "" }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Full stdin -> stdout hook run. Always resolves without throwing and never
 * exits non-zero: an internal guard error must fail OPEN at the hook layer
 * (a crashing guard should not brick every agent command). Real fail-closed
 * behavior lives inside the engine, where a broken rule touching a protected
 * resource yields an explicit deny verdict.
 */
export async function runCheckFromStdin(opts: { root: string; agentId?: string; env?: string }): Promise<void> {
  let raw = ""
  try {
    raw = await readStdin()
    if (!raw.trim()) return
    const payload = JSON.parse(raw) as PreToolUsePayload
    const input = payloadToInput(payload, opts.agentId, opts.env)
    const { verdict } = runGuard(input, { root: opts.root, agentId: opts.agentId, env: opts.env })
    const { stdout } = decisionOutput(verdict)
    if (stdout) process.stdout.write(stdout)
  } catch (e: any) {
    process.stderr.write(`[agentx-guard] check failed (fail-open): ${e?.message}\n`)
  }
}
