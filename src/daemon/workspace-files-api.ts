import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs"
import { basename, join, relative, resolve, sep } from "path"
import { hasHiddenPart, isGhHosts, isGhHostsPath, isHiddenName, workspaceParts } from "@/daemon/workspace-path-guard"

// --- GET /agents/:id/workspace?path=<rel>: an agent's workspace, read only (#2101 R17) ---
//
// The Hub's right panel shows the agent's workspace next to a run or a chat:
// one folder at a time, and a text file opened in the panel. The dashboard
// reaches it through GET /api/task/workspace (owner only, board-dashboard.ts),
// which sends the node's own token; the daemon route is mesh-gated
// (mesh-auth.ts isMeshGatedPath).
//
// Whatever the path says, only something whose real location (links
// followed) is the workspace or inside it is listed or read:
//   - the path is relative, without `..`, NUL or a drive letter;
//   - a link that leads out of the workspace is refused, and left out of a
//     folder's list;
//   - a file is read only when it is text and at most WORKSPACE_FILE_MAX bytes;
//   - names that usually hold secrets (.env, keys, tokens, .ssh, cloud and
//     package-registry logins) are never listed or read, nor are .git and
//     node_modules (the list and path checks are workspace-path-guard.ts's,
//     shared with GET /agents/:id/workspace/<file>, #2316): checked on every part of the path as asked AND of the
//     real path. The real path comes from realpathSync.native, which gives
//     the names as stored on disk, so a case-insensitive or Unicode-folding
//     file system (".SSH", ".ſſh" on APFS) or a link to a hidden folder
//     ("notes -> .ssh") cannot reach a hidden name under another spelling.
//   - the gh CLI's login file (gh/hosts.yml) is hidden by its parent folder's
//     name, so a hosts.yml elsewhere stays visible.
//
// Not caught: a hard link. It has no target to follow, so a hard link inside
// the workspace to a secret file elsewhere (or to a hidden name under another
// name) is read as an ordinary file. Only symlinks and the real path's names
// are checked.

export const WORKSPACE_FILE_MAX = 256 * 1024
const DIR_MAX = 500
/** Names looked at in one folder before the list stops (each costs an lstat). */
const DIR_SCAN_MAX = 5000

export interface WorkspaceEntry { name: string; kind: "dir" | "file"; size: number }

export type WorkspaceRead =
  | { ok: true; kind: "dir"; root: string; path: string; entries: WorkspaceEntry[]; more: boolean }
  | { ok: true; kind: "file"; root: string; path: string; size: number; content: string }
  | { ok: false; status: number; error: string }

/** One folder's list or one text file, from an agent's workspace. */
export function readWorkspace(workspace: string, path: string, cwd = process.cwd()): WorkspaceRead {
  if (!workspace) return { ok: false, status: 404, error: "the agent has no workspace" }
  const parts = workspaceParts(path)
  if (!Array.isArray(parts)) return { ok: false, ...parts }
  let root: string
  try { root = realpathSync.native(resolve(cwd, workspace)) } catch { return { ok: false, status: 404, error: "the agent's workspace is missing" } }
  const inside = (real: string) => real === root || real.startsWith(root + sep)
  let real: string
  try { real = realpathSync.native(join(root, ...parts)) } catch { return { ok: false, status: 404, error: "not found" } }
  if (!inside(real)) return { ok: false, status: 403, error: "the path leads out of the workspace" }
  // The real path, names as stored on disk: a link inside the workspace, or a
  // spelling the file system folds, may still lead to a name never read.
  if (hasHiddenPart(relative(root, real)) || isGhHostsPath(real)) return { ok: false, status: 403, error: "this file is not shown" }
  const rel = parts.join("/")
  let st: ReturnType<typeof statSync>
  try { st = statSync(real) } catch { return { ok: false, status: 404, error: "not found" } }
  if (st.isDirectory()) {
    const entries: WorkspaceEntry[] = []
    let names: string[] = []
    try { names = readdirSync(real) } catch { return { ok: false, status: 403, error: "the folder cannot be read" } }
    const scanned = names.length > DIR_SCAN_MAX
    for (const name of names.slice(0, DIR_SCAN_MAX)) {
      if (isHiddenName(name) || isGhHosts(name, basename(real))) continue
      const abs = join(real, name)
      try {
        let s = lstatSync(abs)
        if (s.isSymbolicLink()) {
          const to = realpathSync.native(abs)
          if (!inside(to) || hasHiddenPart(relative(root, to)) || isGhHostsPath(to)) continue
          s = statSync(to)
        }
        if (s.isDirectory()) entries.push({ name, kind: "dir", size: 0 })
        else if (s.isFile()) entries.push({ name, kind: "file", size: s.size })
      } catch { /* a broken link or a file gone meanwhile */ }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
    return { ok: true, kind: "dir", root, path: rel, entries: entries.slice(0, DIR_MAX), more: scanned || entries.length > DIR_MAX }
  }
  if (!st.isFile()) return { ok: false, status: 415, error: "not a file" }
  if (st.size > WORKSPACE_FILE_MAX) return { ok: false, status: 413, error: `the file is too big to show here (over ${WORKSPACE_FILE_MAX / 1024} KB)` }
  // real has no link left in it; O_NOFOLLOW refuses one swapped in meanwhile.
  let fd: number
  try { fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch { return { ok: false, status: 404, error: "not found" } }
  let buf: Buffer
  try {
    const size = Math.min(fstatSync(fd).size, WORKSPACE_FILE_MAX)
    buf = Buffer.alloc(size)
    let at = 0
    while (at < size) { const n = readSync(fd, buf, at, size - at, at); if (!n) break; at += n }
    buf = buf.subarray(0, at)
  } finally { closeSync(fd) }
  if (buf.includes(0)) return { ok: false, status: 415, error: "not a text file" }
  return { ok: true, kind: "file", root, path: rel, size: buf.length, content: buf.toString("utf-8") }
}
