import { createCard, isValidCardId, readCard, resolveCard, type CardSettings } from "./cards"
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
//   POST /approvals/:id/resolve  the raising agent closes its own card
//                          because the owner already answered in chat and
//                          the agent acted on it (#909). Not a verdict.
// Deciding is refused here on purpose. The operator decides with the
// `agentx approvals` CLI or the dashboard's Approvals page.
//
// The daemon gates /approvals like agent memory: loopback, or a mesh token
// (mesh-auth.ts isMeshGatedPath).
//
// A card may also come from another node of the mesh (forward.ts, #668):
// its body names that node, `raised_by` is an agent there, and the card
// is kept here with `node` set so the result finds its way back.

export const LIST_LIMIT = 100

export const OPERATOR_ONLY =
  "Decisions are made by the operator only: `agentx approvals approve|reject <key>`, or the Approvals page in the dashboard."

export interface ApprovalsApiDeps {
  ctx: InboxContext
  settings: CardSettings
  /** True when the agent exists on this node. */
  hasAgent: (agentId: string) => boolean
  /** True when `node` names a mesh peer of this node, so a card raised by
   *  an agent there may be kept here (forward.ts). Unset: never. */
  hasPeer?: (node: string) => boolean
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
      // A card from another node names it; the name must be a peer of ours.
      // A local agent's card never carries one, whatever the body says.
      const from = typeof input.node === "string" ? input.node.trim() : ""
      const node = from && !deps.hasAgent(raisedBy) && deps.hasPeer?.(from) ? from : undefined
      if (raisedBy && !deps.hasAgent(raisedBy) && !node) {
        return {
          status: 400,
          body: { error: from
            ? `unknown node "${from}": node must be one of this node's mesh peers`
            : `unknown agent "${raisedBy}": raised_by must be an agent on this node` },
        }
      }
      const r = createCard(deps.ctx.root, input, { now: deps.ctx.now, settings: deps.settings, node })
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

  const resolve = path.match(/^\/approvals\/([^/]+)\/resolve$/)
  if (resolve && m === "POST") {
    const id = decodeURIComponent(resolve[1])
    const by = typeof body?.raised_by === "string" ? body.raised_by.trim() : ""
    const from = typeof body?.node === "string" ? body.node.trim() : ""
    // Same rule as raising: a local agent, or an agent on a mesh peer that
    // forwarded its card here.
    const node = from && !deps.hasAgent(by) && deps.hasPeer?.(from) ? from : undefined
    if (!by || (!deps.hasAgent(by) && !node)) {
      return { status: 400, body: { error: "raised_by must be the agent that raised the card" } }
    }
    if (typeof body?.reason !== "string" || !body.reason.trim()) {
      return { status: 400, body: { error: "reason is required: say where the owner answered and what you did" } }
    }
    const r = resolveCard(deps.ctx.root, id, { by, reason: body.reason, node, now: deps.ctx.now })
    if (!r.ok) return { status: r.error.startsWith("no card") ? 404 : 409, body: { error: r.error } }
    return { status: 200, body: { card: r.card } }
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
