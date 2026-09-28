import type { IncomingMessage, ServerResponse } from "http"
import { closeSync, createReadStream, fstatSync, openSync, realpathSync } from "fs"
import { isAbsolute, resolve, sep } from "path"
import { ARTIFACT_LIMITS, artifactType } from "@/utils/artifact-sentinel"
import { OUTBOX_DIR } from "@/utils/app-outbox"

// --- GET /app-files: one file an agent declared, for the phone app ---
//
// The daemon half of /api/app/files/:id (app-files.ts). The dashboard keeps
// which files each answer declared and which phone may see them; it asks
// the daemon that ran the agent for the file by agent and declared path.
// Mesh-gated (isMeshGatedPath): a same-host dashboard comes over loopback,
// a dashboard on another computer with a mesh token.
//
// Whatever the path says, only a regular file whose real location (links
// followed) is inside the agent's workspace is served, of an allowed type
// and size, and never as something a browser would run.

export const APP_FILES_PATH = "/app-files"

const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export interface AppFilesApiDeps {
  /** The agent's workspace as configured, or null for an unknown agent. */
  workspaceOf: (agentId: string) => string | null
  /** Relative workspaces resolve against it (the daemon's cwd). */
  cwd?: string
  /** Refusals are logged, so the agent's owner (and the agent, reading the
   *  daemon log) learns why a file never reached the phone. */
  log?: (message: string) => void
}

/** Where a declared path really is, or why it may not be served. */
export function resolveArtifact(
  workspace: string, file: string, cwd = process.cwd(),
): { ok: true; path: string; mime: string; kind: string } | { ok: false; status: number; error: string } {
  if (!file || file.length > ARTIFACT_LIMITS.pathChars || file.includes("\0")) return { ok: false, status: 400, error: "bad file path" }
  if (file.split(/[\\/]/).includes("..")) return { ok: false, status: 403, error: `the path leaves the workspace: copy the file into ${OUTBOX_DIR}/ first` }
  if (!artifactType(file)) return { ok: false, status: 415, error: "this type of file is not served" }
  let root: string
  try { root = realpathSync(resolve(cwd, workspace)) } catch { return { ok: false, status: 404, error: "the agent's workspace is missing" } }
  let real: string
  try { real = realpathSync(isAbsolute(file) ? file : resolve(root, file)) } catch { return { ok: false, status: 404, error: "file not found" } }
  if (!real.startsWith(root + sep)) return { ok: false, status: 403, error: `the file is outside the agent's workspace: copy it into ${OUTBOX_DIR}/ first` }
  // A link inside the workspace may point at a file of another type.
  const type = artifactType(real)
  if (!type) return { ok: false, status: 415, error: "this type of file is not served" }
  return { ok: true, path: real, ...type }
}

/** `inline` for pictures, sound and video; everything else downloads. */
export function contentDisposition(name: string, kind: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_").slice(0, 120) || "file"
  return `${kind === "file" ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 120))}`
}

/** Headers every served file carries, on the daemon and the dashboard. */
export function fileHeaders(mime: string, name: string, kind: string): Record<string, string> {
  return {
    "Content-Type": mime,
    "Content-Disposition": contentDisposition(name, kind),
    "X-Content-Type-Options": "nosniff",
    // Opened on its own, the file runs nothing (an SVG or HTML-looking text).
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  }
}

/** One `bytes=a-b` range within `size`, or null for the whole file. A range
 *  that can't be met is "unsatisfiable". */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number, end: number
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1 }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 }
  if (start > end || start >= size) return "unsatisfiable"
  return { start, end }
}

export function handleAppFilesApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: AppFilesApiDeps): void {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
    res.end(JSON.stringify(body))
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "GET only" })
  const agent = url.searchParams.get("agent") || ""
  const file = url.searchParams.get("file") || ""
  if (!AGENT_RE.test(agent)) return json(400, { error: "bad agent id" })
  const workspace = deps.workspaceOf(agent)
  if (!workspace) return json(404, { error: `no agent "${agent}" on this computer` })
  const found = resolveArtifact(workspace, file, deps.cwd)
  if (!found.ok) {
    deps.log?.(`[app-files] refused ${JSON.stringify(file.slice(0, 200))} from ${agent}: ${found.error}`)
    return json(found.status, { error: found.error })
  }

  let fd: number
  try { fd = openSync(found.path, "r") } catch { return json(404, { error: "file not found" }) }
  let size: number
  try {
    // Checked on the open file, so it can't be swapped after the check.
    const st = fstatSync(fd)
    if (!st.isFile()) { closeSync(fd); return json(404, { error: "not a file" }) }
    size = st.size
  } catch { closeSync(fd); return json(404, { error: "file not found" }) }
  if (size > ARTIFACT_LIMITS.bytes) { closeSync(fd); return json(413, { error: `the file is larger than ${ARTIFACT_LIMITS.bytes / 1024 / 1024} MB` }) }

  const name = found.path.split(sep).pop() || "file"
  const headers = fileHeaders(found.mime, name, found.kind)
  const range = parseRange(req.headers.range, size)
  if (range === "unsatisfiable") {
    closeSync(fd)
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` })
    res.end()
    return
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "Content-Length": String(size ? end - start + 1 : 0),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  })
  if (req.method === "HEAD" || size === 0) { closeSync(fd); res.end(); return }
  const stream = createReadStream("", { fd, start, end, autoClose: true })
  stream.on("error", () => res.destroy())
  res.on("close", () => stream.destroy())
  stream.pipe(res)
}
