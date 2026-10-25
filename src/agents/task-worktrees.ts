import { existsSync, mkdirSync, readdirSync, statSync, utimesSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import { originRemoteOf, parseGitHubChatId } from "./cloud-sessions"
import type { ExecFn } from "./spec-tests"

// --- A worktree per coder task (#1292) ---
//
// Without this, every task an agent runs on an issue edits the same
// checkout: two issues at once mix their changes, and a task starts on
// whatever branch the last one left behind. With `agents.<id>.worktrees`
// on, a task for an issue (GitHub, GitLab, Linear or Jira) runs in a git
// worktree of its own, on the branch `agentx/issue-<n>` (or
// `agentx/<key>` for a tracker issue), made from the default branch the
// first time and reused by every later task on the same issue. The
// checkout itself is never switched or reset.
//
// Pull request and merge request tasks keep running in the checkout: their
// branch belongs to whoever opened them. Worktrees untouched for
// `maxAgeDays` are removed when they hold no uncommitted change; their
// branches are kept, since they may carry pushed work.
//
// Off by default. See daemon/config.ts (`agents.<id>.worktrees`).

/** `agents.<id>.worktrees` (daemon/config.ts). */
export interface TaskWorktreeSettings {
  enabled: boolean
  /** Folder that holds the worktrees. Unset: `.agentx-worktrees/<checkout
   *  name>` beside the checkout, so tools that look up parent folders for
   *  instructions see the same ones as in the checkout. */
  root?: string
  /** Worktrees untouched this long, with nothing uncommitted, are removed. */
  maxAgeDays: number
}

export const TASK_WORKTREE_DEFAULTS: TaskWorktreeSettings = { enabled: false, maxAgeDays: 14 }

/** The issue a task is for. `repo` is set for a forge issue, whose
 *  checkout must have that repository as its origin. */
export interface WorktreeTarget {
  source: "github" | "gitlab" | "linear" | "jira"
  repo?: string
  /** Issue number, or the tracker key ("ENG-12"). */
  id: string
}

/** The issue a task's channel and chat id name, or null for anything else
 *  (a pull request, a merge request, a chat message). */
export function worktreeTarget(channel: string | undefined, chatId: string | undefined): WorktreeTarget | null {
  if (!chatId) return null
  if (channel === "github") {
    const t = parseGitHubChatId(chatId)
    return t && t.kind === "issue" ? { source: "github", repo: t.repo, id: String(t.number) } : null
  }
  if (channel === "gitlab") {
    const m = chatId.match(/^(.+):issue:(\d+)$/)
    return m ? { source: "gitlab", repo: m[1], id: m[2] } : null
  }
  if (channel === "linear" || channel === "jira") {
    const m = chatId.match(/^(?:linear|jira):([A-Za-z][A-Za-z0-9_]*-\d+)$/)
    return m ? { source: channel, id: m[1].toUpperCase() } : null
  }
  return null
}

/** The branch a task's worktree is on. */
export function worktreeBranch(target: WorktreeTarget): string {
  return /^\d+$/.test(target.id) ? `agentx/issue-${target.id}` : `agentx/${target.id.toLowerCase()}`
}

/** "group/project" from a git remote on any host: https://, ssh:// and
 *  scp-like `git@host:group/project.git`. Undefined for a local path. */
export function remotePath(url: string | undefined): string | undefined {
  const u = (url || "").trim()
  if (!u) return undefined
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+?)(?:\.git)?\/?$/i) ?? u.match(/^(?:[^@/\s]+@)?[^/:\s]+:(?!\/)(.+?)(?:\.git)?\/?$/)
  return m?.[1]
}

/** The checkout a task's worktree is made from: the first candidate whose
 *  origin is the issue's repository, or for a tracker issue the first one
 *  that is a git checkout at all. */
export function pickCheckout(target: WorktreeTarget, candidates: string[], remoteOf: (dir: string) => string | undefined = originRemoteOf): { dir: string } | { reason: string } {
  const dirs = [...new Set(candidates.filter(Boolean))]
  for (const dir of dirs) {
    const remote = remoteOf(dir)
    if (!remote) continue
    if (!target.repo) return { dir }
    if (remotePath(remote)?.toLowerCase() === target.repo.toLowerCase()) return { dir }
  }
  const looked = dirs.join(", ") || "nothing"
  return { reason: target.repo ? `no checkout of ${target.repo} (looked in ${looked})` : `no git checkout (looked in ${looked})` }
}

export function worktreeRoot(checkout: string, settings: Pick<TaskWorktreeSettings, "root">): string {
  return settings.root ? resolve(settings.root) : join(dirname(resolve(checkout)), ".agentx-worktrees", basename(resolve(checkout)))
}

export interface TaskWorktree {
  dir: string
  branch: string
  checkout: string
  /** True when an earlier task on the issue made it. */
  reused: boolean
}

export interface WorktreeDeps {
  exec: ExecFn
  log?: (line: string) => void
  now?: () => number
}

const short = (s: string) => s.trim().slice(0, 300)

/** Makes (or finds) the worktree for one issue. Never switches, resets or
 *  deletes anything in the checkout: the branch is created only when it
 *  does not exist yet, from the remote branch of the same name when there
 *  is one (an earlier task pushed it), else from the default branch. */
export async function prepareTaskWorktree(target: WorktreeTarget, checkout: string, settings: TaskWorktreeSettings, deps: WorktreeDeps): Promise<TaskWorktree | { error: string }> {
  const git = (args: string[], cwd: string) => deps.exec("git", args, { cwd, timeoutMs: 120_000 })
  const branch = worktreeBranch(target)
  const root = worktreeRoot(checkout, settings)
  const dir = join(root, branch.replace(/^agentx\//, "").replace(/[^A-Za-z0-9._-]+/g, "-"))

  if (existsSync(join(dir, ".git"))) {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)
    if (head.code === 0 && head.stdout.trim() === branch) {
      touch(dir, deps.now)
      return { dir, branch, checkout, reused: true }
    }
    return { error: `${dir} exists but is not on ${branch}${head.code === 0 ? ` (it is on ${head.stdout.trim()})` : ""}; remove it or check out ${branch} there` }
  }

  const fetched = await git(["fetch", "origin"], checkout)
  if (fetched.code !== 0) deps.log?.(`[worktrees] fetch in ${checkout} failed, using what is there: ${short(fetched.stderr)}`)
  // A worktree removed by hand leaves a stale entry that blocks `add`.
  await git(["worktree", "prune"], checkout)
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], checkout)
  let args: string[]
  if (local.code === 0) {
    args = ["worktree", "add", dir, branch]
  } else {
    const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], checkout)
    let base = `origin/${branch}`
    if (remote.code !== 0) {
      const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], checkout)
      base = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "origin/main"
    }
    args = ["worktree", "add", "--no-track", "-b", branch, dir, base]
  }
  mkdirSync(root, { recursive: true })
  const added = await git(args, checkout)
  if (added.code !== 0) return { error: `could not create the worktree for ${branch}: ${short(added.stderr)}` }
  touch(dir, deps.now)
  return { dir, branch, checkout, reused: false }
}

/** A folder's time is its last task, for pruning: editing a file inside
 *  does not change it. */
function touch(dir: string, now: (() => number) | undefined): void {
  const t = new Date((now ?? Date.now)())
  try { utimesSync(dir, t, t) } catch { /* pruning then goes by the folder's own time */ }
}

/** Removes worktrees under the root no task used for `maxAgeDays` that hold
 *  no uncommitted change. Returns the folders removed. Branches stay. */
export async function pruneTaskWorktrees(checkout: string, settings: TaskWorktreeSettings, deps: WorktreeDeps & { keep?: string }): Promise<string[]> {
  const root = worktreeRoot(checkout, settings)
  if (!existsSync(root)) return []
  const now = (deps.now ?? Date.now)()
  const removed: string[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (dir === deps.keep || !existsSync(join(dir, ".git"))) continue
    let touched: number
    try { touched = statSync(dir).mtimeMs } catch { continue }
    if (now - touched < settings.maxAgeDays * 86_400_000) continue
    const status = await deps.exec("git", ["status", "--porcelain"], { cwd: dir, timeoutMs: 60_000 })
    if (status.code !== 0 || status.stdout.trim()) {
      deps.log?.(`[worktrees] kept ${dir}: ${status.code !== 0 ? "git status failed" : "it has uncommitted changes"}`)
      continue
    }
    const r = await deps.exec("git", ["worktree", "remove", dir], { cwd: checkout, timeoutMs: 60_000 })
    if (r.code === 0) removed.push(dir)
    else deps.log?.(`[worktrees] could not remove ${dir}: ${short(r.stderr)}`)
  }
  return removed
}

/** Told to the agent with the task, so it commits on the right branch. */
export function worktreeInstructions(wt: TaskWorktree): string {
  return [
    `You are working in a git worktree of your own for this issue: ${wt.dir}, on the branch \`${wt.branch}\`.`,
    `Make your changes there, commit them on \`${wt.branch}\`, push that branch, and open the pull request (or merge request) from it.`,
    `Do not switch branches and do not edit ${wt.checkout}: other tasks use it.`,
  ].join(" ")
}
