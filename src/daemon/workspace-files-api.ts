import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs"
import { basename, join, resolve, sep } from "path"

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
//   - names that usually hold secrets (.env, keys, tokens) are never listed
//     or read, nor are .git and node_modules.

export const WORKSPACE_FILE_MAX = 256 * 1024
const DIR_MAX = 500
const PATH_MAX = 1024

export interface WorkspaceEntry { name: string; kind: "dir" | "file"; size: number }

export type WorkspaceRead =
  | { ok: true; kind: "dir"; root: string; path: string; entries: WorkspaceEntry[]; more: boolean }
  | { ok: true; kind: "file"; root: string; path: string; size: number; content: string }
  | { ok: false; status: number; error: string }

/** Names never listed or read: version control, packages, and what usually holds secrets. */
export function isHiddenName(name: string): boolean {
  const n = name.toLowerCase()
  return n === ".git" || n === "node_modules" ||
    n === ".env" || n.startsWith(".env.") || n === ".npmrc" || n === ".netrc" || n === ".pgpass" ||
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(n) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) ||
    /^(credentials|secrets?|tokens?)(\.[a-z0-9]+)?$/.test(n) || n === "tokens.json" || n === "auth.json"
}

/** The relative path's parts, or why it is refused. "" or "." is the workspace itself. */
export function workspaceParts(path: string): string[] | { status: number; error: string } {
  const p = String(path ?? "")
  if (p.length > PATH_MAX || p.includes("\0")) return { status: 400, error: "bad path" }
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p) || p.startsWith("~")) return { status: 400, error: "the path must be relative to the workspace" }
  const parts = p.split(/[\\/]+/).filter((s) => s && s !== ".")
  if (parts.includes("..")) return { status: 403, error: "the path leaves the workspace" }
  if (parts.some(isHiddenName)) return { status: 403, error: "this file is not shown" }
  return parts
}

/** One folder's list or one text file, from an agent's workspace. */
export function readWorkspace(workspace: string, path: string, cwd = process.cwd()): WorkspaceRead {
  if (!workspace) return { ok: false, status: 404, error: "the agent has no workspace" }
  const parts = workspaceParts(path)
  if (!Array.isArray(parts)) return { ok: false, ...parts }
  let root: string
  try { root = realpathSync(resolve(cwd, workspace)) } catch { return { ok: false, status: 404, error: "the agent's workspace is missing" } }
  const inside = (real: string) => real === root || real.startsWith(root + sep)
  let real: string
  try { real = realpathSync(join(root, ...parts)) } catch { return { ok: false, status: 404, error: "not found" } }
  if (!inside(real)) return { ok: false, status: 403, error: "the path leads out of the workspace" }
  // A link inside the workspace may point at a name that is never read.
  if (real !== root && isHiddenName(basename(real))) return { ok: false, status: 403, error: "this file is not shown" }
  const rel = parts.join("/")
  const st = statSync(real)
  if (st.isDirectory()) {
    const entries: WorkspaceEntry[] = []
    let names: string[] = []
    try { names = readdirSync(real) } catch { return { ok: false, status: 403, error: "the folder cannot be read" } }
    for (const name of names) {
      if (isHiddenName(name)) continue
      const abs = join(real, name)
      try {
        let s = lstatSync(abs)
        if (s.isSymbolicLink()) {
          const to = realpathSync(abs)
          if (!inside(to) || isHiddenName(basename(to))) continue
          s = statSync(to)
        }
        if (s.isDirectory()) entries.push({ name, kind: "dir", size: 0 })
        else if (s.isFile()) entries.push({ name, kind: "file", size: s.size })
      } catch { /* a broken link or a file gone meanwhile */ }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
    return { ok: true, kind: "dir", root, path: rel, entries: entries.slice(0, DIR_MAX), more: entries.length > DIR_MAX }
  }
  if (!st.isFile()) return { ok: false, status: 415, error: "not a file" }
  if (st.size > WORKSPACE_FILE_MAX) return { ok: false, status: 413, error: `the file is too big to show here (over ${WORKSPACE_FILE_MAX / 1024} KB)` }
  const fd = openSync(real, "r")
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
