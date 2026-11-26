import { realpathSync } from "fs"
import { basename, dirname, join, relative, resolve, sep } from "path"

// --- Where a path asked for in an agent's workspace really is (#2316) ---
//
// Shared by the routes that read a file from an agent's workspace by a path
// the caller chooses: GET /agents/:id/workspace/<file> (index.ts), which
// serves /chat artifacts. Whatever the path says, only something whose real
// location (links followed) is inside the workspace is returned:
//   - the path is relative, without `..`, NUL, `~` or a drive letter;
//   - a link that leads out of the workspace is refused;
//   - names that usually hold secrets (.env, keys, tokens, .ssh, cloud and
//     package-registry logins), .git and node_modules are refused: checked on
//     every part of the path as asked AND of the real path. The real path
//     comes from realpathSync.native, which gives the names as stored on
//     disk, so a case-insensitive file system (".ENV") or a link to a hidden
//     file ("notes.txt -> .env") cannot reach a hidden name another way;
//   - the gh CLI's login file (gh/hosts.yml) is hidden by its parent folder's
//     name, so a hosts.yml elsewhere stays visible.
//
// The Files tab (#2315, workspace-files-api.ts) imports its name checks from
// here, so both routes hide the same names.

const PATH_MAX = 1024

/** Largest file GET /agents/:id/workspace/<file> serves. Above the 20 MB a
 *  declared artifact may have (ARTIFACT_LIMITS), as /chat callers may also
 *  open videos and other files the agent wrote. */
export const WORKSPACE_FILE_ROUTE_MAX = 50 * 1024 * 1024

/** Names never served or listed: version control, packages, and what usually holds secrets. */
export function isHiddenName(name: string): boolean {
  const n = name.toLowerCase()
  return n === ".git" || n === "node_modules" ||
    // .env, .env.local, .env-local, prod.env, and direnv's .envrc.
    n === ".env" || /^\.env[-.]/.test(n) || /\.env$/.test(n) || n === ".envrc" ||
    n === ".npmrc" || n === ".netrc" || n === ".pgpass" ||
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(n) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) ||
    // secrets.yaml, secrets.prod.json, credentials.yml.enc; any *credentials.json
    // (gcloud's application_default_credentials.json).
    /^(credentials|secrets?|tokens?)(\.[a-z0-9]+)*$/.test(n) || /credentials\.json$/.test(n) || n === "auth.json" ||
    // Logins of git, Claude, MCP servers, Python packages; whole folders of
    // SSH, GnuPG, Docker and Kubernetes logins (.docker/config.json, .kube/config).
    n === ".git-credentials" || n === ".credentials.json" || n === ".mcp.json" || n === "settings.local.json" ||
    n === ".pypirc" || n === ".ssh" || n === ".gnupg" || n === ".docker" || n === ".kube"
}

/** The gh CLI's login file: hosts.yml directly inside a folder named gh. */
export function isGhHosts(name: string, parent: string): boolean {
  return name.toLowerCase() === "hosts.yml" && parent.toLowerCase() === "gh"
}

/** Whether a real (absolute) path is the gh CLI's login file. */
export function isGhHostsPath(real: string): boolean {
  return isGhHosts(basename(real), basename(dirname(real)))
}

/** Whether any part of a path relative to the workspace is a hidden name. */
export function hasHiddenPart(rel: string): boolean {
  return rel.split(/[\\/]+/).some((s) => s && isHiddenName(s))
}

/** The relative path's parts, or why it is refused. "" or "." is the workspace itself. */
export function workspaceParts(path: string): string[] | { status: number; error: string } {
  const p = String(path ?? "")
  if (p.length > PATH_MAX || p.includes("\0")) return { status: 400, error: "bad path" }
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p) || p.startsWith("~")) return { status: 400, error: "the path must be relative to the workspace" }
  const parts = p.split(/[\\/]+/).filter((s) => s && s !== ".")
  if (parts.includes("..")) return { status: 403, error: "the path leaves the workspace" }
  if (parts.some(isHiddenName) || parts.some((s, i) => i > 0 && isGhHosts(s, parts[i - 1]))) return { status: 403, error: "this file is not shown" }
  return parts
}

export type WorkspaceFileResolution =
  | { ok: true; realPath: string }
  | { ok: false; status: number; error: string }

/**
 * The real path of a file asked for in a workspace, or why it is refused
 * (400 bad path, 403 outside or hidden, 404 missing or not a file name).
 * The caller opens `realPath` with O_NOFOLLOW and checks it is a regular
 * file on the open descriptor.
 */
export function resolveWorkspaceFile(workspaceDir: string, rawPath: string, cwd = process.cwd()): WorkspaceFileResolution {
  if (!workspaceDir) return { ok: false, status: 404, error: "the agent has no workspace" }
  const parts = workspaceParts(rawPath)
  if (!Array.isArray(parts)) return { ok: false, ...parts }
  if (parts.length === 0) return { ok: false, status: 404, error: "file not found" }
  let root: string
  try { root = realpathSync.native(resolve(cwd, workspaceDir)) } catch { return { ok: false, status: 404, error: "the agent's workspace is missing" } }
  let real: string
  try { real = realpathSync.native(join(root, ...parts)) } catch { return { ok: false, status: 404, error: "file not found" } }
  if (!real.startsWith(root + sep)) return { ok: false, status: 403, error: "the path leads out of the workspace" }
  if (hasHiddenPart(relative(root, real)) || isGhHostsPath(real)) return { ok: false, status: 403, error: "this file is not shown" }
  return { ok: true, realPath: real }
}
