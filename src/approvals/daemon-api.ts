import { createCard, isValidCardId, readCard, type CardSettings } from "./cards"
import { listInbox, type InboxContext } from "./inbox"

// --- The daemon's /approvals endpoints ---
//
// This surface is reachable by agents (they curl the daemon on loopback, and
// the agentx_approval MCP tool posts here), so it only lets them:
//   POST /approvals        raise a decision card
//   GET  /approvals        read the inbox, in bounded summary form
//   GET  /approvals/:id    read one of the cards (to check its result)
//   POST /approvals/checkin start a check-in now ({"daily": true} for the
//                          full pass). It only asks agents to write cards.
// Deciding is refused here on purpose. The operator decides with the
// `agentx approvals` CLI or the dashboard's Approvals page.
//
// The daemon gates /approvals like agent memory: loopback, or a mesh token
// (mesh-auth.ts isMeshGatedPath).

export const LIST_LIMIT = 100

export const OPERATOR_ONLY =
  "Decisions are made by the operator only: `agentx approvals approve|reject <key>`, or the Approvals page in the dashboard."

export interface ApprovalsApiDeps {
  ctx: InboxContext
  settings: CardSettings
  /** True when the agent exists on this node. */
  hasAgent: (agentId: string) => boolean
  /** Start a check-in pass in the background (checkin.ts). */
  runCheckin?: (kind: "daily" | "check") => void
}

export interface ApiReply {
  status: number
  body: unknown
}

export function handleApprovalsApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  query: URLSearchParams,
  deps: ApprovalsApiDeps,
): ApiReply {
  const m = method.toUpperCase()
  if (path === "/approvals") {
    if (m === "GET") {
      const listing = listInbox(deps.ctx, { includeSnoozed: query.get("all") === "1" })
      return {
        status: 200,
        body: {
          count: listing.items.length,
          snoozed: listing.snoozed,
          items: listing.items.slice(0, LIST_LIMIT),
          truncated: listing.items.length > LIST_LIMIT,
          errors: listing.errors,
        },
      }
    }
    if (m === "POST") {
      const input = body ?? {}
      const raisedBy = typeof input.raised_by === "string" ? input.raised_by.trim() : ""
      if (raisedBy && !deps.hasAgent(raisedBy)) {
        return { status: 400, body: { error: `unknown agent "${raisedBy}": raised_by must be an agent on this node` } }
      }
      const r = createCard(deps.ctx.root, input, { now: deps.ctx.now, settings: deps.settings })
      if (!r.ok) return { status: 400, body: { error: r.error } }
      return { status: 201, body: { card: r.card } }
    }
    return { status: 405, body: { error: "Method not allowed" } }
  }

  if (path === "/approvals/checkin" && m === "POST") {
    if (!deps.runCheckin) return { status: 503, body: { error: "check-ins need macOS" } }
    const kind = body?.daily === true ? "daily" : "check"
    deps.runCheckin(kind)
    return { status: 202, body: { started: kind } }
  }

  const one = path.match(/^\/approvals\/([^/]+)$/)
  if (one && m === "GET") {
    const id = decodeURIComponent(one[1])
    const card = isValidCardId(id) ? readCard(deps.ctx.root, id) : null
    if (!card) return { status: 404, body: { error: `no card "${id}"` } }
    return { status: 200, body: { card } }
  }
  // POST /approvals/:id {yes|no|later} and anything else that would decide.
  if (m !== "GET" && m !== "HEAD") return { status: 403, body: { error: OPERATOR_ONLY } }
  return { status: 404, body: { error: "Not found" } }
}
