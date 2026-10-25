import { execFile } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"
import { backgroundHelpers, describeLeftWork, findLeftWork, type LeftWork } from "@/agents/resume/work-left"
import type { ToolCallRef } from "./plan"

// --- Background builders a stopped task had started (#1328) ---
//
// A builder (Claude Code `Agent` with `run_in_background`) runs inside its
// parent's process, so stopping the parent stops it too, and it has no run
// of its own to resume. The parent's trace is the registry: the builder's
// start is one of the parent's tool calls, and the folders it works in are
// named by the calls streamed under the parent (work-left.ts).
//
// Once the stopped run has let go, and before the agent writes its plan,
// each folder with changes nobody committed gets a WIP commit on a branch
// of its own. The commit is built on a separate index and written with
// update-ref: the folder's checkout, branch, index and files stay exactly
// as they were. Commits not pushed are listed as they are: they are in the
// clone already. The agent's plan and the resume note name both, so the
// resumed task starts its builders again from that work.

/** A folder a stopped builder left work in, and where that work is saved. */
export interface BuilderFolder {
  path: string
  /** The branch the folder was on (null: detached). */
  branch: string | null
  changedFiles: number
  unpushedCommits: number
  /** The branch holding the WIP commit of the changes not committed. */
  wipBranch?: string
  /** That commit's id. */
  wipCommit?: string
  /** Why the changes could not be saved; they are still in the folder. */
  error?: string
}

export interface BuilderWindDown {
  /** The builders' descriptions, in the order they were started. */
  helpers: string[]
  folders: BuilderFolder[]
}

type Git = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>

const GIT_TIMEOUT_MS = 15_000
/** How long a stop spends saving builders' folders. A folder not started
 *  by then is listed as not saved; the stop's wait counts this time. */
export const BUILDER_SAVE_MS = 60_000
const execFileP = promisify(execFile)
const runGit: Git = async (cwd, args, env) =>
  (await execFileP("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })).stdout

/** The WIP commit is AgentX's, whatever the folder's git identity. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "AgentX", GIT_AUTHOR_EMAIL: "agentx@localhost",
  GIT_COMMITTER_NAME: "AgentX", GIT_COMMITTER_EMAIL: "agentx@localhost",
}

/** A branch name git accepts, from a task id. */
export function wipBranchName(taskId: string): string {
  const id = taskId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.+/g, ".").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80) || "task"
  return `agentx/wip/${id.endsWith(".lock") ? `${id}-x` : id}`
}

/** Commit everything not committed in `root` (untracked files included,
 *  ignored ones not) to a new branch, without touching the checkout. */
export async function saveWip(root: string, branch: string, message: string, git: Git = runGit): Promise<{ branch: string; commit: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "agentx-wip-"))
  const env = { GIT_INDEX_FILE: join(scratch, "index"), ...IDENTITY }
  try {
    const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim()
    if (head) await git(root, ["read-tree", head], env)
    await git(root, ["add", "-A", "."], env)
    const tree = (await git(root, ["write-tree"], env)).trim()
    const commit = (await git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], env)).trim()
    // A branch named like a folder of the name (`agentx` or `agentx/wip`)
    // keeps git from creating any branch under it: every suffix would fail
    // the same way, so say so at once.
    const blocker = await blockingBranch(root, branch, git)
    if (blocker) throw new Error(`a branch named ${blocker} exists, so git can't create ${branch} next to it; rename that branch (git branch -m ${blocker} <new name>)`)
    // A branch of that name already (an earlier stop of the same task):
    // the next free suffix, never an overwrite. Any other failure (a
    // locked ref, a read-only repo) stops here, with git's own words.
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? branch : `${branch}-${i}`
      try {
        await git(root, ["update-ref", `refs/heads/${name}`, commit, ""])
        return { branch: name, commit }
      } catch (e: any) {
        if (await branchExists(root, name, git)) continue
        throw new Error(`git couldn't create ${name}: ${gitError(e)}`)
      }
    }
    throw new Error(`branches ${branch} to ${branch}-20 are all taken`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function branchExists(root: string, name: string, git: Git): Promise<boolean> {
  return git(root, ["show-ref", "--verify", "-q", `refs/heads/${name}`]).then(() => true, () => false)
}

/** The existing branch whose name is a folder of `branch` (for
 *  `agentx/wip/x`: `agentx` or `agentx/wip`), or null. */
async function blockingBranch(root: string, branch: string, git: Git): Promise<string | null> {
  const parts = branch.split("/")
  for (let i = 1; i < parts.length; i++) {
    const name = parts.slice(0, i).join("/")
    if (await branchExists(root, name, git)) return name
  }
  return null
}

/** Git's own message for a failed command: its stderr, first lines. */
function gitError(e: any): string {
  const err = String(e?.stderr ?? "").trim() || String(e?.message ?? e)
  return err.split("\n").slice(0, 2).join(" ").slice(0, 300)
}

/** Wind down the builders a stopped run had started: undefined when it
 *  started none. Never throws; a folder that cannot be saved says why. */
export async function windDownBuilders(input: {
  taskId: string
  toolCalls: ToolCallRef[]
  reason: string
  findLeftWork?: (run: { toolCalls: ToolCallRef[] }) => Promise<LeftWork[]>
  git?: Git
  now?: () => number
}): Promise<BuilderWindDown | undefined> {
  const helpers = backgroundHelpers(input)
  if (!helpers.length) return undefined
  const now = input.now ?? Date.now
  const deadline = now() + BUILDER_SAVE_MS
  const find = input.findLeftWork ?? ((run) => findLeftWork(run))
  let left: LeftWork[] = []
  try { left = await find(input) } catch { /* no folders known: the helpers are still listed */ }
  const folders: BuilderFolder[] = []
  for (const w of left) {
    const folder: BuilderFolder = { path: w.path, branch: w.branch, changedFiles: w.changedFiles, unpushedCommits: w.unpushedCommits }
    if (w.changedFiles > 0 && now() >= deadline) {
      folder.error = `not saved: the stop's ${BUILDER_SAVE_MS / 1000}s for saving builders ran out`
    } else if (w.changedFiles > 0) {
      try {
        const saved = await saveWip(w.path, wipBranchName(input.taskId), `WIP: saved by AgentX when ${input.reason}\n\nTask ${input.taskId}, on ${w.branch ?? "a detached HEAD"}.`, input.git)
        folder.wipBranch = saved.branch
        folder.wipCommit = saved.commit
      } catch (e: any) {
        folder.error = String(e?.message ?? e).split("\n")[0].slice(0, 200)
      }
    }
    folders.push(folder)
  }
  return { helpers, folders }
}

/** One line per folder: where, what was left, where it is saved. */
export function describeBuilderFolder(f: BuilderFolder): string {
  const base = describeLeftWork({ path: f.path, branch: f.branch, changedFiles: f.changedFiles, unpushedCommits: f.unpushedCommits })
  if (f.wipBranch) return `${base}; saved on branch ${f.wipBranch} (${(f.wipCommit ?? "").slice(0, 12)})`
  if (f.error) return `${base}; NOT saved (${f.error}), still in the folder`
  return base
}

const MAX_LISTED = 10

/** Lines about the builders, for the wind-down message and the resume
 *  note; empty when the task started none. */
export function builderLines(b: BuilderWindDown | undefined, when: "wind-down" | "resume"): string[] {
  if (!b) return []
  const lines = [
    when === "wind-down"
      ? `The stop also stopped the ${b.helpers.length} background builder(s) you had started:`
      : `The stop also stopped the ${b.helpers.length} background builder(s) you had started. They are not running, and their results will not arrive:`,
  ]
  b.helpers.slice(0, MAX_LISTED).forEach((h, i) => lines.push(`${i + 1}. ${h}`))
  if (b.helpers.length > MAX_LISTED) lines.push(`…and ${b.helpers.length - MAX_LISTED} more.`)
  if (b.folders.length) {
    lines.push("Their folders, and where AgentX saved the work not committed (the checkout itself was left as it was):")
    for (const f of b.folders.slice(0, MAX_LISTED)) lines.push(`- ${describeBuilderFolder(f)}`)
    lines.push(when === "wind-down"
      ? "Under Left and Next action, say for each builder what it still had to do and from which branch to start it again."
      : "Start each builder again from its saved branch (check out or merge it in its folder) rather than starting over, if its work is still needed. First check the work is the builder's: a shared checkout can hold someone else's changes.")
  } else {
    lines.push(when === "wind-down"
      ? "No folder named in your tool calls had unsaved changes. Under Left, say what each builder still had to do."
      : "No folder named in your tool calls had unsaved changes. Start them again if their work is still needed.")
  }
  return lines
}
