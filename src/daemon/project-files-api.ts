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
// candidate; the one most files sit in wins. The home folder and the file
// system's top are never a project, whatever they hold.
//
// The listing is readWorkspace's with the repo as its root, so the same
// guards hold (links out of the repo, secret names, .git, node_modules,
// text files only). On top, nothing whose name starts with a dot is listed
// or read (Anis, #2455: "hide these dot files, dot folders").

/** Newest finished runs looked at when the run in view has no record yet. */
const RECENT_RUNS = 5

/** The nearest folder at or above `dir` that holds a `.git`, below home. */
export function gitRootOf(dir: string, home = homedir()): string | null {
  const stop = new Set([resolve("/"), resolve(home)])
  let d = resolve(dir)
  for (let i = 0; i < 64; i++) {
    if (stop.has(d)) return null
    if (existsSync(join(d, ".git"))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
  return null
}

/** The repo most of these paths sit in. Relative paths are the workspace's. */
export function projectRootOf(paths: string[], workspace: string, cwd = process.cwd(), home = homedir()): string | null {
  const ws = workspace ? resolve(cwd, workspace) : ""
  const count = new Map<string, number>()
  for (const p of paths) {
    const s = String(p || "").trim()
    if (!s || s.includes("\0")) continue
    const abs = isAbsolute(s) ? s : ws ? resolve(ws, s) : ""
    if (!abs) continue
    const root = gitRootOf(dirname(abs), home)
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
export function findProjectRoot(workspace: string, taskId: string, runs: ProjectRuns, cwd = process.cwd(), home = homedir()): string | null {
  const pathsOf = (id: string) => runFilesOf(runs.record(id)?.transcript || "", "").files.map((f) => f.path)
  if (taskId) {
    const root = runs.record(taskId) ? projectRootOf(pathsOf(taskId), workspace, cwd, home) : null
    if (root) return root
  }
  if (!taskId || !runs.record(taskId)) {
    const paths = runs.recent().slice(0, RECENT_RUNS).flatMap(pathsOf)
    const root = projectRootOf(paths, workspace, cwd, home)
    if (root) return root
  }
  return workspace ? gitRootOf(resolve(cwd, workspace), home) : null
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
