import { execFile } from "child_process"
import { existsSync, realpathSync, statSync } from "fs"
import { dirname, relative, resolve, sep } from "path"
import { promisify } from "util"
import type { InterruptedRun } from "@/storage/traces"

// --- What a cut-off run left behind (#1256) ---
//
// A run's background helpers (Claude Code `Agent` calls with
// `run_in_background`) live inside the run's own process, so a restart
// kills them with it and they have no trace row to resume. What survives
// is their folders: clones with changes nobody committed or pushed. The
// run's recorded tool calls name those folders (a builder's `cd /tmp/…`
// is streamed under its parent), so after a restart we look at each one
// and list the ones that still hold work, for the resumed run or, when it
// isn't resumed, for the operator.

// A run can read hundreds of files before it names the next clone, so the
// raw-path cap is loose; the real budget is distinct folders asked about.
const MAX_PATHS = 2_000
const MAX_DIRS = 200
const MAX_FOLDERS = 20
const GIT_TIMEOUT_MS = 5_000
const MAX_HELPERS = 10

/** A git folder a cut-off run touched that still holds unsaved work. */
export interface LeftWork {
  path: string
  branch: string | null
  /** Files with changes not committed (staged, unstaged or new). */
  changedFiles: number
  /** Commits on no remote branch. */
  unpushedCommits: number
}

export type FindLeftWork = (run: InterruptedRun) => Promise<LeftWork[]>

/** Background helpers the run started: their descriptions, in order. */
export function backgroundHelpers(run: Pick<InterruptedRun, "toolCalls">): string[] {
  const out: string[] = []
  for (const c of run.toolCalls) {
    if (c.action !== "Agent" && c.action !== "Task") continue
    const input = c.inputSummary ?? ""
    if (!/"run_in_background"\s*:\s*true/.test(input)) continue
    const m = input.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    let desc = ""
    if (m) { try { desc = JSON.parse(`"${m[1]}"`) } catch { desc = m[1] } }
    out.push(desc.replace(/\s+/g, " ").trim().slice(0, 120) || "(no description)")
  }
  return out
}

const SYSTEM_ROOTS = ["/dev", "/proc", "/sys", "/usr", "/bin", "/sbin", "/etc", "/lib", "/opt/homebrew", "/System", "/Library"]

/** Absolute paths named in the run's tool-call inputs, first seen first. */
export function pathsInToolCalls(run: Pick<InterruptedRun, "toolCalls">): string[] {
  const seen = new Set<string>()
  // A path starts after a quote, space, `=`, `:` or `(` and runs until a
  // character a shell command or JSON string would end it on.
  const re = /(?:^|[\s"'=:(])(\/[\w.@+~-]+(?:\/[\w.@+~-]+)*)/g
  for (const c of run.toolCalls) {
    const input = (c.inputSummary ?? "").replace(/\\n/g, " ").replace(/\\"/g, "\"")
    for (const m of input.matchAll(re)) {
      const p = resolve(m[1])
      if (p === "/" || SYSTEM_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) continue
      seen.add(p)
      if (seen.size >= MAX_PATHS) return [...seen]
    }
  }
  return [...seen]
}

/** The closest folder that exists at or above `p` (a path may name a file,
 *  or one not created yet), or null. */
function existingDir(p: string): string | null {
  let cur = p
  for (;;) {
    try {
      if (existsSync(cur) && statSync(cur).isDirectory()) return cur
    } catch { /* unreadable: keep walking up */ }
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

type Git = (cwd: string, args: string[]) => Promise<string>

const execFileP = promisify(execFile)
const runGit: Git = async (cwd, args) =>
  (await execFileP("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 })).stdout

/** One folder's unsaved work, or null when it is clean or not in git. */
export async function inspectFolder(root: string, git: Git = runGit): Promise<LeftWork | null> {
  // --no-optional-locks: don't take index.lock in a clone someone may be using.
  const status = await git(root, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"])
  let branch: string | null = null
  let ahead: number | null = null
  let changedFiles = 0
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const b = line.slice("# branch.head ".length).trim()
      branch = b === "(detached)" ? null : b
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)/)
      ahead = m ? Number(m[1]) : 0
    } else if (line && !line.startsWith("#")) {
      changedFiles++
    }
  }
  let unpushedCommits = ahead ?? 0
  if (ahead === null) {
    // No upstream (a fresh local branch): count commits on no remote, but
    // only when there is a remote, or every commit would count.
    const remotes = (await git(root, ["remote"]).catch(() => "")).trim()
    if (remotes) {
      const n = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).catch(() => "0")
      unpushedCommits = Number(n.trim()) || 0
    }
  }
  if (changedFiles === 0 && unpushedCommits === 0) return null
  return { path: root, branch, changedFiles, unpushedCommits }
}

/** `top` (git's real path) as the run named it: `dir` walked up as far as
 *  `top` lies above it. On macOS `/tmp/app` is really `/private/tmp/app`,
 *  and the agent must be shown the path it used. */
function asNamed(dir: string, top: string): string {
  let real: string
  try { real = realpathSync(dir) } catch { return top }
  const rel = relative(top, real)
  if (!rel) return dir
  if (rel.startsWith("..")) return top
  let named = dir
  for (let i = rel.split(sep).length; i > 0; i--) named = dirname(named)
  return named
}

/** The git folders the run's tool calls named that still hold unsaved
 *  work. Bounded, and never throws: a folder git can't read is left out. */
export async function findLeftWork(run: InterruptedRun, git: Git = runGit): Promise<LeftWork[]> {
  const roots = new Map<string, string>() // real top level -> path as named
  const asked = new Set<string>()
  for (const p of pathsInToolCalls(run)) {
    const dir = existingDir(p)
    if (!dir || dir === "/" || asked.has(dir)) continue
    if (asked.size >= MAX_DIRS) break
    asked.add(dir)
    const top = await git(dir, ["rev-parse", "--show-toplevel"]).then((s) => s.trim()).catch(() => "")
    if (!top || roots.has(top)) continue
    roots.set(top, asNamed(dir, top))
    if (roots.size >= MAX_FOLDERS) break
  }
  const out: LeftWork[] = []
  for (const root of roots.values()) {
    const w = await inspectFolder(root, git).catch(() => null)
    if (w) out.push(w)
  }
  return out
}

/** One line per folder: where, which branch, what is unsaved. */
export function describeLeftWork(w: LeftWork): string {
  const what: string[] = []
  if (w.changedFiles) what.push(`${w.changedFiles} changed file${w.changedFiles === 1 ? "" : "s"} not committed`)
  if (w.unpushedCommits) what.push(`${w.unpushedCommits} commit${w.unpushedCommits === 1 ? "" : "s"} not pushed`)
  return `${w.path} (${w.branch ? `branch ${w.branch}` : "no branch"}): ${what.join(", ")}`
}

/** Lines for the resume note about stopped helpers and unsaved folders;
 *  empty when there is nothing to say. */
export function leftWorkNoteLines(helpers: string[], left: LeftWork[]): string[] {
  const lines: string[] = []
  if (helpers.length) {
    lines.push(`The restart also stopped the ${helpers.length} background helper(s) you had started. They are not running any more, and their results will not arrive:`)
    helpers.slice(0, MAX_HELPERS).forEach((h, i) => lines.push(`${i + 1}. ${h}`))
    if (helpers.length > MAX_HELPERS) lines.push(`…and ${helpers.length - MAX_HELPERS} more.`)
  }
  if (left.length) {
    lines.push("These folders still hold work that was not saved. For each one, first check whether the work is yours (a shared checkout can hold someone else's changes). If it is, finish it or start the helper again on it, rather than starting over:")
    for (const w of left) lines.push(`- ${describeLeftWork(w)}`)
  } else if (helpers.length) {
    lines.push("No folder named in your tool calls has unsaved changes. Start them again if their work is still needed.")
  }
  return lines
}
