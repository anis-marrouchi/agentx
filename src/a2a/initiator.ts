// --- Who started this work: a person or an agent ---
//
// One place answers "is the root of this chain a human?" so every caller
// (A2A delegation today, the activity graph and ledger next) agrees. Keep
// all human-vs-agent detection here; do not re-derive it from
// `senderAgentId` at call sites, because relays such as the phone app set
// fields that look agent-shaped for a turn a person started.
//
// The rules, in order:
//   1. A propagated root (`context.initiator`) wins. It is stamped on the
//      first hop of a delegation and travels with the context, including
//      across mesh peers (sendTask forwards the context verbatim).
//   2. Machine channels (cron, workflow, a2a, mcp, mesh, api, ...) are agent.
//   3. A machine-shaped sender ("agent:x", "cron:y", ...) is agent. This is
//      how router bot-to-bot chains and callback turns are marked, and how
//      the GitHub/GitLab adapters mark an agent's comment posted with a
//      person's account (forgeSender in channels/outbound-marker.ts).
//   4. Channels a person types or speaks on are human.
//   5. Anything else is agent: unknown traffic keeps today's behaviour.

export type InitiatorKind = "human" | "agent"

/** The root of a chain, carried in `context.initiator` on every hop after
 *  the first. Only small identifying fields: it crosses the mesh. */
export interface RootInitiator {
  kind: InitiatorKind
  /** Channel the root turn arrived on (telegram, app, cron, ...). */
  channel: string
  chatId?: string
  sender?: string
  /** The agent that was talking to the person when the chain started. */
  agentId?: string
  /** The known person behind the root turn (people, #384). */
  person?: string
}

/** The subset of AgentTask.context this module reads. */
export interface InitiatorContext {
  channel?: string
  chatId?: string
  sender?: string
  initiator?: unknown
  delegation?: unknown
  person?: unknown
  [k: string]: unknown
}

/** Channels a person writes or speaks on. */
export const HUMAN_CHANNELS: ReadonlySet<string> = new Set([
  "telegram", "whatsapp", "slack", "discord",
  "gitlab", "github",
  "app", "voice", "dashboard", "webrtc",
])

/** Channels only software writes on. `api` is here on purpose: a bare API
 *  call has no conversation to come back to. */
export const AGENT_CHANNELS: ReadonlySet<string> = new Set([
  "a2a", "mcp", "mesh", "api",
  "cron", "workflow", "events", "reminder", "heartbeat",
  "system", "internal", "business",
  // A guest mesh's turn (#380): another organisation asks, this node's
  // agent acts. Not a person of this node.
  "guest",
])

const AGENT_SENDER_PREFIXES = ["agent:", "cron:", "workflow:", "mesh:", "system:", "internal:"]

function validRoot(v: unknown): RootInitiator | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (o.kind !== "human" && o.kind !== "agent") return null
  if (typeof o.channel !== "string" || !o.channel) return null
  const root: RootInitiator = { kind: o.kind, channel: o.channel.slice(0, 40) }
  if (typeof o.chatId === "string") root.chatId = o.chatId.slice(0, 200)
  if (typeof o.sender === "string") root.sender = o.sender.slice(0, 120)
  if (typeof o.agentId === "string") root.agentId = o.agentId.slice(0, 80)
  if (typeof o.person === "string" && o.person) root.person = o.person.slice(0, 40)
  return root
}

/** The root a delegated hop carries in `context.initiator`, or null on a
 *  turn that is itself a root (read-only views such as the activity map). */
export function propagatedRootOf(ctx: InitiatorContext | undefined | null): RootInitiator | null {
  return validRoot(ctx?.initiator)
}

/** True for senders that name software rather than a person. */
export function isAgentSender(sender: unknown): boolean {
  if (typeof sender !== "string") return false
  const s = sender.trim().toLowerCase()
  return s === "agent" || AGENT_SENDER_PREFIXES.some((p) => s.startsWith(p))
}

/** Human or agent, for the chain this turn belongs to. */
export function classifyInitiator(ctx: InitiatorContext | undefined | null): InitiatorKind {
  const root = validRoot(ctx?.initiator)
  if (root) return root.kind
  const channel = (ctx?.channel || "api").toLowerCase()
  if (AGENT_CHANNELS.has(channel)) return "agent"
  if (isAgentSender(ctx?.sender)) return "agent"
  if (HUMAN_CHANNELS.has(channel)) return "human"
  return "agent"
}

/** The root to stamp on the next hop. An existing root is passed on
 *  unchanged; otherwise this turn is the root. */
export function rootInitiatorOf(ctx: InitiatorContext | undefined | null, agentId?: string): RootInitiator {
  const existing = validRoot(ctx?.initiator)
  if (existing) return existing
  const root: RootInitiator = { kind: classifyInitiator(ctx), channel: ctx?.channel || "api" }
  if (ctx?.chatId) root.chatId = String(ctx.chatId)
  if (ctx?.sender) root.sender = String(ctx.sender)
  if (agentId) root.agentId = agentId
  if (typeof ctx?.person === "string" && ctx.person) root.person = ctx.person
  return root
}

/** True for a delegated hop (it carries a valid root) or a callback turn
 *  (it carries `delegation`). Neither may hand work off asynchronously:
 *  a hop has a caller waiting on its answer, and a callback must not fan
 *  out into another callback. */
export function isInsideDelegation(ctx: InitiatorContext | undefined | null): boolean {
  if (!ctx) return false
  return validRoot(ctx.initiator) !== null || !!ctx.delegation
}

/** Is this turn the one talking to the person? Only that turn may hand
 *  work off and end: a delegated turn (it carries a root) has a caller
 *  waiting on its answer, and a callback turn (it carries `delegation`)
 *  must not fan out again. */
export function isHumanFacingTurn(ctx: InitiatorContext | undefined | null): boolean {
  if (!ctx || isInsideDelegation(ctx)) return false
  return classifyInitiator(ctx) === "human"
}
