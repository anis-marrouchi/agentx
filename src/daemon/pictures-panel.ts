import type { IncomingMessage, ServerResponse } from "http"
import {
  listPictures, PICTURE_ID, PICTURE_KINDS, PICTURE_TYPE, PictureError, pictureUrl, readPicture, readPictureBody,
  removePicture, setPicture, type PictureKind,
} from "@/pictures/pictures"

// --- Dashboard side of profile pictures (#1425) ---
//
//   GET    /api/admin/pictures                     every picture: { agent: {id: url}, person: {id: url} }
//   PUT    /api/admin/pictures/<agent|person>/<id> set or replace one (the body is the file)
//   DELETE /api/admin/pictures/<agent|person>/<id> remove one: the initials show again
//   GET    /api/pictures/<agent|person>/<id>?v=<version>   the picture itself
//
// And on the daemon, for an agent's own run (agentx agent picture, the
// agentx_picture tool):
//   PUT    /api/agent-picture?agent=<id>           set its own picture (the body is the file)
//   DELETE /api/agent-picture?agent=<id>           remove it
// The run the call names (X-AgentX-Task, or X-AgentX-Channel and
// X-AgentX-Chat) must be a running turn of that agent: one agent cannot
// change another's picture. Off this machine it also needs the mesh token
// (mesh-auth.ts).
//
// The /api/admin routes run after the dashboard token gate, so only the
// owner sets or removes a picture here; a write also needs X-Requested-With
// from a same-origin page. The picture itself is served before the gate,
// because an <img> sends no token: it answers only for the exact version
// the gated list names (the start of the picture's sha256), so it shows
// nothing to a caller that could not read the list.

export const PICTURES_API = "/api/admin/pictures"
const SERVE = /^\/api\/pictures\/(agent|person)\/([^/]+)$/
const ONE = /^\/api\/admin\/pictures\/(agent|person)\/([^/]+)$/

export interface PicturesPanelDeps {
  root: string
  /** The agents and people agentx.json lists now: a picture is only for them. */
  agentIds: () => string[]
  personIds: () => string[]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

/** Every picture of this node, as addresses a page can load. */
export function pictureUrls(root: string): Record<PictureKind, Record<string, string>> {
  const out = { agent: {}, person: {} } as Record<PictureKind, Record<string, string>>
  for (const kind of PICTURE_KINDS) {
    for (const [id, version] of Object.entries(listPictures(root, kind))) out[kind][id] = pictureUrl(kind, id, version)
  }
  return out
}

/** GET /api/pictures/<kind>/<id>?v=<version>, before the token gate. False when not ours. */
export function servePicture(req: IncomingMessage, res: ServerResponse, path: string, url: URL, root: string): boolean {
  const m = path.match(SERVE)
  if (!m) return false
  if ((req.method || "GET").toUpperCase() !== "GET") { sendJson(res, 405, { error: "GET only" }); return true }
  const id = decodeURIComponent(m[2])
  const bytes = readPicture(root, m[1] as PictureKind, id, url.searchParams.get("v") || "")
  if (!bytes) { sendJson(res, 404, { error: "no such picture" }); return true }
  res.writeHead(200, {
    "Content-Type": PICTURE_TYPE,
    "Content-Length": String(bytes.length),
    // The address changes with the picture, so a browser may keep it for good.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  })
  res.end(bytes)
  return true
}

/** The /api/admin/pictures routes, after the token gate. False when not ours. */
export async function handlePicturesPanel(req: IncomingMessage, res: ServerResponse, path: string, deps: PicturesPanelDeps): Promise<boolean> {
  if (path !== PICTURES_API && !path.startsWith(`${PICTURES_API}/`)) return false
  const method = (req.method || "GET").toUpperCase()

  if (path === PICTURES_API) {
    if (method !== "GET") { sendJson(res, 405, { error: "GET only" }); return true }
    sendJson(res, 200, pictureUrls(deps.root))
    return true
  }

  const m = path.match(ONE)
  if (!m) { sendJson(res, 404, { error: "not found" }); return true }
  if (method !== "PUT" && method !== "DELETE") { sendJson(res, 405, { error: "PUT or DELETE only" }); return true }
  const xrw = req.headers["x-requested-with"]
  if (xrw !== "agentx-board" && xrw !== "agentx-admin") {
    sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
    return true
  }
  const kind = m[1] as PictureKind
  const id = decodeURIComponent(m[2])
  const known = kind === "agent" ? deps.agentIds() : deps.personIds()
  if (!PICTURE_ID.test(id) || !known.includes(id)) {
    sendJson(res, 404, { error: kind === "agent" ? `no agent "${id}" in agentx.json` : `no person "${id}" in agentx.json` })
    return true
  }

  if (method === "DELETE") {
    const removed = removePicture(deps.root, kind, id)
    sendJson(res, 200, { ok: true, removed })
    return true
  }
  try {
    const bytes = await readPictureBody(req)
    const saved = await setPicture(deps.root, kind, id, bytes)
    sendJson(res, 200, { ok: true, url: saved.url })
  } catch (e: any) {
    if (e instanceof PictureError) { sendJson(res, e.status, { error: e.message }); return true }
    throw e
  }
  return true
}

export interface AgentPictureDeps {
  root: string
  /** The agent whose running turn the request's proof names, or null.
   *  `claimed` is the agent the caller says it is (for a chat proof). */
  provenAgent: (claimed?: string) => string | null
}

/** PUT or DELETE /api/agent-picture on the daemon: an agent's own picture. */
export async function handleAgentPicture(req: IncomingMessage, res: ServerResponse, url: URL, deps: AgentPictureDeps): Promise<void> {
  const method = (req.method || "GET").toUpperCase()
  if (method !== "PUT" && method !== "DELETE") { sendJson(res, 405, { error: "PUT or DELETE only" }); return }
  const claimed = url.searchParams.get("agent")?.trim() || undefined
  const agentId = deps.provenAgent(claimed)
  if (!agentId) {
    sendJson(res, 403, { error: "Only an agent sets its own picture, from its own run: send X-AgentX-Task (or X-AgentX-Channel and X-AgentX-Chat) of a running turn. The owner sets pictures in Settings." })
    return
  }
  if (claimed && claimed !== agentId) {
    sendJson(res, 403, { error: `An agent can only change its own picture: this run is "${agentId}", not "${claimed}".` })
    return
  }
  if (method === "DELETE") { sendJson(res, 200, { ok: true, agent: agentId, removed: removePicture(deps.root, "agent", agentId) }); return }
  try {
    const saved = await setPicture(deps.root, "agent", agentId, await readPictureBody(req))
    sendJson(res, 200, { ok: true, agent: agentId, url: saved.url })
  } catch (e: any) {
    if (e instanceof PictureError) { sendJson(res, e.status, { error: e.message }); return }
    throw e
  }
}
