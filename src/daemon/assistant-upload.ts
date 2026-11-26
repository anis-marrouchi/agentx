import type { IncomingMessage, ServerResponse } from "http"
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "fs"
import { basename, join, relative, resolve, isAbsolute } from "path"
import { randomBytes } from "crypto"
import { readRaw } from "./voice-io-api"

// --- Hub chat attachments: POST /api/assistant/upload (#2101 PR 2) ---
//
// The Hub chat's ask box attaches files. The file is the request body; the
// query names the agent (?agent=) and the file (?name=). It is kept in the
// agent's workspace, under uploads/, so the agent can read it with its own
// tools, and the turn that follows names its path (acceptAttachments).
//
// Same gate as the rest of /api/assistant: the dashboard proxy lets only
// the owner through, and on the daemon the route is mesh-gated
// (isMeshGatedPath), so off the box it needs a mesh token. The body is
// capped (UPLOAD_MAX_BYTES), the name is cut down to a plain file name so
// it can never leave uploads/, and the file's bytes are never logged.

export const UPLOAD_PATH = "/api/assistant/upload"
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const UPLOADS_DIR = "uploads"
/** Files one message may carry. */
export const ATTACH_MAX = 5

export interface UploadDeps {
  /** The agent's workspace on this node; null for an agent it does not run. */
  workspaceOf: (agentId: string) => string | null
  maxBytes?: number
}

/** A plain file name: no folders, no leading dots, safe characters only. */
export function safeUploadName(raw: unknown): string {
  const base = basename(String(raw ?? "").replace(/\\/g, "/"))
  const clean = base.normalize("NFKC").replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, "-").replace(/^[.\-_]+/, "")
  return clean.slice(-100)
}

/** Where an agent's uploads go. */
export function uploadsDirOf(workspace: string): string {
  return join(resolve(workspace), UPLOADS_DIR)
}

/** `p` is a file in the agent's uploads folder (and not a link out of it). */
export function isUploadPath(workspace: string, p: unknown): boolean {
  if (typeof p !== "string" || !p || !isAbsolute(p)) return false
  const dir = uploadsDirOf(workspace)
  const rel = relative(dir, resolve(p))
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) return false
  try {
    if (!lstatSync(dir).isDirectory()) return false
    const real = realpathSync(p)
    return relative(realpathSync(dir), real) === rel
  } catch { return false }
}

/** The attachments a message may carry: files uploaded for this agent,
 *  at most ATTACH_MAX, each with a display name. Anything else is dropped. */
export function acceptAttachments(workspace: string | null, list: unknown): Array<{ name: string; path: string }> {
  if (!workspace || !Array.isArray(list)) return []
  const out: Array<{ name: string; path: string }> = []
  for (const a of list) {
    if (out.length >= ATTACH_MAX) break
    const path = a && typeof a === "object" ? (a as any).path : null
    if (!isUploadPath(workspace, path)) continue
    out.push({ name: safeUploadName((a as any).name) || basename(path), path: resolve(path) })
  }
  return out
}

/** The line a message with files ends with in the thread, which the Hub
 *  chat draws as file chips (wall-chat-view.ts chatAttached). */
export function attachedLine(files: Array<{ name: string }>): string {
  return "Attached: " + files.map(f => f.name).join(", ")
}

/** A Task page follow-up with files (#2306): the message, then the files
 *  by name and path, so the agent can open them with its own tools. The
 *  follow-up goes into the run as it is, so the paths are part of it. */
export function withAttachedFiles(message: string, files: Array<{ name: string; path: string }>): string {
  if (!files.length) return message
  return `${message}\n\n${attachedLine(files)}\n` +
    "(saved on this computer; open them with your tools when they matter)\n" +
    files.map(f => `- ${f.name}: ${f.path}`).join("\n")
}

export async function handleAssistantUpload(req: IncomingMessage, res: ServerResponse, url: URL, deps: UploadDeps): Promise<void> {
  if (req.method !== "POST") { req.resume(); return json(res, 405, { error: "POST" }) }
  const agent = String(url.searchParams.get("agent") || "").trim()
  if (!agent) { req.resume(); return json(res, 400, { error: "agent required" }) }
  const workspace = deps.workspaceOf(agent)
  if (!workspace) { req.resume(); return json(res, 404, { error: `no agent "${agent}" on this node` }) }
  const name = safeUploadName(url.searchParams.get("name"))
  if (!name) { req.resume(); return json(res, 400, { error: "name required" }) }
  const max = deps.maxBytes ?? UPLOAD_MAX_BYTES
  const body = await readRaw(req, max)
  if (!body) return json(res, 413, { error: `The file is larger than ${Math.round(max / (1024 * 1024))} MB.` })
  if (!body.length) return json(res, 400, { error: "The file is empty." })

  const dir = uploadsDirOf(workspace)
  mkdirSync(dir, { recursive: true })
  if (!lstatSync(dir).isDirectory()) return json(res, 409, { error: "Uploads must be a directory in the agent workspace." })
  // The workspace is often a git repository: uploads stay out of it.
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const path = join(dir, `${stamp}-${randomBytes(4).toString("hex")}-${name}`)
  writeFileSync(path, body, { mode: 0o600, flag: "wx" })
  json(res, 200, { name, path, size: body.length })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}
