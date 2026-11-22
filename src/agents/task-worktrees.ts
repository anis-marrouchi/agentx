import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, utimesSync } from "fs"
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
// A pull request or merge request task (#2102) runs on the change's source
// branch: in the worktree that already has it checked out (most often the
// issue worktree the agent opened it from, or the checkout itself when it
// is on that branch), else in a new worktree `pr-<n>` / `mr-<n>` tracking
// `origin/<branch>`. A branch is never checked out twice. The source branch comes from the webhook payload
// (changeSourceOf); when it is unknown, or the change comes from a fork,
// the task runs in the checkout. Worktrees untouched for
// `maxAgeDays` are removed when they hold no uncommitted change; their
// branches are kept, since they may carry pushed work.
//
// Off by default: coding agents turn it on per agent (#2102 review B4),
// and it applies only when a checkout whose origin is the issue's
// repository is found (pickCheckout). An issue already in progress when
// it is turned on (a kept session, an open request) stays in the checkout
// until it ends (B5, AgentRegistry.inTaskWorktree). See daemon/config.ts
// (`agents.<id>.worktrees`).

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

/** The issue, pull request or merge request a task is for. `repo` is set
 *  for a forge issue or change, whose checkout must have that repository
 *  as its origin. */
export interface WorktreeTarget {
  source: "github" | "gitlab" | "linear" | "jira"
  repo?: string
  /** Issue number, PR number or MR iid, or the tracker key ("ENG-12"). */
  id: string
  /** "change": a pull or merge request, worked on its source branch.
   *  Unset: an issue. */
  kind?: "issue" | "change"
}

/** The issue, pull request or merge request a task's channel and chat id
 *  name, or null for anything else (a chat message). */
export function worktreeTarget(channel: string | undefined, chatId: string | undefined): WorktreeTarget | null {
  if (!chatId) return null
  if (channel === "github") {
    const t = parseGitHubChatId(chatId)
    if (!t) return null
    return t.kind === "issue" ? { source: "github", repo: t.repo, id: String(t.number) } : { source: "github", repo: t.repo, id: String(t.number), kind: "change" }
  }
  if (channel === "gitlab") {
    const m = chatId.match(/^(.+):issue:(\d+)$/)
    if (m) return { source: "gitlab", repo: m[1], id: m[2] }
    const mr = chatId.match(/^(.+):merge_request:(\d+)$/)
    return mr ? { source: "gitlab", repo: mr[1], id: mr[2], kind: "change" } : null
  }
  if (channel === "linear" || channel === "jira") {
    const m = chatId.match(/^(?:linear|jira):([A-Za-z][A-Za-z0-9_]*-\d+)$/)
    return m ? { source: channel, id: m[1].toUpperCase() } : null
  }
  return null
}

/** The source branch of the pull or merge request a webhook payload is
 *  about, and whether it comes from another repository (a fork). Reads
 *  GitHub `pull_request.head` and GitLab `object_attributes` (merge request
 *  event) or `merge_request` (note on a merge request). Undefined when the
 *  payload names no change. */
export function changeSourceOf(raw: unknown): { sourceBranch: string; sourceFork: boolean } | undefined {
  const r = raw as any
  if (!r || typeof r !== "object") return undefined
  const pr = r.pull_request
  if (pr && typeof pr.head?.ref === "string" && pr.head.ref) {
    const head = pr.head.repo?.full_name
    const base = pr.base?.repo?.full_name ?? r.repository?.full_name
    // A deleted fork leaves `head.repo` null.
    const fork = typeof head !== "string" || (typeof base === "string" && head.toLowerCase() !== base.toLowerCase())
    return { sourceBranch: pr.head.ref, sourceFork: fork }
  }
  // A failed workflow run on a PR (the CI fix loop, #2102).
  const run = r.workflow_run
  if (run && typeof run.head_branch === "string" && run.head_branch) {
    const head = run.head_repository?.full_name
    const base = r.repository?.full_name
    const fork = typeof head !== "string" || (typeof base === "string" && head.toLowerCase() !== base.toLowerCase())
    return { sourceBranch: run.head_branch, sourceFork: fork }
  }
  const mr = r.object_kind === "merge_request" ? r.object_attributes : r.merge_request
  if (mr && typeof mr.source_branch === "string" && mr.source_branch) {
    const fork = mr.source_project_id != null && mr.target_project_id != null && mr.source_project_id !== mr.target_project_id
    return { sourceBranch: mr.source_branch, sourceFork: fork }
  }
  return undefined
}

/** The branch a task's worktree is on (an issue target). */
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
  /** Set for a pull or merge request: the worktree is on its source branch. */
  change?: "pull request" | "merge request"
  /** True when a change task took over a worktree made for something else
   *  (most often the issue's), so a session kept for its chat was started
   *  in another folder. */
  adopted?: boolean
  /** True when a change task runs in the checkout itself, which already
   *  has the source branch checked out. */
  inCheckout?: boolean
}

export interface WorktreeDeps {
  exec: ExecFn
  log?: (line: string) => void
  now?: () => number
}

const short = (s: string) => s.trim().slice(0, 300)

function issueWorktreeDir(target: WorktreeTarget, checkout: string, settings: Pick<TaskWorktreeSettings, "root">): string {
  return join(worktreeRoot(checkout, settings), worktreeBranch(target).replace(/^agentx\//, "").replace(/[^A-Za-z0-9._-]+/g, "-"))
}

function changeWorktreeDir(target: WorktreeTarget, checkout: string, settings: Pick<TaskWorktreeSettings, "root">): string {
  return join(worktreeRoot(checkout, settings), `${target.source === "gitlab" ? "mr" : "pr"}-${target.id}`)
}

/** Whether a task on the target would find a folder already set up for
 *  it, rather than a new worktree: the issue's worktree, or for a change
 *  its `pr-<n>` / `mr-<n>` worktree or any folder of the checkout
 *  (the checkout included) that has `branch` checked out. Makes nothing. */
export async function hasTargetWorktree(target: WorktreeTarget, branch: string | undefined, checkout: string, settings: Pick<TaskWorktreeSettings, "root">, exec: ExecFn): Promise<boolean> {
  if (target.kind !== "change") return existsSync(join(issueWorktreeDir(target, checkout, settings), ".git"))
  if (existsSync(join(changeWorktreeDir(target, checkout, settings), ".git"))) return true
  if (!branch) return false
  const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: checkout, timeoutMs: 60_000 })
  return list.code === 0 && !!worktreeHolding(list.stdout, branch)
}

/** Makes (or finds) the worktree for one issue. Never switches, resets or
 *  deletes anything in the checkout: the branch is created only when it
 *  does not exist yet, from the remote branch of the same name when there
 *  is one (an earlier task pushed it), else from the default branch. */
export async function prepareTaskWorktree(target: WorktreeTarget, checkout: string, settings: TaskWorktreeSettings, deps: WorktreeDeps): Promise<TaskWorktree | { error: string }> {
  const git = (args: string[], cwd: string) => deps.exec("git", args, { cwd, timeoutMs: 120_000 })
  const branch = worktreeBranch(target)
  const root = worktreeRoot(checkout, settings)
  const dir = issueWorktreeDir(target, checkout, settings)

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
    // From the issue's pushed branch (an earlier task, or the node it ran
    // on before a move, #2104 B3), tracking it so the next push and the
    // move check (`@{u}..HEAD`) see the same branch. From the default
    // branch, never tracking it: a plain `git push` must not land there.
    args = ["worktree", "add", remote.code === 0 ? "--track" : "--no-track", "-b", branch, dir, base]
  }
  mkdirSync(root, { recursive: true })
  const added = await git(args, checkout)
  if (added.code !== 0) return { error: `could not create the worktree for ${branch}: ${short(added.stderr)}` }
  touch(dir, deps.now)
  return { dir, branch, checkout, reused: false }
}

/** Makes (or finds) the worktree for a pull or merge request, on its
 *  source branch `branch`. A worktree of the checkout that already has the
 *  branch checked out (the checkout itself too) is reused; else one is added under the root, on the
 *  local branch when there is one, else on a new local branch tracking
 *  `origin/<branch>`. Never checks a branch out twice, and never switches,
 *  resets or deletes anything in the checkout. */
export async function prepareChangeWorktree(target: WorktreeTarget, branch: string, checkout: string, settings: TaskWorktreeSettings, deps: WorktreeDeps): Promise<TaskWorktree | { error: string }> {
  const git = (args: string[], cwd: string) => deps.exec("git", args, { cwd, timeoutMs: 120_000 })
  const change = target.source === "gitlab" ? "merge request" : "pull request"
  const root = worktreeRoot(checkout, settings)
  const dir = changeWorktreeDir(target, checkout, settings)

  const fetched = await git(["fetch", "origin", branch], checkout)
  if (fetched.code !== 0) deps.log?.(`[worktrees] fetch of ${branch} in ${checkout} failed, using what is there: ${short(fetched.stderr)}`)
  // A worktree removed by hand leaves a stale entry that would be reused.
  await git(["worktree", "prune"], checkout)
  const list = await git(["worktree", "list", "--porcelain"], checkout)
  if (list.code !== 0) return { error: `git worktree list failed in ${checkout}: ${short(list.stderr)}` }
  const holder = worktreeHolding(list.stdout, branch)
  if (holder) {
    // The checkout itself is on the branch: work there, never check the
    // branch out a second time.
    if (samePath(holder, checkout)) return { dir: checkout, branch, checkout, reused: true, change, inCheckout: true }
    if (samePath(holder, dir)) {
      touch(dir, deps.now)
      return { dir, branch, checkout, reused: true, change }
    }
    touch(holder, deps.now)
    return { dir: holder, branch, checkout, reused: true, change, adopted: true }
  }
  if (existsSync(join(dir, ".git"))) {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)
    return { error: `${dir} exists but is not on ${branch}${head.code === 0 ? ` (it is on ${head.stdout.trim()})` : ""}; remove it or check out ${branch} there` }
  }

  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], checkout)
  let args: string[]
  if (local.code === 0) {
    args = ["worktree", "add", dir, branch]
  } else {
    const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], checkout)
    if (remote.code !== 0) return { error: `origin has no branch ${branch}` }
    args = ["worktree", "add", "--track", "-b", branch, dir, `origin/${branch}`]
  }
  mkdirSync(root, { recursive: true })
  const added = await git(args, checkout)
  if (added.code !== 0) return { error: `could not create the worktree for ${branch}: ${short(added.stderr)}` }
  touch(dir, deps.now)
  return { dir, branch, checkout, reused: false, change }
}

/** Git lists worktrees by their real path (/private/var, not /var). */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p) } catch { return resolve(p) } }
  return real(a) === real(b)
}

/** The folder of the worktree that has `branch` checked out, from
 *  `git worktree list --porcelain`. */
export function worktreeHolding(porcelain: string, branch: string): string | undefined {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim())
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length)
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path
  }
  return undefined
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

/** In every agent's system prompt, worktree or not: the marker it ends its
 *  PR/MR bodies with, by which the CI fix loop finds the change's agent
 *  (#2102 review). */
export function requestMarkerInstruction(agentId: string): string {
  return `End every pull request or merge request description you write with the line \`<!-- agentx:${agentId} -->\`: that is how a failed CI run on it finds you.`
}

/** Told to the agent with the task, so it commits on the right branch. */
export function worktreeInstructions(wt: TaskWorktree): string {
  if (wt.change) {
    return [
      wt.inCheckout
        ? `You are working in ${wt.dir}, which has this ${wt.change}'s branch \`${wt.branch}\` checked out.`
        : `You are working in a git worktree on this ${wt.change}'s branch: ${wt.dir}, on the branch \`${wt.branch}\`.`,
      `Make your changes there, commit them on \`${wt.branch}\` and push to that branch to update the ${wt.change}; do not open a new one.`,
      wt.inCheckout ? "Do not switch branches." : `Do not switch branches and do not edit ${wt.checkout}: other tasks use it.`,
    ].join(" ")
  }
  return [
    `You are working in a git worktree of your own for this issue: ${wt.dir}, on the branch \`${wt.branch}\`.`,
    `Make your changes there, commit them on \`${wt.branch}\`, push that branch, and open the pull request (or merge request) from it.`,
    `Do not switch branches and do not edit ${wt.checkout}: other tasks use it.`,
  ].join(" ")
}

// --- Running an issue on another node (#2104) ---

/** "owner/repo" of each folder's origin, once each (case-insensitive), in
 *  order: what this node advertises as `checkouts` in its agent card, so
 *  the Hub offers only nodes that have the issue's repository (B4). */
export function checkoutsOf(dirs: string[], remoteOf: (dir: string) => string | undefined = originRemoteOf): string[] {
  const out = new Map<string, string>()
  for (const dir of new Set(dirs.filter(Boolean))) {
    const path = remotePath(remoteOf(dir))
    if (path && !out.has(path.toLowerCase())) out.set(path.toLowerCase(), path)
  }
  return [...out.values()]
}

/** The issue worktree folder of a target, made or not. */
export function issueWorktreePath(target: WorktreeTarget, checkout: string, settings: Pick<TaskWorktreeSettings, "root">): string {
  return issueWorktreeDir(target, checkout, settings)
}

export interface IssueWorktreeState { branch: string; dirty: boolean; ahead: number }

/** The state of an issue worktree a move checks (#2104 B3): its branch,
 *  whether it holds uncommitted changes (`git status --porcelain`), and
 *  how many commits are not pushed: `git rev-list --count @{u}..HEAD`, or
 *  for a branch with no upstream yet, the commits on no origin branch.
 *  Null when the folder is no worktree. A git command that fails counts
 *  as dirty, so a move is refused rather than made on a guess. */
export async function issueWorktreeState(dir: string, exec: ExecFn): Promise<IssueWorktreeState | null> {
  if (!existsSync(join(dir, ".git"))) return null
  const git = (args: string[]) => exec("git", args, { cwd: dir, timeoutMs: 60_000 })
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"])
  const branch = head.code === 0 ? head.stdout.trim() : "unknown"
  const status = await git(["status", "--porcelain"])
  const dirty = status.code !== 0 || !!status.stdout.trim()
  let count = await git(["rev-list", "--count", "@{u}..HEAD"])
  if (count.code !== 0) count = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])
  const ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : 1
  return { branch, dirty, ahead }
}
