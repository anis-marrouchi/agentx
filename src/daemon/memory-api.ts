import type { IncomingMessage, ServerResponse } from "http"
import type { AgentMemory, MemoryProvenance } from "@/agents/agent-memory"
import { MemoryConflictError, type WriteCondition } from "@/agents/memory-versions"

// --- Agent-memory HTTP API ---
//
// Agents call this from inside their own session with `curl localhost`
// (the `remember` skill). The route is mesh-gated (mesh-auth.ts), so only
// this machine, or a peer holding the mesh token, reaches it.
//
//   GET    /api/memory?agent=<id>                    → records (with etags) + MEMORY.md
//   GET    /api/memory/<name>?agent=<id>             → one record; ETag header
//   POST   /api/memory   {agentId, type, name, description, body, append?}
//   DELETE /api/memory/<name>?agent=<id>             → remove (kept in history)
//   GET    /api/memory/<name>/versions?agent=<id>    → prior versions, newest first
//   POST   /api/memory/<name>/restore?agent=<id>  {version}
//
// Writes honour If-Match: <etag> (change only the version you read) and
// If-None-Match: * (create only), answering 409 with the current etag.
//
// Identity: an agent's run exports AGENTX_TASK_ID, and the skill sends it
// as X-AgentX-Task. A named task must be running and belong to the agent
// whose memory is being changed, so one agent can't write another's. A
// call without it still works (the operator's tools, agents on runtimes
// that don't export it) and is recorded as author "unverified".

export interface MemoryApiDeps {
  mem: AgentMemory
  /** Agent workspace, to re-sync MEMORY.md into CLAUDE.md after a change. */
  workspaceFor(agentId: string): string | null | undefined
  /** The agent running `taskId` now, or null. */
  runningTaskOwner(taskId: string): { agentId: string } | null
}

const MEMORY_ITEM = /^\/api\/memory\/([^/?]+)$/
const MEMORY_VERSIONS = /^\/api\/memory\/([^/?]+)\/versions$/
const MEMORY_RESTORE = /^\/api\/memory\/([^/?]+)\/restore$/

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => { raw += chunk })
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? ""
}

/** If-Match / If-None-Match as a write condition. Etags may be quoted. */
export function conditionFrom(req: IncomingMessage): WriteCondition | undefined {
  const ifMatch = header(req, "if-match").replace(/^W\//, "").replace(/^"|"$/g, "")
  const ifNoneMatch = header(req, "if-none-match")
  if (!ifMatch && ifNoneMatch !== "*") return undefined
  return {
    ...(ifMatch ? { ifMatch } : {}),
    ...(ifNoneMatch === "*" ? { ifNoneMatch: "*" as const } : {}),
  }
}

type Caller =
  | { ok: true; provenance: MemoryProvenance }
  | { ok: false; status: number; error: string }

/** Who is changing `agentId`'s memory, checked against running tasks. */
export function resolveCaller(
  req: IncomingMessage, agentId: string, deps: Pick<MemoryApiDeps, "runningTaskOwner">,
): Caller {
  const taskId = header(req, "x-agentx-task")
  if (!taskId) return { ok: true, provenance: { author: "unverified" } }
  const owner = deps.runningTaskOwner(taskId)
  if (!owner) return { ok: false, status: 403, error: "X-AgentX-Task names no running task" }
  if (owner.agentId !== agentId) {
    return { ok: false, status: 403, error: `task belongs to "${owner.agentId}"; an agent can only change its own memory` }
  }
  return { ok: true, provenance: { author: owner.agentId, taskId } }
}

function resync(deps: MemoryApiDeps, agentId: string): boolean {
  const ws = deps.workspaceFor(agentId)
  if (ws) { try { deps.mem.syncToWorkspace(agentId, ws) } catch { /* best effort */ } }
  return !!ws
}

/** Handles /api/memory*. Returns false for a path it doesn't own. */
export async function handleMemoryApi(
  req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: MemoryApiDeps,
): Promise<boolean> {
  const { mem } = deps
  const agentQ = url.searchParams.get("agent") || ""

  if (req.method === "GET" && path === "/api/memory") {
    if (!agentQ) { send(res, 400, { error: "missing agent query param" }); return true }
    send(res, 200, { agent: agentQ, memories: mem.list(agentQ), index: mem.indexMarkdown(agentQ) })
    return true
  }

  const versionsMatch = req.method === "GET" && path.match(MEMORY_VERSIONS)
  if (versionsMatch) {
    if (!agentQ) { send(res, 400, { error: "missing agent query param" }); return true }
    send(res, 200, { versions: mem.versions(agentQ, decodeURIComponent(versionsMatch[1])) })
    return true
  }

  const oneMatch = req.method === "GET" && path.match(MEMORY_ITEM)
  if (oneMatch) {
    if (!agentQ) { send(res, 400, { error: "missing agent query param" }); return true }
    const rec = mem.get(agentQ, decodeURIComponent(oneMatch[1]))
    if (!rec) { send(res, 404, { error: "no such memory" }); return true }
    send(res, 200, { memory: rec }, rec.etag ? { ETag: `"${rec.etag}"` } : {})
    return true
  }

  if (req.method === "POST" && path === "/api/memory") {
    let body: any
    try { body = await readJson(req) } catch (e: any) {
      send(res, 400, { error: "invalid JSON body", message: e.message }); return true
    }
    const str = (k: string) => (typeof body?.[k] === "string" ? body[k] : "")
    const agentId = str("agentId"), type = str("type"), name = str("name")
    const description = str("description"), newBody = str("body")
    if (!agentId || !type || !name || !description || !newBody) {
      send(res, 400, { error: "required fields: agentId, type, name, description, body" }); return true
    }
    const caller = resolveCaller(req, agentId, deps)
    if (!caller.ok) { send(res, caller.status, { error: caller.error }); return true }
    try {
      const args = { agentId, type: type as any, name, description, body: newBody, ...caller.provenance }
      const cond = conditionFrom(req)
      const rec = body?.append === true ? mem.append(args, cond) : mem.save(args, cond)
      send(res, 200, { ok: true, memory: rec, syncedToWorkspace: resync(deps, agentId) },
        rec.etag ? { ETag: `"${rec.etag}"` } : {})
    } catch (e: any) {
      if (e instanceof MemoryConflictError) {
        send(res, 409, { error: e.message, currentEtag: e.currentEtag }); return true
      }
      send(res, 400, { error: e?.message || "save failed" })
    }
    return true
  }

  const restoreMatch = req.method === "POST" && path.match(MEMORY_RESTORE)
  if (restoreMatch) {
    if (!agentQ) { send(res, 400, { error: "missing agent query param" }); return true }
    let body: any
    try { body = await readJson(req) } catch (e: any) {
      send(res, 400, { error: "invalid JSON body", message: e.message }); return true
    }
    if (typeof body?.version !== "string" || !body.version) {
      send(res, 400, { error: "required field: version" }); return true
    }
    const caller = resolveCaller(req, agentQ, deps)
    if (!caller.ok) { send(res, caller.status, { error: caller.error }); return true }
    const rec = mem.restore(agentQ, decodeURIComponent(restoreMatch[1]), body.version, caller.provenance)
    if (!rec) { send(res, 404, { error: "no such version" }); return true }
    send(res, 200, { ok: true, memory: rec, syncedToWorkspace: resync(deps, agentQ) })
    return true
  }

  const delMatch = req.method === "DELETE" && path.match(MEMORY_ITEM)
  if (delMatch) {
    if (!agentQ) { send(res, 400, { error: "missing agent query param" }); return true }
    const caller = resolveCaller(req, agentQ, deps)
    if (!caller.ok) { send(res, caller.status, { error: caller.error }); return true }
    try {
      const ok = mem.remove(agentQ, decodeURIComponent(delMatch[1]), conditionFrom(req))
      if (!ok) { send(res, 404, { error: "no such memory" }); return true }
    } catch (e: any) {
      if (e instanceof MemoryConflictError) {
        send(res, 409, { error: e.message, currentEtag: e.currentEtag }); return true
      }
      throw e
    }
    resync(deps, agentQ)
    send(res, 200, { ok: true })
    return true
  }
  return false
}
