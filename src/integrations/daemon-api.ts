import type { DaemonConfig } from "@/daemon/config"
import { readCatalog, runIntegrationRead, type ReadDeps } from "./read"

// --- The daemon's /integrations endpoints, for agents (#1696) ---
//
//   GET  /integrations/reads?agent=   the named reads the agent can run
//   POST /integrations/read           {agent, kind, label?, read, params?}
//
// Only reads: nothing here writes to an outside service, and no endpoint
// returns a token. Gated by isMeshGatedPath: loopback, or a mesh token.

export interface IntegrationsApiReply {
  status: number
  body: unknown
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export async function handleIntegrationsApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  query: URLSearchParams,
  config: DaemonConfig,
  deps: ReadDeps = {},
): Promise<IntegrationsApiReply> {
  const m = method.toUpperCase()
  const agentOk = (id: string): IntegrationsApiReply | null => {
    if (!id) return { status: 400, body: { error: "agent is required: your agent id" } }
    if (!config.agents?.[id]) return { status: 400, body: { error: `unknown agent "${id}": it must be an agent on this node` } }
    return null
  }

  if (path === "/integrations/reads" && m === "GET") {
    const agent = str(query.get("agent"))
    const bad = agentOk(agent)
    if (bad) return bad
    return { status: 200, body: { integrations: readCatalog(config, agent, deps.providers) } }
  }

  if (path === "/integrations/read" && m === "POST") {
    const agent = str(body?.agent)
    const bad = agentOk(agent)
    if (bad) return bad
    const kind = str(body?.kind)
    const read = str(body?.read)
    if (!kind || !read) return { status: 400, body: { error: "kind and read are required" } }
    const params = body?.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {}
    const r = await runIntegrationRead(config, { agentId: agent, kind, label: str(body?.label) || undefined, read, params }, deps)
    if (!r.ok) return { status: r.status >= 400 && r.status < 600 ? r.status : 502, body: { error: r.error } }
    return { status: 200, body: { status: r.status, body: r.body, truncated: r.truncated } }
  }

  if (path === "/integrations/read" || path === "/integrations/reads") return { status: 405, body: { error: "method not allowed" } }
  return { status: 404, body: { error: "not found" } }
}
