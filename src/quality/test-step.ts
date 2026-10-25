import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execProcess, spawnWithTimeout, type ExecFn } from "@/agents/spec-tests"

// --- The project's tests before the review (#1285) ---
//
// The review gate's reviewer has no shell: it reads the issue, the diff
// and the CI result. A repository with no CI of its own then gets reviewed
// with nothing run. This step checks out the PR head in a throwaway
// worktree of a local clone, runs the project's test command there, and
// returns pass/fail with the end of the output. The gate posts it as the
// commit status `agentx/tests` and hands it to the reviewer as a check.
//
// The command runs PR code on this machine, so the gate only runs it for
// PRs opened by an account AgentX posts with, and with a bare environment:
// none of the daemon's tokens are passed down.

export const TESTS_STATUS_CONTEXT = "agentx/tests"

/** How much of the output's end is kept for the PR comment. */
export const OUTPUT_TAIL_BYTES = 4000

export interface TestStepRequest {
  checkout: string
  command: string
  /** The commit to test. */
  sha: string
  /** A ref the forge serves the PR head under, fetched in case the clone
   *  lacks the commit: `pull/9/head`, `merge-requests/9/head`. */
  ref: string
  timeoutMinutes: number
}

export interface TestStepResult {
  passed: boolean
  /** One line: "passed in 42 s", "exit code 1 after 42 s", why it could not run. */
  summary: string
  /** The end of stdout and stderr together, for the PR comment. */
  output: string
  durationMs: number
}

export interface TestStepDeps {
  exec?: ExecFn
  /** Runs the shell command; the real one uses a bare environment. */
  runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number; output: string; timedOut: boolean }>
  makeTempDir?: () => string
  now?: () => number
}

/** PATH, HOME, locale and temp folder only: tests need a shell, not the
 *  daemon's tokens. */
export function bareEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "USER"]
  const out: NodeJS.ProcessEnv = { CI: "true" }
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]
  return out
}

export function tail(text: string, bytes = OUTPUT_TAIL_BYTES): string {
  const buf = Buffer.from(text)
  if (buf.length <= bytes) return text
  return `…\n${buf.subarray(buf.length - bytes).toString("utf-8")}`
}

const realRunCommand: NonNullable<TestStepDeps["runCommand"]> = async (command, cwd, timeoutMs) => {
  const r = await spawnWithTimeout("sh", ["-c", command], { cwd, env: bareEnv(), timeoutMs })
  return { code: r.code, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`, timedOut: r.timedOut }
}

export async function runTestStep(req: TestStepRequest, deps: TestStepDeps = {}): Promise<TestStepResult> {
  const exec = deps.exec ?? execProcess
  const runCommand = deps.runCommand ?? realRunCommand
  const now = deps.now ?? Date.now
  const startedAt = now()
  const git = (args: string[], cwd: string) => exec("git", args, { cwd, timeoutMs: 120_000 })
  const done = (passed: boolean, summary: string, output = ""): TestStepResult =>
    ({ passed, summary, output: tail(output), durationMs: now() - startedAt })
  let dir: string | undefined
  try {
    const have = await git(["cat-file", "-e", `${req.sha}^{commit}`], req.checkout)
    if (have.code !== 0) {
      const fetched = await git(["fetch", "origin", req.ref], req.checkout)
      if (fetched.code !== 0) return done(false, `could not fetch ${req.ref}: ${fetched.stderr.trim().slice(0, 200)}`)
    }
    dir = (deps.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), "agentx-tests-"))))()
    const added = await git(["worktree", "add", "--detach", dir, req.sha], req.checkout)
    if (added.code !== 0) return done(false, `could not check out ${req.sha.slice(0, 7)}: ${added.stderr.trim().slice(0, 200)}`)

    const r = await runCommand(req.command, dir, req.timeoutMinutes * 60_000)
    const secs = Math.round((now() - startedAt) / 1000)
    if (r.timedOut) return done(false, `stopped after ${req.timeoutMinutes} min (timeoutMinutes)`, r.output)
    if (r.code === 0) return done(true, `passed in ${secs} s`, r.output)
    return done(false, `exit code ${r.code} after ${secs} s`, r.output)
  } catch (e: any) {
    return done(false, `could not run the tests: ${(e?.message || String(e)).slice(0, 200)}`)
  } finally {
    if (dir) {
      try { await git(["worktree", "remove", "--force", dir], req.checkout) } catch { /* fall through */ }
      try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** The PR comment for a failed run. */
export function testFailureComment(sha: string, command: string, r: TestStepResult): string {
  return [
    `**${TESTS_STATUS_CONTEXT}: failed** on \`${sha.slice(0, 7)}\` (${r.summary}).`,
    "",
    `Command: \`${command}\``,
    "",
    "<details><summary>End of the output</summary>",
    "",
    "```text",
    r.output.replace(/```/g, "ˋˋˋ") || "(no output)",
    "```",
    "</details>",
  ].join("\n")
}
