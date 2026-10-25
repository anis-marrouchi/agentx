import { readCalendar, upcoming } from "./calendar"
import { createContentDraft, isValidContentDraftId, readContentDraft } from "./drafts"
import { listSamples, pickSamples } from "./voice"

// --- The daemon's /content endpoints, for agents ---
//
//   POST /content/drafts      raise a draft {agent, platform, text, samples, topic?, date?}
//   GET  /content/drafts/:id  read one of the agent's drafts (its status)
//   GET  /content/voice?agent=&topic=   the samples closest to a topic
//   GET  /content/calendar?agent=       next week's planned posts
//
// Publishing is refused here on purpose: only the owner's yes in the
// Approvals inbox publishes (approvals/inbox.ts). Gated like /approvals by
// isMeshGatedPath: loopback, or a mesh token.

export interface ContentApiDeps {
  root: string
  /** The workspace of an agent on this node; null when there is no such agent. */
  workspaceOf: (agentId: string) => string | null
  now?: number
}

export interface ContentApiReply {
  status: number
  body: unknown
}

export const PUBLISH_REFUSED =
  "Only the owner publishes: `agentx approvals approve content:<id>`, or the Approvals page in the dashboard."

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export function handleContentApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  query: URLSearchParams,
  deps: ContentApiDeps,
): ContentApiReply {
  const m = method.toUpperCase()
  const agentFrom = (v: unknown): { agent: string; workspace: string } | ContentApiReply => {
    const agent = str(v)
    if (!agent) return { status: 400, body: { error: "agent is required: your agent id" } }
    const workspace = deps.workspaceOf(agent)
    if (!workspace) return { status: 400, body: { error: `unknown agent "${agent}": it must be an agent on this node` } }
    return { agent, workspace }
  }

  if (path === "/content/drafts" && m === "POST") {
    const who = agentFrom(body?.agent)
    if ("status" in who) return who
    const r = createContentDraft(deps.root, { ...who, platform: body?.platform, text: body?.text, samples: body?.samples, topic: body?.topic, date: body?.date }, deps.now)
    if (!r.ok) return { status: 400, body: { error: r.error } }
    return { status: 201, body: { draft: r.draft } }
  }

  const one = path.match(/^\/content\/drafts\/([^/]+)$/)
  if (one && m === "GET") {
    const id = decodeURIComponent(one[1])
    const draft = isValidContentDraftId(id) ? readContentDraft(deps.root, id) : null
    if (!draft) return { status: 404, body: { error: `no content draft "${id}"` } }
    const agent = str(query.get("agent"))
    if (agent && draft.agent !== agent) return { status: 403, body: { error: `draft "${id}" was raised by another agent` } }
    return { status: 200, body: { draft } }
  }

  if (path === "/content/voice" && m === "GET") {
    const who = agentFrom(query.get("agent"))
    if ("status" in who) return who
    const n = Math.min(10, Math.max(1, Number(query.get("n")) || 3))
    return {
      status: 200,
      body: { total: listSamples(who.workspace).length, samples: pickSamples(who.workspace, query.get("topic") ?? "", n) },
    }
  }

  if (path === "/content/calendar" && m === "GET") {
    const who = agentFrom(query.get("agent"))
    if ("status" in who) return who
    const entries = readCalendar(who.workspace)
    if (!entries) return { status: 200, body: { exists: false, entries: [] } }
    return { status: 200, body: { exists: true, entries: upcoming(entries, new Date(deps.now ?? Date.now()), 14) } }
  }

  if (m !== "GET" && m !== "HEAD") return { status: 403, body: { error: PUBLISH_REFUSED } }
  return { status: 404, body: { error: "Not found" } }
}
