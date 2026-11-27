import { existsSync, realpathSync } from "fs"
import { homedir } from "os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "path"
import { runFilesOf } from "@/daemon/ui/pages/wall-files"
import { readWorkspace, type WorkspaceRead } from "@/daemon/workspace-files-api"

// --- GET /agents/:id/project?task=<id>&path=<rel>: the Git project a run works in (#2455) ---
//
// The Hub's right panel has a Project tab next to Run artifacts and
// Workspace: the files of the Git repo (GitHub or GitLab) the agent works
// in, read only. The tab is hidden when there is none.
//
// Which repo: never one the caller names. The node finds it from what the
// agent's own runs did:
//   1. the files the run asked about read, edited or wrote (its record);
//   2. a run still going has no record yet: the agent's newest finished runs;
//   3. else the agent's workspace, when it is itself a Git repo.
// Each file's nearest folder with a `.git` (a clone or a worktree) is a
// candidate; the one most files sit in wins. A candidate counts only when
// its real path is below home and no folder on the way down from home
// starts with a dot (#2460 review B1): a plugin clone under ~/.claude, or
// /opt/homebrew, is never a project. Home itself never is either.
// AgentX's own task worktrees are the one exception (#2460 review B2): a
// `.agentx-worktrees` folder may be on the way (task-worktrees.ts
// worktreeRoot, ssh-run.ts), and so may a folder an agent's
// `worktrees.root` names, where any dot folder below that root is still
// refused. Every other dot folder (~/.claude, ~/.x) stays refused.
//
// The root found for a run is kept for a minute (ROOT_TTL_MS), so clicking
// through folders does not read and parse the transcripts again (C1).
//
// Known limit (accepted in the #2460 review, C2): the paths come from the
// `→ Tool(...)` lines of the run's transcript. A file's text echoed into the
// transcript can look like such a line and point the root at another repo
// below home. It stays owner-only and read only, and the dot-folder and
// home rules above still hold for that repo.
//
// The listing is readWorkspace's with the repo as its root, so the same
// guards hold (links out of the repo, secret names, .git, node_modules,
// text files only). On top, nothing whose name starts with a dot is listed
// or read (Anis, #2455: "hide these dot files, dot folders").

/** Newest finished runs looked at when the run in view has no record yet. */
const RECENT_RUNS = 5

/** The folder AgentX puts task worktrees in, beside a checkout (task-worktrees.ts). */
export const TASK_WORKTREES_DIR = ".agentx-worktrees"

/** The parts of `real` below `top`, or null when it is not strictly below. */
function partsBelow(top: string, real: string): string[] | null {
  const rel = relative(top, real)
  if (!rel || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  return parts[0] === ".." ? null : parts
}

/** Whether a folder may be a project: really below home with no dot folder on
 *  the way but `.agentx-worktrees`, or below an agent's configured worktrees
 *  root with no dot folder under it. */
export function isProjectPlace(root: string, home = homedir(), worktreeRoots: string[] = []): boolean {
  let real: string
  try { real = realpathSync.native(root) } catch { return false }
  let realHome: string
  try { realHome = realpathSync.native(home) } catch { return false }
  const clean = (parts: string[] | null, allowed = "") => !!parts && !parts.some((s) => !s || (s.startsWith(".") && s !== allowed))
  for (const top of worktreeRoots) {
    let realTop: string
    try { realTop = realpathSync.native(top) } catch { continue }
    // A root at or above home (say "/" or "~") would open everything: skip it.
    if (realTop === realHome || partsBelow(realTop, realHome)) continue
    if (clean(partsBelow(realTop, real))) return true
  }
  return clean(partsBelow(realHome, real), TASK_WORKTREES_DIR)
}

/** The nearest folder at or above `dir` that holds a `.git`, when it may be a project. */
export function gitRootOf(dir: string, home = homedir(), worktreeRoots: string[] = []): string | null {
  const stop = new Set([resolve("/"), resolve(home)])
  let d = resolve(dir)
  for (let i = 0; i < 64; i++) {
    if (stop.has(d)) return null
    if (existsSync(join(d, ".git"))) return isProjectPlace(d, home, worktreeRoots) ? d : null
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
  return null
}

/** The repo most of these paths sit in. Relative paths are the workspace's. */
export function projectRootOf(paths: string[], workspace: string, cwd = process.cwd(), home = homedir(), worktreeRoots: string[] = []): string | null {
  const ws = workspace ? resolve(cwd, workspace) : ""
  const count = new Map<string, number>()
  for (const p of paths) {
    const s = String(p || "").trim()
    if (!s || s.includes("\0")) continue
    const abs = isAbsolute(s) ? s : ws ? resolve(ws, s) : ""
    if (!abs) continue
    const root = gitRootOf(dirname(abs), home, worktreeRoots)
    if (root) count.set(root, (count.get(root) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [root, n] of count) if (!best || n > (count.get(best) ?? 0)) best = root
  return best
}

export interface ProjectRuns {
  /** The run in view: its record's transcript, or null while it has none. */
  record: (taskId: string) => { transcript?: string } | null
  /** The agent's newest finished runs' ids, newest first. */
  recent: () => string[]
}

/** The repo the agent works in, for the run in view (see the head of this file). */
export function findProjectRoot(workspace: string, taskId: string, runs: ProjectRuns, cwd = process.cwd(), home = homedir(), worktreeRoots: string[] = []): string | null {
  const pathsIn = (transcript: string | undefined) => runFilesOf(transcript || "", "").files.map((f) => f.path)
  const own = taskId ? runs.record(taskId) : null
  if (own) {
    const root = projectRootOf(pathsIn(own.transcript), workspace, cwd, home, worktreeRoots)
    if (root) return root
  } else {
    const paths = runs.recent().slice(0, RECENT_RUNS).flatMap((id) => pathsIn(runs.record(id)?.transcript))
    const root = projectRootOf(paths, workspace, cwd, home, worktreeRoots)
    if (root) return root
  }
  return workspace ? gitRootOf(resolve(cwd, workspace), home, worktreeRoots) : null
}

/** How long a run's root is kept, so folder clicks do not parse transcripts again. */
export const ROOT_TTL_MS = 60_000
const ROOT_CACHE_MAX = 200
const rootCache = new Map<string, { root: string | null; at: number }>()

/** The run's root from the cache when it is fresh, else found and kept. */
export function cachedProjectRoot(key: string, find: () => string | null, now = Date.now()): string | null {
  const hit = rootCache.get(key)
  if (hit && now - hit.at < ROOT_TTL_MS) return hit.root
  const root = find()
  rootCache.delete(key)
  rootCache.set(key, { root, at: now })
  while (rootCache.size > ROOT_CACHE_MAX) rootCache.delete(rootCache.keys().next().value as string)
  return root
}

/** Whether a name is a dot file or folder. */
export const isDotName = (name: string) => name.startsWith(".")

export type ProjectRead = WorkspaceRead | { ok: true; kind: "none" }

/** One folder's list or one text file of the project, dot names left out. */
export function readProject(root: string | null, path: string): ProjectRead {
  if (!root) return { ok: true, kind: "none" }
  if (String(path || "").split(/[\\/]+/).some((s) => s && isDotName(s))) return { ok: false, status: 403, error: "this file is not shown" }
  let real: string
  try { real = realpathSync.native(root) } catch { return { ok: true, kind: "none" } }
  const out = readWorkspace(real, path)
  if (!out.ok) return out
  // A link inside the repo may still lead to a dot name: check where it really is.
  let to: string
  try { to = realpathSync.native(join(real, out.path)) } catch { return { ok: false, status: 404, error: "not found" } }
  if (relative(real, to).split(sep).some((s) => s && isDotName(s))) return { ok: false, status: 403, error: "this file is not shown" }
  if (out.kind === "file") return out
  // Dot names, and links whose real place is under one, are left out.
  const shown = (name: string) => {
    if (isDotName(name)) return false
    try { return !relative(real, realpathSync.native(join(to, name))).split(sep).some((s) => s && isDotName(s)) } catch { return false }
  }
  return { ...out, entries: out.entries.filter((e) => shown(e.name)) }
}

/** The repo's folder name, for the tab's path. */
export const projectName = (root: string) => root.split(sep).filter(Boolean).pop() || root
