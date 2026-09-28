import type { IncomingMessage, ServerResponse } from "http"
import { Readable } from "stream"
import type { TokenRecord } from "./token-store"
import type { AppChatDeps } from "./app-chat"
import { APP_FILES_PATH, fileHeaders } from "./app-files-api"
import { ARTIFACT_LIMITS } from "@/utils/artifact-sentinel"

// --- Phone app: GET /api/app/files/:id ---
//
// A file an agent declared in its answer (<agentx-artifact>, see
// utils/artifact-sentinel.ts). The conversation store gave it a random id
// when the answer was saved; only the phone that owns that conversation can
// fetch it, and any other id is a 404, whoever asks. Runs behind the device
// token check in app-routes.ts.
//
// The file lives on the computer that ran the agent, so the dashboard asks
// that daemon's mesh-gated GET /app-files (app-files-api.ts): its own daemon
// for a local conversation, the mesh peer's for one pinned to a peer. The
// headers are set here again from the saved record, so a daemon can't make
// the phone run a page.

const FILE_PATH_RE = /^\/api\/app\/files\/([^/]+)$/
/** Waiting for the daemon to start answering; the body may take longer. */
const HEADERS_TIMEOUT_MS = 15_000

export async function handleAppFiles(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppChatDeps,
): Promise<boolean> {
  const m = FILE_PATH_RE.exec(path)
  if (!m) return false
  if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "GET only" })
  const store = deps.store()
  if (!store) return json(res, 503, { error: "The database on this computer is unavailable." })
  let id = ""
  try { id = decodeURIComponent(m[1]) } catch { /* a 404 below */ }
  const file = store.getFile(device.id, id)
  if (!file) return json(res, 404, { error: "no such file" })

  const target = await nodeTarget(file.node, deps)
  if (!target) return json(res, 502, { error: `${file.node} is not linked to this computer's mesh any more.` })

  const ac = new AbortController()
  res.on("close", () => ac.abort())
  const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS)
  let r: Response
  try {
    const qs = new URLSearchParams({ agent: file.agent, file: file.path })
    r = await fetch(`${target.url}${APP_FILES_PATH}?${qs}`, {
      method,
      headers: {
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        ...(typeof req.headers.range === "string" ? { Range: req.headers.range } : {}),
      },
      signal: ac.signal,
    })
  } catch {
    return json(res, 502, { error: "The computer that made this file did not answer." })
  } finally {
    clearTimeout(timer)
  }

  if (r.status !== 200 && r.status !== 206) {
    const detail = await r.json().then((j: any) => j?.error).catch(() => "")
    // The daemon's refusals mean something to the phone; anything else is
    // the daemon failing (or too old to have the route).
    const status = [403, 404, 413, 415, 416].includes(r.status) ? r.status : 502
    return json(res, status, { error: detail || `The computer that made this file answered HTTP ${r.status}.` })
  }
  const length = Number(r.headers.get("content-length") || 0)
  if (length > ARTIFACT_LIMITS.bytes) {
    ac.abort()
    return json(res, 413, { error: "the file is too large" })
  }
  const range = r.headers.get("content-range")
  res.writeHead(r.status, {
    ...fileHeaders(file.mime, file.name, file.kind),
    ...(r.headers.get("content-length") ? { "Content-Length": String(length) } : {}),
    ...(r.status === 206 && range ? { "Content-Range": range } : {}),
  })
  if (method === "HEAD" || !r.body) { res.end(); return true }
  // Never more than the cap, whatever the daemon sends.
  let sent = 0
  const body = Readable.fromWeb(r.body as any)
  body.on("data", (chunk: Buffer) => {
    sent += chunk.length
    if (sent > ARTIFACT_LIMITS.bytes) { body.destroy(); res.destroy() }
  })
  body.on("error", () => res.destroy())
  body.pipe(res)
  return true
}

/** The daemon that ran a conversation's agent, with the token it takes. */
async function nodeTarget(node: string, deps: AppChatDeps): Promise<{ url: string; token?: string } | null> {
  if (node === "local") return { url: norm(deps.daemon.url), token: deps.daemon.token }
  const peer = (await deps.meshPeers().catch(() => [])).find((p) => p.peer === node)
  if (!peer) return null
  const url = norm(peer.peerUrl)
  return { url, token: deps.tokenFor?.(url) }
}

function norm(u: string): string {
  return u.replace(/\/+$/, "")
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
  res.end(JSON.stringify(body))
  return true
}
