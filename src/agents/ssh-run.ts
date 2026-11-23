import { spawn } from "child_process"
import { posix } from "path"
import { z } from "zod"
import { jobStateInText, type JobState } from "./run-state"

// --- Run an issue on an SSH server (#2104 PR 2) ---
//
// A placement can name an SSH server instead of a mesh peer: `ssh:<name>`,
// one of `sshServers` in the daemon config. Unlike a peer, the box runs no
// AgentX. This daemon owns the run: it gets the issue's worktree ready on
// the box, then starts `claude -p` there over SSH, the prompt on stdin
// (never in the command line), and waits for the answer under the agent's
// time limit. So the request record, run link and reply are written here,
// as for a local run. Job state comes from the answer's last `State:`
// line: the AgentX tools are not on the box.
//
// Allowed only when nothing has to be enforced on the box (review v1
// blocker 2): a run with restricted autonomy or a person's limits is
// refused (mesh-safety.ts), as for a peer. The box can push only the
// issue's branch: the server's rule does that (a GitHub ruleset, or a
// GitLab Developer token with protected branches, set up by DevOps). The
// worktree's own pre-push hook is only an early message.
//
// AgentX ships no credentials: the box has its own git access and a
// signed-in `claude`. `ssh` uses this Mac's own keys and ~/.ssh/config.

export const SSH_PREFIX = "ssh:"

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i
const ABS = /^\/[A-Za-z0-9._/@+-]*$/

export const sshServerSchema = z.object({
  /** The name the Hub shows; the placement is `ssh:<name>`. */
  name: z.string().regex(NAME),
  host: z.string().regex(HOST),
  user: z.string().regex(USER).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** A key file on this Mac. Unset: ssh's own default and ~/.ssh/config. */
  identityFile: z.string().regex(ABS).optional(),
  /** The box's checkouts, by repository ("owner/repo", "group/project"):
   *  an absolute path on the box whose origin is that repository. */
  checkouts: z.record(z.string().min(1), z.string().regex(ABS)).default({}),
  /** The `claude` command on the box. */
  claudeCommand: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("claude"),
  /** Where the forge limits this box's pushes to issue branches (a GitHub
   *  ruleset, a GitLab protected-branch rule), e.g. "github ruleset 4211".
   *  The run can use Bash, so `git push --no-verify` skips the worktree's
   *  hook: with no note here, the Move and the run are refused. */
  pushLimit: z.string().trim().min(1).max(300).optional(),
})

export type SshServer = z.infer<typeof sshServerSchema>

export const isSshNode = (node: string | null | undefined): node is string => typeof node === "string" && node.startsWith(SSH_PREFIX)
export const sshNodeOf = (name: string): string => `${SSH_PREFIX}${name}`

/** The server an `ssh:<name>` node names, or undefined. */
export function sshServerOf(node: string, servers: readonly SshServer[] | undefined): SshServer | undefined {
  if (!isSshNode(node)) return undefined
  const name = node.slice(SSH_PREFIX.length)
  return servers?.find((s) => s.name === name)
}

/** Why this server may not run issues (no `pushLimit` note), or null. */
export function sshPushLimitRefusal(server: SshServer): string | null {
  return server.pushLimit ? null : `${sshNodeOf(server.name)} has no pushLimit in sshServers: set it to the forge rule that lets this box push only issue branches (the worktree's hook alone can be skipped).`
}

/** The box's checkout of a repository, compared without case. */
export function sshCheckoutOf(server: SshServer, repo: string): string | undefined {
  const hit = Object.entries(server.checkouts).find(([r]) => r.toLowerCase() === repo.toLowerCase())
  return hit?.[1]
}

/** One argument for a POSIX shell, in single quotes. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The issue's worktree on the box: beside the checkout, as on this Mac
 *  (task-worktrees.ts: `.agentx-worktrees/<checkout name>/issue-<n>`). */
export function sshWorktreeDir(checkout: string, issue: number): string {
  const c = checkout.replace(/\/+$/, "")
  return posix.join(posix.dirname(c), ".agentx-worktrees", posix.basename(c), `issue-${issue}`)
}

/** The issue run's PID file on the box, beside its worktree. */
export function sshLockFile(checkout: string, issue: number): string {
  return `${sshWorktreeDir(checkout, issue)}.lock`
}

/** `ssh` arguments for one remote command. BatchMode: never a password
 *  prompt; a box that wants one fails fast. */
export function sshArgs(server: SshServer, remote: string, connectTimeoutSec = 10): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
    ...(server.port ? ["-p", String(server.port)] : []),
    ...(server.identityFile ? ["-i", server.identityFile] : []),
    "--",
    server.user ? `${server.user}@${server.host}` : server.host,
    remote,
  ]
}

export interface SshResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
/** Runs `ssh` with these arguments, `input` on stdin. Injected in tests. */
export type SshSpawn = (args: string[], input: string, timeoutMs: number) => Promise<SshResult>

export const spawnSsh: SshSpawn = (args, input, timeoutMs) => new Promise((resolve) => {
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, timeoutMs)
  child.stdout.on("data", (d) => { stdout += d })
  child.stderr.on("data", (d) => { stderr += d })
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: 255, stdout, stderr: stderr + String(e.message) }) })
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 255, stdout, stderr, ...(timedOut ? { timedOut } : {}) }) })
  child.stdin.on("error", () => { /* the remote side closed stdin early; its exit code says why */ })
  child.stdin.end(input)
})

/** The pre-push hook the issue's worktree gets: it refuses every ref but
 *  the issue's branch. Only an early message: the server's rule is the
 *  limit (a push with --no-verify skips any hook). */
export function prePushHook(issue: number): string {
  const allowed = `refs/heads/agentx/issue-${issue}`
  return [
    "#!/bin/sh",
    `# AgentX (#2104): this worktree pushes only ${allowed}.`,
    "while read -r local_ref local_sha remote_ref remote_sha; do",
    `  if [ "$remote_ref" != "${allowed}" ]; then`,
    `    echo "agentx: this worktree may push only ${allowed}, not $remote_ref" >&2`,
    "    exit 1",
    "  fi",
    "done",
    "exit 0",
    "",
  ].join("\n")
}

/** The shell script that gets the issue's worktree ready on the box:
 *  fetch; reuse the worktree or add it on `agentx/issue-<n>` (from
 *  origin's branch when it was pushed, else from origin's default branch;
 *  its upstream is origin's issue branch either way); fast-forward a reused one, refuse a
 *  diverged one naming both commits; then give it its own hooks folder
 *  with the pre-push hook. Prints `READY <dir>`, `DIVERGED <ours>
 *  <theirs>` or `FAILED <why>`. Run with `sh -s` (script on stdin). */
export function prepareScript(checkout: string, issue: number): string {
  const branch = `agentx/issue-${issue}`
  const wt = sshWorktreeDir(checkout, issue)
  const hooks = `${wt}.hooks`
  return [
    "set -u",
    `C=${shq(checkout)}; W=${shq(wt)}; B=${shq(branch)}; H=${shq(hooks)}`,
    `fail() { echo "FAILED $*"; exit 0; }`,
    `[ -d "$C/.git" ] || [ -f "$C/.git" ] || fail "no checkout at $C"`,
    // A run whose time limit passed on this Mac may still be alive here
    // (an ssh drop): two runs on one worktree is refused (review B2). The
    // lock's pid is the run's `timeout`; a pid reused by another program
    // after a reboot is a stale lock, not a run. A box without `ps` reads
    // every lock as stale, so this guard is off there.
    `L=${shq(sshLockFile(checkout, issue))}`,
    `if [ -f "$L" ]; then P=$(cat "$L" 2>/dev/null); case "$P" in ''|*[!0-9]*) ;; *) case "$(ps -o comm= -p "$P" 2>/dev/null)" in *timeout) echo "BUSY $P"; exit 0 ;; esac ;; esac; fi`,
    `command -v timeout >/dev/null 2>&1 || fail "no timeout command on the box (coreutils)"`,
    `git -C "$C" fetch --quiet origin || fail "git fetch failed in $C"`,
    `if git -C "$C" rev-parse --verify --quiet "refs/remotes/origin/$B" >/dev/null; then BASE="origin/$B"; else`,
    `  BASE=$(git -C "$C" symbolic-ref --quiet --short refs/remotes/origin/HEAD) || fail "origin has no default branch in $C"; fi`,
    `if [ -e "$W/.git" ]; then`,
    `  if git -C "$W" rev-parse --verify --quiet "refs/remotes/origin/$B" >/dev/null; then`,
    `    O=$(git -C "$W" rev-parse HEAD); T=$(git -C "$W" rev-parse "origin/$B")`,
    `    if git -C "$W" merge-base --is-ancestor HEAD "origin/$B"; then git -C "$W" merge --quiet --ff-only "origin/$B" || fail "fast-forward failed in $W"`,
    `    elif ! git -C "$W" merge-base --is-ancestor "origin/$B" HEAD; then echo "DIVERGED $O $T"; exit 0; fi`,
    `  fi`,
    `elif git -C "$C" rev-parse --verify --quiet "refs/heads/$B" >/dev/null; then`,
    `  mkdir -p "$(dirname "$W")" && git -C "$C" worktree add --quiet "$W" "$B" || fail "worktree add failed for $B"`,
    `  if [ "$BASE" = "origin/$B" ]; then O=$(git -C "$W" rev-parse HEAD); T=$(git -C "$W" rev-parse "origin/$B")`,
    `    if git -C "$W" merge-base --is-ancestor HEAD "origin/$B"; then git -C "$W" merge --quiet --ff-only "origin/$B" || fail "fast-forward failed in $W"`,
    `    elif ! git -C "$W" merge-base --is-ancestor "origin/$B" HEAD; then echo "DIVERGED $O $T"; exit 0; fi; fi`,
    `else`,
    `  mkdir -p "$(dirname "$W")" && git -C "$C" worktree add --quiet --no-track -b "$B" "$W" "$BASE" || fail "worktree add failed for $B"`,
    // Its upstream is origin's issue branch, pushed or not: a bare
    // "git push" never goes to the default branch it was made from.
    `  git -C "$W" config "branch.$B.remote" origin && git -C "$W" config "branch.$B.merge" "refs/heads/$B" || fail "cannot set the upstream of $B"`,
    `fi`,
    `mkdir -p "$H" || fail "cannot make $H"`,
    `cat > "$H/pre-push" <<'AGENTX_HOOK'`,
    prePushHook(issue).trimEnd(),
    "AGENTX_HOOK",
    `chmod +x "$H/pre-push" || fail "cannot make the pre-push hook in $H"`,
    // Per worktree, so the checkout and other worktrees keep their hooks.
    `git -C "$C" config extensions.worktreeConfig true && git -C "$W" config --worktree core.hooksPath "$H" || fail "cannot set core.hooksPath in $W"`,
    `echo "READY $W"`,
    "",
  ].join("\n")
}

/** The script that reads the issue worktree's state for a move check
 *  (issue-run-on.ts moveRefusal): prints `NONE`, or `STATE <branch>
 *  <dirty 0|1> <ahead>`, the same reads as task-worktrees.ts
 *  issueWorktreeState. A failed read counts as dirty. */
export function stateScript(checkout: string, issue: number): string {
  const wt = sshWorktreeDir(checkout, issue)
  return [
    `W=${shq(wt)}`,
    `[ -e "$W/.git" ] || { echo NONE; exit 0; }`,
    `B=$(git -C "$W" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)`,
    `S=$(git -C "$W" status --porcelain 2>/dev/null) && { [ -z "$S" ] && D=0 || D=1; } || D=1`,
    `if git -C "$W" rev-parse --verify --quiet "refs/remotes/origin/$B" >/dev/null; then A=$(git -C "$W" rev-list --count "origin/$B..HEAD" 2>/dev/null || echo 1)`,
    `else A=$(git -C "$W" rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 1); fi`,
    `echo "STATE $B $D $A"`,
    "",
  ].join("\n")
}

export function parseState(stdout: string): { branch: string; dirty: boolean; ahead: number } | null | undefined {
  const line = stdout.trim().split("\n").pop() ?? ""
  if (line === "NONE") return null
  const m = line.match(/^STATE (\S+) ([01]) (\d+)$/)
  return m ? { branch: m[1], dirty: m[2] === "1", ahead: Number(m[3]) } : undefined
}

/** The coding tools the box's run may use (review v1 Q1): no MCP, no
 *  AgentX tools; it cannot reach anything beyond the box's own git. */
export const SSH_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "TodoWrite"]

/** Extra time this Mac waits past the box's own limit, so the box's
 *  `timeout` (and its kill 30 s later) ends the run before ssh is cut. */
export const SSH_LIMIT_GRACE_MS = 60_000

/** The remote command that runs the agent in the worktree. The prompt is
 *  read from stdin; nothing of the task is in the command line. The box
 *  ends the run itself at `limitSec` (`timeout`, then SIGKILL 30 s on),
 *  and its PID is in the lock file prepare reads (review B2). */
export function claudeCommand(server: SshServer, worktree: string, model?: string, limitSec = 20 * 60): string {
  return [
    `cd ${shq(worktree)} &&`,
    `echo $$ > ${shq(`${worktree}.lock`)} &&`,
    "exec timeout -k 30", String(Math.max(1, Math.floor(limitSec))),
    shq(server.claudeCommand), "-p",
    "--output-format", "json",
    "--strict-mcp-config",
    "--allowedTools", shq(SSH_ALLOWED_TOOLS.join(",")),
    ...(model && /^[A-Za-z0-9._-]+$/.test(model) ? ["--model", shq(model)] : []),
  ].join(" ")
}

export interface SshRunInput {
  server: SshServer
  repo: string
  issue: number
  prompt: string
  timeoutMs: number
  model?: string
}

export type SshRunOutcome =
  | { ok: true; content: string; worktree: string; sessionId?: string; jobState: JobState | null }
  | { ok: false; error: string; offline?: true }

/** Gets the worktree ready on the box, then runs the agent there. */
export async function runOverSsh(input: SshRunInput, run: SshSpawn = spawnSsh): Promise<SshRunOutcome> {
  const { server, repo, issue } = input
  const node = sshNodeOf(server.name)
  const noLimit = sshPushLimitRefusal(server)
  if (noLimit) return { ok: false, error: noLimit }
  const checkout = sshCheckoutOf(server, repo)
  if (!checkout) return { ok: false, error: `${node} has no checkout of ${repo} (sshServers[].checkouts).` }
  const prep = await run(sshArgs(server, "sh -s"), prepareScript(checkout, issue), 5 * 60_000)
  if (prep.code === 255) return { ok: false, offline: true, error: `${node} did not answer over SSH: ${lastLine(prep.stderr) || "connection failed"}` }
  const said = lastLine(prep.stdout)
  const diverged = said.match(/^DIVERGED (\S+) (\S+)$/)
  if (diverged) return { ok: false, error: `On ${node}, agentx/issue-${issue} (${diverged[1].slice(0, 12)}) and origin/agentx/issue-${issue} (${diverged[2].slice(0, 12)}) have diverged. Reconcile the branch there by hand, then run again.` }
  const busy = said.match(/^BUSY (\d+)$/)
  if (busy) return { ok: false, error: `An earlier run of issue ${issue} is still going on ${node} (pid ${busy[1]}). Wait for it to end (its time limit stops it), then run again.` }
  const ready = said.match(/^READY (.+)$/)
  if (!ready) return { ok: false, error: `${node} could not get the issue's worktree ready: ${said.replace(/^FAILED /, "") || lastLine(prep.stderr) || `exit ${prep.code}`}` }
  const worktree = ready[1]
  const res = await run(sshArgs(server, claudeCommand(server, worktree, input.model, input.timeoutMs / 1000)), input.prompt, input.timeoutMs + SSH_LIMIT_GRACE_MS)
  // 124: the box's `timeout` ended it; 137: its kill after 30 s more.
  if (res.timedOut || res.code === 124 || res.code === 137) return { ok: false, error: `The run on ${node} passed its time limit and was stopped.` }
  if (res.code === 255 && !res.stdout.trim()) return { ok: false, offline: true, error: `${node} did not answer over SSH: ${lastLine(res.stderr) || "connection failed"}` }
  let parsed: { result?: unknown; is_error?: unknown; session_id?: unknown } | null = null
  try { parsed = JSON.parse(res.stdout.trim().split("\n").pop() || "null") } catch { parsed = null }
  if (!parsed || typeof parsed.result !== "string") return { ok: false, error: `The run on ${node} gave no answer (exit ${res.code}): ${lastLine(res.stderr) || lastLine(res.stdout) || "no output"}` }
  if (parsed.is_error === true) return { ok: false, error: `The run on ${node} failed: ${parsed.result.slice(0, 500)}` }
  return { ok: true, content: parsed.result, worktree, jobState: jobStateInText(parsed.result), ...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}) }
}

/** The issue worktree's state on the box, for a move check; throws when
 *  the box does not answer. */
export async function sshIssueWorktreeState(server: SshServer, repo: string, issue: number, run: SshSpawn = spawnSsh): Promise<{ branch: string; dirty: boolean; ahead: number } | null> {
  const checkout = sshCheckoutOf(server, repo)
  if (!checkout) return null
  const res = await run(sshArgs(server, "sh -s"), stateScript(checkout, issue), 60_000)
  if (res.code === 255) throw new Error(`${sshNodeOf(server.name)} did not answer over SSH: ${lastLine(res.stderr) || "connection failed"}`)
  const state = parseState(res.stdout)
  if (state === undefined) throw new Error(`${sshNodeOf(server.name)} gave no worktree state: ${lastLine(res.stderr) || lastLine(res.stdout) || `exit ${res.code}`}`)
  return state
}

/** Whether the box answers over SSH (a short `true`). */
export async function sshReachable(server: SshServer, run: SshSpawn = spawnSsh): Promise<boolean> {
  const res = await run(sshArgs(server, "true", 5), "", 15_000)
  return res.code === 0
}

function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.trim().slice(0, 300) ?? ""
}
