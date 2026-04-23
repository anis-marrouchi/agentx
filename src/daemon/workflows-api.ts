import type { IncomingMessage, ServerResponse } from "http"
import {
  LayoutStore,
  RunStore,
  WorkflowStore,
  lintWorkflow,
  workflowSchema,
  type WorkflowLayout,
  type WorkflowRun,
} from "@/workflows"

// --- Workflows HTTP API ---
//
// Powers the /workflows dashboard (observability) + /workflows/editor pages.
// Reads require `dashboard:read`; writes require `dashboard:write`. The
// caller passes in a `requireScope(req, res, [...])` shim so this module
// stays decoupled from src/daemon/token-store.ts. The daemon wires the real
// middleware at boot.
//
// Endpoints:
//   GET  /api/workflows                        — list of workflow definitions
//   POST /api/workflows                        — create a new workflow (body = Workflow JSON)
//   GET  /api/workflows/:id                    — one workflow
//   PUT  /api/workflows/:id                    — full replace (body = Workflow JSON)
//   DELETE /api/workflows/:id                  — delete definition + its layout
//   POST /api/workflows/:id/validate           — schema + lint on the submitted body
//                                                (read-only "would this save?" check)
//   GET  /api/workflows/:id/layout             — node positions for the editor
//   PUT  /api/workflows/:id/layout             — save node positions
//   GET  /api/workflows/runs?limit=N           — recent runs across all workflows
//   GET  /api/workflows/runs/:id               — single run detail
//   GET  /api/workflows/runs/:id/stream        — SSE stream of that run's latest snapshot
//
// The server is forgiving on authoring errors: save endpoints return a
// structured `{ error, issues: [...] }` body so the editor can highlight
// which field broke, rather than a bare 400.

export interface WorkflowsApiDeps {
  store: WorkflowStore
  runs: RunStore
  layouts: LayoutStore
  /** Gate the request; write the 401/403 response and return falsy on failure. */
  requireScope: (req: IncomingMessage, res: ServerResponse, scopes: string[]) => unknown
  /** Called when a run mutates — daemon exposes its broadcaster so the SSE
   *  stream can be woken rather than polled. Optional; the stream falls back
   *  to polling if not provided. */
  runEvents?: {
    subscribe: (runId: string, handler: (run: WorkflowRun) => void) => () => void
  }
}

/** Router the daemon calls from its HTTP handler. Returns true if the
 *  request was handled (response written), false if the path isn't ours. */
export function handleWorkflowsApi(req: IncomingMessage, res: ServerResponse, deps: WorkflowsApiDeps): boolean {
  const url = req.url || ""
  if (!url.startsWith("/api/workflows")) return false

  const method = req.method || "GET"

  // /api/workflows          (GET list, POST create)
  if (url === "/api/workflows") {
    if (method === "GET") {
      if (!deps.requireScope(req, res, ["dashboard:read"])) return true
      return sendJson(res, 200, { workflows: deps.store.list() })
    }
    if (method === "POST") {
      if (!deps.requireScope(req, res, ["dashboard:write"])) return true
      return withBody(req, res, (body) => handleSave(res, deps, body, { mode: "create" }))
    }
  }

  // /api/workflows/runs[...]                (list / one / stream)
  if (url.startsWith("/api/workflows/runs") && method === "GET") {
    if (!deps.requireScope(req, res, ["dashboard:read"])) return true
    return handleRuns(req, res, deps, url)
  }

  // /api/workflows/:id[/layout|/validate]   (various)
  const defMatch = url.match(/^\/api\/workflows\/([^\/?]+)(\/layout|\/validate)?(\?.*)?$/)
  if (defMatch) {
    const id = decodeURIComponent(defMatch[1])
    const suffix = defMatch[2]

    if (suffix === "/layout") {
      if (method === "GET") {
        if (!deps.requireScope(req, res, ["dashboard:read"])) return true
        return sendJson(res, 200, { layout: deps.layouts.get(id) })
      }
      if (method === "PUT") {
        if (!deps.requireScope(req, res, ["dashboard:write"])) return true
        return withBody(req, res, (body) => {
          try {
            const saved = deps.layouts.save(id, body as WorkflowLayout)
            return sendJson(res, 200, { layout: saved })
          } catch (e: any) {
            return sendJson(res, 400, { error: "invalid layout", message: e.message })
          }
        })
      }
    }

    if (suffix === "/validate" && method === "POST") {
      if (!deps.requireScope(req, res, ["dashboard:read"])) return true
      return withBody(req, res, (body) => {
        const parsed = workflowSchema.safeParse(body)
        if (!parsed.success) {
          return sendJson(res, 200, {
            ok: false,
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          })
        }
        const lintIssues = lintWorkflow(parsed.data).map((m) => ({ path: "", message: m }))
        return sendJson(res, 200, { ok: lintIssues.length === 0, issues: lintIssues, workflow: parsed.data })
      })
    }

    if (!suffix) {
      if (method === "GET") {
        if (!deps.requireScope(req, res, ["dashboard:read"])) return true
        const wf = deps.store.get(id)
        if (!wf) return sendJson(res, 404, { error: "workflow not found" })
        return sendJson(res, 200, { workflow: wf })
      }
      if (method === "PUT") {
        if (!deps.requireScope(req, res, ["dashboard:write"])) return true
        return withBody(req, res, (body) => handleSave(res, deps, body, { mode: "update", id }))
      }
      if (method === "DELETE") {
        if (!deps.requireScope(req, res, ["dashboard:write"])) return true
        const existed = deps.store.delete(id)
        deps.layouts.delete(id)
        return sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: "workflow not found" })
      }
    }
  }

  return sendJson(res, 404, { error: "unknown workflows endpoint", path: url })
}

// -------------------- save (create/update) --------------------

function handleSave(
  res: ServerResponse,
  deps: WorkflowsApiDeps,
  body: unknown,
  opts: { mode: "create" } | { mode: "update"; id: string },
): true {
  const parsed = workflowSchema.safeParse(body)
  if (!parsed.success) {
    return sendJson(res, 400, {
      error: "invalid workflow",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  }
  const wf = parsed.data
  const lintIssues = lintWorkflow(wf)
  if (lintIssues.length > 0) {
    return sendJson(res, 400, {
      error: "lint errors",
      issues: lintIssues.map((m) => ({ path: "", message: m })),
    })
  }
  if (opts.mode === "update" && wf.id !== opts.id) {
    return sendJson(res, 400, { error: "workflow id does not match path" })
  }
  if (opts.mode === "create" && deps.store.get(wf.id)) {
    return sendJson(res, 409, { error: `workflow "${wf.id}" already exists` })
  }
  const saved = deps.store.save(wf)
  // Prune stale layout entries if any nodes were removed since the last save.
  deps.layouts.sync(saved.id, saved.nodes.map((n) => n.id))
  return sendJson(res, 200, { workflow: saved })
}

// -------------------- runs --------------------

function handleRuns(req: IncomingMessage, res: ServerResponse, deps: WorkflowsApiDeps, url: string): boolean {
  const q = new URL(url, "http://_").searchParams
  const trail = url.replace(/^\/api\/workflows\/runs/, "")
  if (trail === "" || trail.startsWith("?")) {
    const limit = Math.max(1, Math.min(500, Number(q.get("limit") || 50)))
    const workflowId = q.get("workflowId") || undefined
    return sendJson(res, 200, { runs: deps.runs.list({ workflowId, limit }) })
  }
  const runMatch = trail.match(/^\/([^\/?]+)(\/stream)?$/)
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1])
    if (runMatch[2]) return streamRun(req, res, deps, runId)
    const run = deps.runs.get(runId)
    if (!run) return sendJson(res, 404, { error: "run not found" })
    return sendJson(res, 200, { run })
  }
  return sendJson(res, 404, { error: "unknown runs endpoint" })
}

/** SSE run-detail stream. When `deps.runEvents` is provided, the stream is
 *  push-driven; otherwise it polls the run-store every 2s. Either way the
 *  client sees a complete snapshot per message. */
function streamRun(req: IncomingMessage, res: ServerResponse, deps: WorkflowsApiDeps, runId: string): boolean {
  const run = deps.runs.get(runId)
  if (!run) { sendJson(res, 404, { error: "run not found" }); return true }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })
  res.write(`data: ${JSON.stringify(run)}\n\n`)

  let closed = false
  const onEnd = () => { closed = true; unsubscribe?.(); clearInterval(timer); try { res.end() } catch { /* */ } }
  req.on("close", onEnd)

  const emit = (r: WorkflowRun) => { if (closed) return; try { res.write(`data: ${JSON.stringify(r)}\n\n`) } catch { onEnd() } }

  const unsubscribe = deps.runEvents?.subscribe(runId, emit)

  // Fallback poll — also acts as the source when `runEvents` is missing,
  // and as a safety net when an event is missed during a fs flush.
  let lastUpdated = run.updatedAt
  const timer = setInterval(() => {
    if (closed) return
    const latest = deps.runs.get(runId)
    if (latest && latest.updatedAt !== lastUpdated) {
      lastUpdated = latest.updatedAt
      emit(latest)
    }
  }, 2000)

  return true
}

// -------------------- helpers --------------------

function withBody(req: IncomingMessage, res: ServerResponse, handler: (body: unknown) => boolean | true): true {
  let raw = ""
  req.setEncoding("utf8")
  req.on("data", (chunk) => { raw += chunk })
  req.on("end", () => {
    let parsed: unknown
    try { parsed = raw ? JSON.parse(raw) : {} } catch (e: any) {
      sendJson(res, 400, { error: "invalid JSON body", message: e.message })
      return
    }
    handler(parsed)
  })
  req.on("error", (e: any) => sendJson(res, 400, { error: "body read failed", message: e.message }))
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
  return true
}
