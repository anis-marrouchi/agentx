import { mkdirSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- The PreToolUse guard hook command (#1710) ---
//
// One builder for both hook sites: the per-workspace hook
// (agents/workspace-setup.ts) and the user-scope attach hook
// (attach/install.ts). Design: notes/design/guard-fail-closed.md.
//
//   1. Ask the daemon. `--connect-timeout` is short, so a daemon that is
//      down or restarting refuses at once; `--max-time` is long, so a daemon
//      that is up gets to answer, including a confirmation dialog click.
//   2. If the daemon gives no answer, run the deterministic rules locally
//      (`agentx guard check --rules-only`) through a stable link the daemon
//      writes on start, then `agentx` on PATH.
//   3. If that fails too: sessions the daemon started (AGENTX_GUARD=required,
//      workspace hook only) are refused, except for the fixed commands that
//      start or restart the daemon. Everyone else is allowed, as before.
//
// The shell always ends in `exit 0`. A hook exiting 2 blocks with no reason,
// and curl uses exit 2 for its own start-up errors.

/** Printed by `guard check --rules-only` when the check itself failed. */
export const GUARD_ERROR_MARKER = "AGENTX_GUARD_ERROR"

/** Claude Code's timeout for the guard hook, in seconds. Must outlast the
 *  daemon's answer (curl max-time) plus a node start-up of the fallback on a
 *  loaded host plus its own deadline. When Claude Code drops a hook, the call
 *  runs, so this errs long. */
export const GUARD_HOOK_TIMEOUT_S = 75

export interface GuardHookBudget {
  /** curl --connect-timeout, seconds. */
  connectS: number
  /** curl --max-time, seconds. Outlasts the daemon's 45 s dialog. */
  maxTimeS: number
  /** --deadline-ms for the rules-only fallback. */
  deadlineMs: number
}

export const DEFAULT_GUARD_HOOK_BUDGET: GuardHookBudget = { connectS: 1, maxTimeS: 55, deadlineMs: 3000 }

/** The stable path of the fallback CLI. The daemon rewrites it on each start
 *  so it survives a release directory being switched or removed. */
export function guardCliLinkPath(root: string): string {
  return resolve(root, ".agentx/bin/agentx-guard")
}

/** Write the fallback CLI link: a small sh script that runs this daemon's own
 *  node on its own cli.js. Exits 127 when cli.js is gone, so the hook moves
 *  on to `agentx` on PATH. Replaced in one rename. */
export function writeGuardCliLink(root: string, nodePath: string, cliPath: string): string {
  const path = guardCliLinkPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const body = `#!/bin/sh\n[ -f ${sq(cliPath)} ] || exit 127\nexec ${sq(nodePath)} ${sq(cliPath)} "$@"\n`
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o755 })
  renameSync(tmp, path)
  return path
}

/** Single-quote a value for sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const WORD = "[A-Za-z0-9_./~@:=-]+"
const STARTS = `(start|restart|status)( +(-d|--detach|--when-idle|(-c|--config|--port)( +|=)${WORD}))*`
const UID = "([0-9]+|\\$\\(id -u\\)|\\$UID)"

/** The commands a daemon-started session may still run when neither check
 *  answers: starting, restarting or asking about the daemon. Whole-string
 *  match (grep -Ex) after trimming spaces. `$(id -u)` and `$UID` are allowed
 *  only as the uid inside `gui/`; every other `$`, backtick, `;`, `&`, `|`,
 *  redirect or newline fails the match. Exported for tests. */
export const DAEMON_RESTART_ALLOW = [
  `agentx +daemon +${STARTS}`,
  `(node +)?(${WORD}/)?cli\\.js +daemon +${STARTS}`,
  `npx +tsx +(${WORD}/)?cli\\.ts +daemon +${STARTS}`,
  `launchctl +kickstart( +-k)? +gui/${UID}/${WORD}`,
  `launchctl +(bootstrap|bootout) +gui/${UID} +${WORD}`,
  `systemctl +--user +(start|restart|status) +${WORD}`,
  `sudo +systemctl +(start|restart|status) +${WORD}`,
].map((r) => `(${r})`).join("|")

function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  })
}

export const GUARD_DOWN_DENY_REASON =
  "[agentx-guard] Refused: the AgentX guard could not check this call (the daemon is not answering and the local check failed). " +
  "Only `agentx daemon start|restart|status` and the launchctl/systemctl forms that start the daemon run until it answers."

export interface GuardHookOptions {
  port: string
  /** Install root: holds .agentx/guardrails, .agentx/db.sqlite and the CLI link. */
  root: string
  agentId?: string
  /** Add step 3 (deny unless allow-listed when AGENTX_GUARD=required).
   *  Only the workspace hook; the attach hook never denies on its own failure. */
  required?: boolean
  budget?: GuardHookBudget
  /** Override the fallback CLI path (tests). */
  cliPath?: string
}

/** Build the shell command for the guard hook. */
export function buildGuardHookCommand(o: GuardHookOptions): string {
  const b = o.budget ?? DEFAULT_GUARD_HOOK_BUDGET
  const query = o.agentId ? `?agent=${encodeURIComponent(o.agentId)}` : ""
  const url = `http://127.0.0.1:${o.port}/guard/check${query}`
  const args = `guard check --rules-only --deadline-ms ${b.deadlineMs} --root ${sq(o.root)}${o.agentId ? ` --agent ${sq(o.agentId)}` : ""}`
  const lines = [
    `p=$(cat)`,
    // 1. The daemon. -f: a non-2xx answer counts as no answer.
    `out=$(printf '%s' "$p" | curl -sf --connect-timeout ${b.connectS} --max-time ${b.maxTimeS} -H 'Content-Type: application/json' --data-binary @- '${url}' 2>/dev/null) && { printf '%s' "$out"; exit 0; }`,
    // 2. The rules, locally. The CLI exits 0 on every path it controls, so a
    //    non-zero exit means it did not run: try `agentx` on PATH next.
    `out=$(printf '%s' "$p" | ${sq(o.cliPath ?? guardCliLinkPath(o.root))} ${args} 2>/dev/null) || out=$(printf '%s' "$p" | agentx ${args} 2>/dev/null)`,
    `[ $? -eq 0 ] && [ "$out" != ${GUARD_ERROR_MARKER} ] && { printf '%s' "$out"; exit 0; }`,
  ]
  if (o.required) {
    // 3. Neither check answered. Only daemon-started sessions are refused.
    //    The command is read from the payload with grep, not a JSON parser:
    //    an allowed command has no quote or backslash, so an escaped one
    //    (`\"`, `\n`) never matches, and an unmatched call is denied.
    lines.push(
      `[ "$AGENTX_GUARD" = required ] || exit 0`,
      `c=$(printf '%s' "$p" | grep -o '"command" *: *"[^"\\\\]*"')`,
      `if printf '%s' "$p" | grep -q '"tool_name" *: *"Bash"' && [ "$(printf '%s\\n' "$c" | grep -c .)" = 1 ] && printf '%s\\n' "$c" | sed 's/^"command" *: *"//; s/"$//; s/^ *//; s/ *$//' | grep -Eqx ${sq(DAEMON_RESTART_ALLOW)}; then exit 0; fi`,
      `printf '%s' ${sq(denyJson(GUARD_DOWN_DENY_REASON))}`,
    )
  }
  lines.push(`exit 0`)
  return lines.join("\n")
}
