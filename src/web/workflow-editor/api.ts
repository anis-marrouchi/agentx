import type { Workflow, WorkflowLayout, ValidationIssue } from "./types"

// --- API helpers ---
//
// Thin wrappers over /api/workflows with bearer-token handling (reads
// `ax_token` from localStorage — same convention as the rest of the
// dashboard) and the X-Requested-With guard enforced by board-dashboard.

function token(): string {
  try { return localStorage.getItem("ax_token") || "" } catch { return "" }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "agentx-board",
  }
  const t = token()
  if (t) h["Authorization"] = "Bearer " + t
  return h
}

export async function fetchWorkflow(id: string): Promise<Workflow> {
  const r = await fetch("/api/workflows/" + encodeURIComponent(id), { headers: headers() })
  if (!r.ok) throw new Error("fetch workflow " + id + ": " + r.status)
  const body = (await r.json()) as { workflow: Workflow }
  return body.workflow
}

export async function fetchLayout(id: string): Promise<WorkflowLayout | null> {
  const r = await fetch("/api/workflows/" + encodeURIComponent(id) + "/layout", { headers: headers() })
  if (!r.ok) return null
  const body = (await r.json()) as { layout: WorkflowLayout | null }
  return body.layout
}

export async function fetchWorkflowList(): Promise<Array<{ id: string; title: string }>> {
  const r = await fetch("/api/workflows", { headers: headers() })
  if (!r.ok) return []
  const body = (await r.json()) as { workflows: Workflow[] }
  return body.workflows.map((w) => ({ id: w.id, title: w.title }))
}

export interface ValidateResult {
  ok: boolean
  issues: ValidationIssue[]
  workflow?: Workflow
}

export async function validate(wf: Workflow): Promise<ValidateResult> {
  const r = await fetch("/api/workflows/" + encodeURIComponent(wf.id) + "/validate", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(wf),
  })
  if (!r.ok) return { ok: false, issues: [{ path: "", message: "HTTP " + r.status }] }
  return (await r.json()) as ValidateResult
}

export async function saveWorkflow(wf: Workflow, opts: { create: boolean }): Promise<{ ok: boolean; issues?: ValidationIssue[] }> {
  const url = opts.create ? "/api/workflows" : "/api/workflows/" + encodeURIComponent(wf.id)
  const method = opts.create ? "POST" : "PUT"
  const r = await fetch(url, { method, headers: headers(), body: JSON.stringify(wf) })
  if (r.ok) return { ok: true }
  const err = await r.json().catch(() => ({}))
  return {
    ok: false,
    issues: (err.issues as ValidationIssue[]) || [{ path: "", message: err.error || "HTTP " + r.status }],
  }
}

export async function saveLayout(id: string, layout: WorkflowLayout): Promise<void> {
  await fetch("/api/workflows/" + encodeURIComponent(id) + "/layout", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(layout),
  })
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const r = await fetch("/api/workflows/" + encodeURIComponent(id), {
    method: "DELETE",
    headers: headers(),
  })
  return r.ok
}

export interface AgentSummary {
  id: string
  name: string
}

/** Fetch the list of agents the daemon knows. Proxied by board-dashboard's
 *  /api/agents route, which forwards to the daemon's /agents endpoint.
 *  Returns [] on any failure (editor falls back to MOCK_AGENTS). */
export async function fetchAgents(): Promise<AgentSummary[]> {
  try {
    const r = await fetch("/api/agents", { headers: headers() })
    if (!r.ok) return []
    const body = await r.json() as unknown
    // Shape isn't formally typed on the server side — normalise defensively.
    if (Array.isArray(body)) {
      return body
        .map((a) => typeof a === "string"
          ? { id: a, name: a }
          : a && typeof a === "object" && "id" in a
            ? { id: String((a as { id: unknown }).id), name: String((a as { name?: unknown }).name ?? (a as { id: unknown }).id) }
            : null)
        .filter((x): x is AgentSummary => x !== null)
    }
    if (body && typeof body === "object" && "agents" in body) {
      const arr = (body as { agents: unknown[] }).agents
      if (Array.isArray(arr)) return arr.map((a) => ({ id: String(a.id ?? a), name: String(a.name ?? a.id ?? a) }))
    }
    return []
  } catch {
    return []
  }
}
