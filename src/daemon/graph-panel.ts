import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { loadDaemonConfig } from "./config"
import { GraphStore, type GraphNode, type Classification } from "@/graph"
import type { TopbarPeer } from "./topbar"
import { renderGraphPage } from "./ui/pages/graph"

// --- /admin/graph panel: Intent Knowledge Graph management ---
//
// Three surfaces:
//   1. Pending queue — LLM-proposed classifications awaiting human approval.
//      Approve / reject / edit-path inline.
//   2. Tree view — current nodes grouped by level, editable axes.
//   3. Schema — raw JSON editor for the level definitions (advanced).
//
// Matches admin-panel.ts in chrome + form-driven style. All persistence goes
// through GraphStore so the disk layout stays canonical.

export function handleGraphGet(
  _req: IncomingMessage,
  res: ServerResponse,
  peers: TopbarPeer[] = [],
  localToken?: string,
): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderGraphPage({ peers, localToken }))
}

export async function handleGraphApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    const body = req.method === "GET" ? undefined : await readJsonBody(req)
    const store = openStore()
    const dispatch: Record<string, () => unknown> = {
      "GET /api/admin/graph/state": () => getGraphState(store),
      "POST /api/admin/graph/classifications/approve": () => approveClassification(store, body),
      "POST /api/admin/graph/classifications/reject": () => rejectClassification(store, body),
      "POST /api/admin/graph/nodes": () => createNode(store, body),
      "PATCH /api/admin/graph/nodes": () => updateNode(store, body),
      "DELETE /api/admin/graph/nodes": () => deleteNode(store, body),
      "PUT /api/admin/graph/schema": () => saveSchema(store, body),
    }
    const key = `${req.method} ${path}`
    const handler = dispatch[key]
    if (!handler) {
      sendJson(res, 404, { error: `unknown graph endpoint: ${key}` })
      return
    }
    const result = await handler()
    sendJson(res, 200, result)
  } catch (e: any) {
    sendJson(res, 400, { error: e?.message || "graph op failed" })
  }
}

// ========================================================================
// Store open — reads graph.baseDir out of agentx.json each call (cheap).
// ========================================================================

function openStore(): GraphStore {
  const cfg = loadDaemonConfig()
  const baseDir = resolve(process.cwd(), cfg.graph.baseDir)
  return new GraphStore({ baseDir })
}

// ========================================================================
// Read side
// ========================================================================

function getGraphState(store: GraphStore) {
  const cfg = loadDaemonConfig()
  const schema = store.loadSchema()
  const nodes = store.loadNodes().nodes
  const recent = store.readRecentClassifications(100)
  const index = store.loadIndex().entries

  // A classification is "pending" if its fingerprint hasn't landed in the
  // snap-to-path index yet AND its latest log row isn't rejected. We scan the
  // recent log newest-first so later entries (approved/rejected) win over
  // earlier pending ones for the same msgHash.
  const seen = new Map<string, Classification>()
  for (const c of recent) {
    if (!seen.has(c.msgHash)) seen.set(c.msgHash, c)
  }
  const pending: Classification[] = []
  for (const c of seen.values()) {
    if (c.status === "pending" && !index[c.msgHash]) pending.push(c)
  }

  return {
    enabled: cfg.graph.enabled,
    schema,
    nodes,
    pending,
    recent: recent.slice(0, 25),
    counts: {
      nodes: nodes.length,
      pending: pending.length,
      fingerprints: Object.keys(index).length,
    },
  }
}

// ========================================================================
// Mutations
// ========================================================================

function approveClassification(store: GraphStore, body: any) {
  const msgHash = String(body?.msgHash || "").trim()
  if (!msgHash) throw new Error("msgHash is required")
  const c = findPending(store, msgHash)
  // Allow the UI to override the path / axes before approving.
  if (Array.isArray(body?.path) && body.path.length > 0) {
    c.path = body.path.map((s: any) => String(s))
  }
  if (body?.proposedAxes && typeof body.proposedAxes === "object") {
    c.proposedAxes = sanitizeAxes(body.proposedAxes)
  }
  store.approveClassification(c)
  return { summary: `Approved ${c.msgHash}` }
}

function rejectClassification(store: GraphStore, body: any) {
  const msgHash = String(body?.msgHash || "").trim()
  if (!msgHash) throw new Error("msgHash is required")
  const c = findPending(store, msgHash)
  store.rejectClassification(c)
  return { summary: `Rejected ${c.msgHash}` }
}

function findPending(store: GraphStore, msgHash: string): Classification {
  const recent = store.readRecentClassifications(500)
  const hit = recent.find((c) => c.msgHash === msgHash)
  if (!hit) throw new Error(`No classification found for ${msgHash}`)
  return hit
}

function createNode(store: GraphStore, body: any): { node: GraphNode } {
  const id = slug(String(body?.id || ""))
  const level = String(body?.level || "").trim()
  const parentId = body?.parentId ? slug(String(body.parentId)) : null
  const axes = sanitizeAxes({ [id]: body?.axes || {} })[id] || {}
  if (!id) throw new Error("id is required")
  if (!level) throw new Error("level is required")
  const node: GraphNode = {
    id,
    level,
    parentId,
    axes,
    createdAt: new Date().toISOString(),
    createdBy: "admin-ui",
  }
  store.addNode(node)
  return { node }
}

function updateNode(store: GraphStore, body: any): { node: GraphNode } {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id is required")
  const axes = sanitizeAxes({ [id]: body?.axes || {} })[id] || {}
  const node = store.updateNodeAxes(id, axes)
  return { node }
}

function deleteNode(store: GraphStore, body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id is required")
  store.deleteNode(id)
  return { summary: `Deleted ${id}` }
}

function saveSchema(store: GraphStore, body: any) {
  if (!body?.schema || typeof body.schema !== "object") {
    throw new Error("schema object is required")
  }
  store.saveSchema(body.schema) // GraphStore validates via zod; throws on invalid
  return { summary: "Schema saved" }
}

// ========================================================================
// Helpers
// ========================================================================

function sanitizeAxes(
  src: Record<string, any>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [nodeId, axes] of Object.entries(src || {})) {
    if (!axes || typeof axes !== "object") continue
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(axes as Record<string, unknown>)) {
      if (typeof v === "string") clean[k] = v
    }
    out[nodeId] = clean
  }
  return out
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, err) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      try {
        ok(raw ? JSON.parse(raw) : {})
      } catch (e) {
        err(e)
      }
    })
    req.on("error", err)
  })
}

