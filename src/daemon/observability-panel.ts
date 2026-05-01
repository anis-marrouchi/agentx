import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { renderObservabilityPage } from "./ui/pages/observability"
import type { TopbarPeer } from "./topbar"

// --- /admin/observability — surface the SQLite tables that have no UI ---
//
// route_traces, rotations, and task_history(error rows) were CLI-only before
// this panel landed. The page is a read-only window over the same tables
// `agentx db routes / db rotations / db tasks --status error` already
// expose; the JSON API just makes them visible in the dashboard.
//
// Each request opens a short-lived read-only handle. The dashboard process
// doesn't keep one — the daemon owns the writes via WAL — so we don't fight
// for the SHM lock; concurrent reads are the WAL's whole point.

interface OpenedDb {
  db: Database.Database
  close: () => void
}

function openReadOnly(): OpenedDb | null {
  const path = resolve(process.cwd(), ".agentx/db.sqlite")
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

export function handleObservabilityGet(_req: IncomingMessage, res: ServerResponse, peers: TopbarPeer[] = []): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderObservabilityPage({ peers }))
}

interface QueryParams {
  limit: number
  agent?: string
}

function parseQuery(req: IncomingMessage): QueryParams {
  const url = new URL(req.url || "/", "http://_")
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50
  const agent = url.searchParams.get("agent") || undefined
  return { limit, agent: agent && agent.length > 0 ? agent : undefined }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function handleObservabilityApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith("/api/admin/observability/")) return false
  const slug = path.replace(/^\/api\/admin\/observability\//, "").split("?")[0]

  const opened = openReadOnly()
  if (!opened) {
    sendJson(res, 503, { error: "operational SQLite not available", rows: [] })
    return true
  }

  try {
    const { limit, agent } = parseQuery(req)
    if (slug === "routing") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT at, channel, chat_id, account_id, kind, deciding_stage, agent_id, reason
        FROM route_traces
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params)
      sendJson(res, 200, { rows })
      return true
    }
    if (slug === "rotations") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT rotated_at, agent_id, channel, reason, last_turn_input_tokens
        FROM rotations
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY rotated_at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params)
      sendJson(res, 200, { rows })
      return true
    }
    if (slug === "errors") {
      const where: string[] = ["status = 'error'"]
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT started_at, agent_id, channel, message_preview, error
        FROM task_history
        WHERE ${where.join(" AND ")}
        ORDER BY started_at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params)
      sendJson(res, 200, { rows })
      return true
    }
    sendJson(res, 404, { error: "unknown observability slice", rows: [] })
    return true
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e), rows: [] })
    return true
  } finally {
    opened.close()
  }
}
