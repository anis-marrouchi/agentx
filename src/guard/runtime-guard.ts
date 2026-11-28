import { spawn } from "child_process"
import { buildGuardHookCommand, GUARD_HOOK_TIMEOUT_S, READ_GUARD_BUDGET } from "./hook-command"
import { getAutonomyHookPort } from "./autonomy-enforce"

// --- The guard on Codex and OpenCode runs (#2119) ---
//
// Claude Code runs `agentx guard` as a PreToolUse hook (workspace-setup.ts).
// Codex and OpenCode have no such hook, so AgentX runs the SAME hook command
// for them, from the place each CLI lets it decide on a tool call:
//
//   - Codex: the app-server asks AgentX to approve each command and file
//     change (approvalPolicy "untrusted"); codex-process.ts answers with the
//     guard's verdict before the call runs.
//   - OpenCode: a plugin's "execute.before" hook (opencode-plugin.ts) runs the
//     command and throws on a deny, which stops the tool call.
//
// One command means one behaviour: ask the daemon (audit log, approval card),
// then the rules locally, then refuse (AGENTX_GUARD=required). See
// hook-command.ts.

/** `AGENTX_RUNTIME_GUARD=off` puts back the behaviour before #2119: Codex
 *  without approval requests (and the `codex exec` fallback), OpenCode without
 *  the guard plugin. A rollback switch, not a setting. */
export function runtimeGuardOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTX_RUNTIME_GUARD === "off"
}

export type RuntimeGuardKind = "write" | "read"

/** The guard hook command for an agent, as Claude Code's workspace hook runs
 *  it: "write" for Bash, Write and Edit (refuses when nothing answers),
 *  "read" for Read and Grep (runs when nothing answers, short wait). The
 *  port is the daemon's; outside the daemon it is unset and the command goes
 *  straight to the local rules. */
export function runtimeGuardCommand(agentId: string, kind: RuntimeGuardKind, root: string = process.cwd()): string {
  const port = getAutonomyHookPort() ?? "0"
  return kind === "read"
    ? buildGuardHookCommand({ port, root, agentId, required: false, budget: READ_GUARD_BUDGET })
    : buildGuardHookCommand({ port, root, agentId, required: true })
}

/** One tool call, in Claude Code's PreToolUse names. */
export interface GuardCall {
  tool: "Bash" | "Write" | "Edit" | "Read" | "Grep"
  input: Record<string, unknown>
  cwd?: string
}

export interface GuardAnswer {
  allow: boolean
  reason?: string
}

export const GUARD_NO_ANSWER_REASON = "[agentx-guard] Refused: the AgentX guard could not run for this call."

/** Read the hook's stdout. A deny or an ask refuses: these runs have nobody
 *  to answer a prompt, as with Claude Code in print mode. */
export function hookAnswer(stdout: string): GuardAnswer {
  if (!stdout.trim()) return { allow: true }
  try {
    const out = JSON.parse(stdout)?.hookSpecificOutput
    if (out?.permissionDecision === "deny" || out?.permissionDecision === "ask") {
      return { allow: false, reason: String(out.permissionDecisionReason || "[agentx-guard] Refused by the guard.") }
    }
  } catch { /* a warn-mode systemMessage or other note: allow */ }
  return { allow: true }
}

/** Run the guard hook command on one call. A command that cannot start,
 *  exits non-zero or outlasts Claude Code's hook timeout refuses a "write"
 *  call and allows a "read" one, as the hooks do. Never throws. */
export function runGuardHook(
  call: GuardCall,
  opts: { agentId: string; kind?: RuntimeGuardKind; root?: string; command?: string; env?: NodeJS.ProcessEnv },
): Promise<GuardAnswer> {
  const kind = opts.kind ?? (call.tool === "Read" || call.tool === "Grep" ? "read" : "write")
  const command = opts.command ?? runtimeGuardCommand(opts.agentId, kind, opts.root)
  const failed = (): GuardAnswer => kind === "read" ? { allow: true } : { allow: false, reason: GUARD_NO_ANSWER_REASON }
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: call.tool, tool_input: call.input, cwd: call.cwd })
  return new Promise((done) => {
    let stdout = ""
    let settled = false
    const finish = (answer: GuardAnswer) => { if (!settled) { settled = true; clearTimeout(timer); done(answer) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("sh", ["-c", command], {
        env: { ...process.env, ...opts.env, AGENTX_GUARD: "required" },
        stdio: ["pipe", "pipe", "ignore"],
      })
    } catch {
      finish(failed())
      return
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(failed()) }, GUARD_HOOK_TIMEOUT_S * 1000)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
    child.on("error", () => finish(failed()))
    child.on("close", (code) => finish(code === 0 ? hookAnswer(stdout) : failed()))
    child.stdin?.on("error", () => { /* the command may not read all of it */ })
    child.stdin?.end(payload)
  })
}
