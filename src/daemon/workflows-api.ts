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
import {
  getWorkflowDraft,
  listWorkflowDrafts,
  promoteWorkflowDraft,
  rejectWorkflowDraft,
  validateWorkflowDraft,
  writeWorkflowDraft,
} from "@/workflows/absorb"
import type { WorkflowDispatcher } from "@/workflows/dispatcher"
import type { TaskStore } from "@/workflows/task-store"
import type { ActorStore } from "@/actors/store"
import { formSubmissionSchema } from "@/forms/types"

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
//   GET  /api/workflows/drafts                 — reviewable generated workflow drafts
//   GET  /api/workflows/drafts/:id             — one draft
//   POST /api/workflows/drafts/:id/validate    — validate one draft
//   POST /api/workflows/drafts/:id/promote     — promote one draft into active workflow store
//   POST /api/workflows/drafts/:id/reject      — archive one draft
//
// The server is forgiving on authoring errors: save endpoints return a
// structured `{ error, issues: [...] }` body so the editor can highlight
// which field broke, rather than a bare 400.

export interface WorkflowsApiDeps {
  store: WorkflowStore
  runs: RunStore
  layouts: LayoutStore
  /** Optional task store + dispatcher for the BPM /tasks + /inbox endpoints.
   *  Passing the live dispatcher lets the API drive run resumes from form
   *  submissions. */
  tasks?: TaskStore
  actors?: ActorStore
  dispatcher?: WorkflowDispatcher
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

  // /api/workflows/drafts[...]              (generated workflow review)
  // Must run before the generic /api/workflows/:id matcher below, otherwise
  // "drafts" would be treated as a workflow id.
  if (url === "/api/workflows/drafts" || url.startsWith("/api/workflows/drafts?") || url.startsWith("/api/workflows/drafts/")) {
    return handleDrafts(req, res, deps, url)
  }

  // /api/workflows/runs[...]                (list / one / stream / status-mutation)
  // Reads (GET) and the new POST /:id/status both flow into handleRuns; the
  // sub-route enforces its own method and scope checks.
  if (url.startsWith("/api/workflows/runs")) {
    if (method === "GET" && !deps.requireScope(req, res, ["dashboard:read"])) return true
    return handleRuns(req, res, deps, url)
  }

  // /api/workflows/tasks[...]               (BPM inbox + submission)
  // Must run BEFORE the /:id regex below — otherwise "tasks" gets matched
  // as a workflow id and the GET handler returns 404 "workflow not found".
  if (url.startsWith("/api/workflows/tasks")) {
    if (!deps.tasks || !deps.dispatcher) return sendJson(res, 501, { error: "task engine not enabled" })
    const trail = url.replace(/^\/api\/workflows\/tasks/, "")
    if (trail === "/history" || trail.startsWith("/history?")) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
      if (!deps.requireScope(req, res, ["dashboard:read"])) return true
      const q = new URL(url, "http://_").searchParams
      const limitRaw = parseInt(q.get("limit") || "50", 10)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50
      const archived = deps.tasks.listArchived()
      // Newest first; cap at limit. Compute duration + SLA breach inline so
      // the client doesn't need a third round-trip.
      const rows = archived
        .filter((t) => !!t.submittedAt)
        .sort((a, b) => (a.submittedAt! < b.submittedAt! ? 1 : -1))
        .slice(0, limit)
        .map((t) => {
          const created = Date.parse(t.createdAt)
          const submitted = Date.parse(t.submittedAt!)
          const due = t.dueAt ? Date.parse(t.dueAt) : null
          const breachedSla = due !== null && submitted > due
          return {
            id: t.id,
            runId: t.runId,
            workflowId: t.workflowId,
            title: t.title,
            assignee: t.assignee,
            submittedBy: t.submittedBy,
            submittedAt: t.submittedAt,
            submittedAction: t.submittedAction,
            createdAt: t.createdAt,
            dueAt: t.dueAt ?? null,
            durationMs: Number.isFinite(submitted - created) ? submitted - created : null,
            breachedSla,
            status: t.status,
          }
        })
      return sendJson(res, 200, { rows })
    }
    if (trail === "" || trail.startsWith("?")) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
      if (!deps.requireScope(req, res, ["dashboard:read"])) return true
      const q = new URL(url, "http://_").searchParams
      const actor = q.get("actor") || undefined
      const tasks = actor ? deps.tasks.listForActor(actor) : deps.tasks.listOpen()
      return sendJson(res, 200, { tasks })
    }
    const taskMatch = trail.match(/^\/([^\/?]+)(\/submit)?$/)
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1])
      if (taskMatch[2]) {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
        if (!deps.requireScope(req, res, ["dashboard:write"])) return true
        return withBody(req, res, async (body) => {
          const parsed = formSubmissionSchema.safeParse(body && typeof body === "object" && "submission" in (body as object)
            ? (body as { submission: unknown }).submission
            : body)
          if (!parsed.success) {
            return sendJson(res, 400, {
              error: "invalid submission",
              issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            })
          }
          const submittedBy = typeof (body as any)?.submittedBy === "string" ? (body as any).submittedBy : "anonymous"
          const result = await deps.dispatcher!.submitTask(taskId, parsed.data, submittedBy)
          if (!result.ok) return sendJson(res, 400, { error: result.error, fieldErrors: result.fieldErrors })
          return sendJson(res, 200, { ok: true, runId: result.runId })
        })
      }
      if (method === "GET") {
        if (!deps.requireScope(req, res, ["dashboard:read"])) return true
        const task = deps.tasks.get(taskId)
        if (!task) return sendJson(res, 404, { error: "task not found" })
        return sendJson(res, 200, { task })
      }
    }
  }

  // /api/workflows/signal/:name        — POST manual signal emission.
  // Must also run before the /:id regex (signal name shouldn't be treated
  // as a workflow id).
  if (url.startsWith("/api/workflows/signal/")) {
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:write"])) return true
    if (!deps.dispatcher) return sendJson(res, 501, { error: "dispatcher not enabled" })
    const name = decodeURIComponent(url.replace(/^\/api\/workflows\/signal\//, "").split("?")[0])
    if (!name) return sendJson(res, 400, { error: "signal name required" })
    return withBody(req, res, (body) => {
      const b = body as { scope?: "workflow" | "global"; workflowId?: string; payload?: Record<string, unknown> } | undefined
      const emission = deps.dispatcher!.emitSignal({
        name,
        scope: b?.scope,
        workflowId: b?.workflowId,
        payload: b?.payload,
      })
      return sendJson(res, 200, { ok: true, emission })
    })
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

function handleDrafts(req: IncomingMessage, res: ServerResponse, deps: WorkflowsApiDeps, url: string): boolean {
  const method = req.method || "GET"
  const trail = url.replace(/^\/api\/workflows\/drafts/, "")
  const workflowDir = deps.store.baseDir

  if (trail === "" || trail.startsWith("?")) {
    if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:read"])) return true
    const drafts = listWorkflowDrafts(process.cwd(), { workflowDir }).map((d) => ({
      id: d.id,
      path: d.path,
      workflow: d.workflow,
      issues: validateWorkflowDraft(d.workflow),
    }))
    return sendJson(res, 200, { drafts })
  }

  const match = trail.match(/^\/([^\/?]+)(\/validate|\/promote|\/reject)?$/)
  if (!match) return sendJson(res, 404, { error: "unknown drafts endpoint" })
  const id = decodeURIComponent(match[1])
  const action = match[2]

  if (!action && method === "GET") {
    if (!deps.requireScope(req, res, ["dashboard:read"])) return true
    const draft = getWorkflowDraft(id, process.cwd(), { workflowDir })
    if (!draft) return sendJson(res, 404, { error: "draft not found" })
    return sendJson(res, 200, { draft, issues: validateWorkflowDraft(draft.workflow) })
  }

  // PUT /api/workflows/drafts/:id — overwrite the draft with an edited
  // version. Body shape: { workflow: Workflow }. The id in the body must
  // match the URL id (drafts are keyed by filename). Validation is run
  // before writing; on validation failure we 400 with issues so the editor
  // can highlight them. The draft is always written as YAML to keep
  // human review tractable.
  if (!action && method === "PUT") {
    if (!deps.requireScope(req, res, ["dashboard:write"])) return true
    return withBody(req, res, (body) => {
      try {
        const incoming = (body as any)?.workflow ?? body
        if (!incoming || typeof incoming !== "object") return sendJson(res, 400, { error: "missing workflow body" })
        if (incoming.id && incoming.id !== id) {
          return sendJson(res, 400, { error: `draft id mismatch: body=${incoming.id}, url=${id}` })
        }
        const parsed = workflowSchema.safeParse({ ...incoming, id })
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: "draft schema invalid",
            issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
          })
        }
        const lintIssues = lintWorkflow(parsed.data)
        const path = writeWorkflowDraft(parsed.data, { format: "yaml", workflowDir, force: true })
        return sendJson(res, 200, { ok: true, id, path, issues: lintIssues, workflow: parsed.data })
      } catch (e: any) {
        return sendJson(res, 500, { error: e?.message || String(e) })
      }
    })
  }

  if (action === "/validate") {
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:read"])) return true
    const draft = getWorkflowDraft(id, process.cwd(), { workflowDir })
    if (!draft) return sendJson(res, 404, { error: "draft not found" })
    const issues = validateWorkflowDraft(draft.workflow)
    return sendJson(res, 200, { ok: issues.length === 0, issues, draft })
  }

  if (action === "/promote") {
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:write"])) return true
    return withBody(req, res, (body) => {
      try {
        const replace = !!(body as any)?.replace
        const format = (body as any)?.format === "json" ? "json" : "yaml"
        const result = promoteWorkflowDraft(id, { replace, format, workflowDir })
        deps.layouts.sync(result.workflow.id, result.workflow.nodes.map((n) => n.id))
        return sendJson(res, 200, { ok: true, ...result })
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message || String(e) })
      }
    })
  }

  if (action === "/reject") {
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:write"])) return true
    try {
      const archived = rejectWorkflowDraft(id, process.cwd(), { workflowDir })
      return sendJson(res, 200, { ok: true, id, archived })
    } catch (e: any) {
      return sendJson(res, 400, { error: e?.message || String(e) })
    }
  }

  return sendJson(res, 405, { error: "method not allowed" })
}

// -------------------- save (create/update) --------------------

// Top-level workflow keys the editor doesn't yet have UI controls for. When
// the editor saves a workflow without these keys present in the raw payload
// (typical when an older cached IIFE bundle is in the user's browser), we
// preserve the on-disk value instead of letting Zod's default silently flip
// the field back. Without this guard, server-only behaviours like
// `mesh.allowRemote: true` get reset on every Save until the user
// hard-refreshes — see 2026-04-23 incident where a cached editor repeatedly
// stripped mesh and broke the cross-mesh broadcast.
//
// Add new keys here when you ship a server-side workflow feature ahead of
// matching editor UI; remove a key once the editor sends it.
const EDITOR_BLIND_KEYS = ["mesh"] as const

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

  // Preserve editor-blind keys from disk. We check the RAW payload (not the
  // parsed one — Zod has already filled defaults) to distinguish "editor
  // omitted this field" from "editor explicitly set the default value".
  if (opts.mode === "update" && body && typeof body === "object") {
    const raw = body as Record<string, unknown>
    const existing = deps.store.get(opts.id)
    if (existing) {
      for (const key of EDITOR_BLIND_KEYS) {
        if (!(key in raw) && key in existing) {
          ;(wf as Record<string, unknown>)[key] = (existing as Record<string, unknown>)[key]
        }
      }
    }
  }

  // store.save() throws on protected disk states — most importantly
  // "yaml-authored workflow exists" (refuses to write JSON next to a
  // YAML twin and silently shadow the operator's source). Catch here
  // and surface as a 400; if the throw escapes, the request handler
  // (called from a stream `end` callback in board-dashboard.ts) takes
  // the dashboard process down with it.
  let saved
  try {
    saved = deps.store.save(wf)
  } catch (e: any) {
    const message: string = e?.message || String(e)
    const yamlSibling = /yaml-authored workflow .* exists at /.test(message)
    return sendJson(res, yamlSibling ? 409 : 500, {
      error: yamlSibling
        ? "this workflow is YAML-authored on disk — the editor refuses to overwrite it as JSON. Edit the YAML directly OR delete it and re-author from the editor."
        : message,
      kind: yamlSibling ? "yaml-authored" : "save-failed",
    })
  }
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
    const summary = q.get("summary") === "1" || q.get("summary") === "true"
    const runs = deps.runs.list({ workflowId, limit })
    if (!summary) return sendJson(res, 200, { runs })
    // Drop the heavyweight `context` (per-node outputs + the full trigger
    // event payload — webhook bodies routinely run 10–50KB each). The list
    // UI on /workflows only uses metadata + the last history entry, so the
    // payload would otherwise gate first paint on the slowest serialization
    // path. Run-detail (GET /runs/:id) returns the full shape unchanged.
    const slim = runs.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      workflowVersion: r.workflowVersion,
      homeNode: r.homeNode,
      status: r.status,
      pending: r.pending,
      entityRef: r.entityRef,
      // Trim history to last 5 entries — that's enough for the timeline
      // preview without dragging full agent outputs into the listing.
      history: (r.history || []).slice(-5),
      parentRunId: r.parentRunId,
      parentNodeId: r.parentNodeId,
      rootRunId: r.rootRunId,
      depth: r.depth,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    return sendJson(res, 200, { runs: slim })
  }
  // POST /api/workflows/runs/<id>/status  body: { status: "paused"|"running"|"canceled" }
  // Mirrors `agentx workflow pause/resume/cancel <runId>`.
  const statusMatch = trail.match(/^\/([^\/?]+)\/status$/)
  if (statusMatch) {
    if ((req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { error: "method not allowed" })
    if (!deps.requireScope(req, res, ["dashboard:write"])) return true
    const runId = decodeURIComponent(statusMatch[1])
    return withBody(req, res, (body) => {
      const status = (body as any)?.status
      if (status !== "paused" && status !== "running" && status !== "canceled") {
        return sendJson(res, 400, { error: "status must be paused|running|canceled" })
      }
      const updated = deps.runs.setStatus(runId, status)
      if (!updated) return sendJson(res, 404, { error: "run not found" })
      return sendJson(res, 200, { ok: true, runId, status })
    })
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

function withBody(req: IncomingMessage, res: ServerResponse, handler: (body: unknown) => boolean | true | Promise<boolean | true>): true {
  let raw = ""
  req.setEncoding("utf8")
  req.on("data", (chunk) => { raw += chunk })
  req.on("end", () => {
    let parsed: unknown
    try { parsed = raw ? JSON.parse(raw) : {} } catch (e: any) {
      sendJson(res, 400, { error: "invalid JSON body", message: e.message })
      return
    }
    // Defensive double-wrap: handler() may throw synchronously (e.g.
    // workflowStore.save() refusing to overwrite a YAML-authored
    // workflow). The throw would escape the Promise.resolve below
    // because Promise.resolve only wraps the RETURN value — a sync
    // throw beats it. Without this try, the throw bubbles to the
    // IncomingMessage event listener and from there to the global
    // uncaughtException, killing the dashboard. We caught one such
    // crash 2026-05-09 on clawd; never again.
    let result: ReturnType<typeof handler>
    try {
      result = handler(parsed)
    } catch (e: any) {
      try { sendJson(res, 500, { error: "handler threw (sync)", message: e?.message ?? String(e) }) }
      catch { /* response already sent */ }
      return
    }
    void Promise.resolve(result).catch((e: any) => {
      try { sendJson(res, 500, { error: "handler threw", message: e?.message ?? String(e) }) }
      catch { /* response already sent */ }
    })
  })
  req.on("error", (e: any) => sendJson(res, 400, { error: "body read failed", message: e.message }))
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
  return true
}
