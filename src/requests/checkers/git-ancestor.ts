import { execFile } from "child_process"
import type { CheckContext, CheckerSettings, CheckResult, GitAncestorSpec } from "./index"

// --- git-ancestor: a commit is in a branch of a local clone ---
//
// `git merge-base --is-ancestor <commit> <ref>` in a clone named under
// requests.checkers.repos. Only those paths are read: an agent names the
// repo, never a path. The clone is not fetched here; keep it current
// (a cron, or the agent's own work). A commit the clone does not have yet
// is unverifiable, not "not done". A remote host's build commit is a `url`
// check on its version endpoint, so nothing here reaches another machine.

/** Runs git with these arguments in `cwd`. Resolves with the exit code. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stderr: string }>

const TIMEOUT_MS = 10_000
const COMMIT_RE = /^[0-9a-f]{7,64}$/i
// A branch, tag or remote ref: no leading dash, no "..", nothing a shell
// or git would read as an option or a range.
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function parseGitAncestorSpec(raw: Record<string, unknown>, settings: Pick<CheckerSettings, "repos">): GitAncestorSpec | string {
  const repo = str(raw.repo)
  const names = Object.keys(settings.repos)
  if (!repo || !Object.prototype.hasOwnProperty.call(settings.repos, repo)) {
    return names.length
      ? `repo must be one of ${names.join(", ")} (requests.checkers.repos)`
      : "no repos are set up for this check on this node (requests.checkers.repos)"
  }
  const commit = str(raw.commit)
  if (!COMMIT_RE.test(commit)) return "commit must be a commit hash (7 to 64 hex characters)"
  const ref = str(raw.ref)
  if (ref && !REF_RE.test(ref)) return "ref must be a branch or tag name, for example main or origin/main"
  return { kind: "git-ancestor", repo, commit, ...(ref ? { ref } : {}) }
}

export const runGit: GitRunner = (cwd, args) => new Promise((resolve) => {
  execFile("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS, windowsHide: true }, (err: any, _stdout, stderr) => {
    // A git that could not start (missing, timed out) has no number: -1.
    resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stderr: String(stderr ?? "") })
  })
})

export async function checkGitAncestor(spec: GitAncestorSpec, ctx: Pick<CheckContext, "settings" | "git">): Promise<CheckResult> {
  const path = ctx.settings.repos[spec.repo]
  if (!path) return { verdict: "unverifiable", detail: `no repo "${spec.repo}" in requests.checkers.repos on this node` }
  const ref = spec.ref ?? "HEAD"
  const { code, stderr } = await (ctx.git ?? runGit)(path, ["merge-base", "--is-ancestor", spec.commit, ref])
  if (code === 0) return { verdict: "met", detail: `commit ${spec.commit} is in ${ref} of ${spec.repo}` }
  if (code === 1) return { verdict: "not_met", detail: `commit ${spec.commit} is not in ${ref} of ${spec.repo} yet` }
  const why = stderr.replace(/\s+/g, " ").trim().slice(0, 200) || `git exited with ${code}`
  return { verdict: "unverifiable", detail: `could not check ${spec.commit} in ${spec.repo}: ${why}` }
}
