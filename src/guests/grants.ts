import { TokenStore, type TokenRecord } from "@/daemon/token-store"
import { PairCodeStore } from "@/daemon/pair-codes"
import { PAIR_CODE_FAILED, type PairAttemptLimiter } from "@/daemon/app-pair-code"
import { createCard, readCard } from "@/approvals/cards"
import { autonomyLevelSchema, type AutonomyLevel } from "@/guard/autonomy"
import { GuestStore, type GuestGrant } from "./store"

// --- Opening part of a mesh to a guest, and keeping it in hand (#380) ---
//
// Two roles. The host opens a grant: one of its agents, named folders,
// skills and commands, a freedom level and an end date. The guest is the
// other organisation's mesh. Access goes one way per grant.
//
// The guest asks, the host's agent acts. The guest never gets a shell or
// a session on the host's machine: its messages run as turns of the host
// agent, under the host's rules and in the host's log, with the routine
// autonomy levels of #80 enforced on the run (report: read-only;
// propose: no merge, deploy or delete; act: inside the grant, no question
// asked). What the grant names is put in front of the agent on every turn.
//
// Joining is a one-time code, like phone pairing; the join arrives as a
// decision card in the host's Approvals inbox. No yes, no join. The host
// can pause, widen, narrow or end the grant while it is in use.

export const GUEST_SCOPE_PREFIX = "guest:"
/** Who the join card is raised by: not an agent, so no agent is told the
 *  verdict; the guest routes read it instead. */
export const JOIN_CARD_BY = "guests"
export const DEFAULT_GRANT_DAYS = 7
export const MAX_GRANT_DAYS = 365
const MIN_MS = 400

export interface GrantInput {
  name: string
  guest: string
  agentId: string
  folders?: string[]
  skills?: string[]
  commands?: string[]
  level?: string
  days?: number
}

export interface GuestDeps {
  tokens: TokenStore
  codes: PairCodeStore
  guests: GuestStore
  hasAgent: (agentId: string) => boolean
  /** The install folder: where decision cards live. */
  root: string
  limiter: PairAttemptLimiter
  now?: () => number
  minMs?: number
  log?: (line: string) => void
}

export function grantIdOf(rec: TokenRecord): string | null {
  const scope = rec.scopes.find((s) => s.startsWith(GUEST_SCOPE_PREFIX))
  return scope ? scope.slice(GUEST_SCOPE_PREFIX.length) : null
}

export function newGrantId(now: number): string {
  return `g-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 50)

export type InviteResult =
  | { ok: true; code: string; codeExpiresAt: string; grant: GuestGrant }
  | { ok: false; error: string }

/** Open a grant and mint the one-time code the guest joins with. */
export function inviteGuest(deps: Pick<GuestDeps, "tokens" | "codes" | "guests" | "hasAgent" | "now">, input: GrantInput): InviteResult {
  const now = (deps.now ?? Date.now)()
  const name = String(input.name ?? "").trim().slice(0, 120)
  const guest = String(input.guest ?? "").trim().slice(0, 80)
  if (!name) return { ok: false, error: "name is required: what you call this grant, e.g. \"Support session for company X\"" }
  if (!guest) return { ok: false, error: "guest is required: the other organisation's name" }
  if (!input.agentId || !deps.hasAgent(input.agentId)) return { ok: false, error: `agent must be an agent on this node, got "${input.agentId ?? ""}"` }
  const level = autonomyLevelSchema.safeParse(input.level ?? "propose")
  if (!level.success) return { ok: false, error: "level must be report, propose or act" }
  const days = input.days === undefined ? DEFAULT_GRANT_DAYS : Number(input.days)
  if (!Number.isFinite(days) || days < 1 || days > MAX_GRANT_DAYS) return { ok: false, error: `days must be between 1 and ${MAX_GRANT_DAYS}` }
  const id = newGrantId(now)
  const { token, record } = deps.tokens.create({ name: `guest ${guest} (${name})`, scopes: [`${GUEST_SCOPE_PREFIX}${id}`], expiresInDays: Math.ceil(days) })
  const { code, expiresAt: codeExpiresAt } = deps.codes.create({ token, tokenId: record.id, name: id })
  const grant: GuestGrant = {
    id, name, guest, agentId: input.agentId,
    folders: list(input.folders), skills: list(input.skills), commands: list(input.commands),
    level: level.data, state: "pending", tokenId: record.id,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString(),
    usage: { turns: 0, tokens: 0 },
  }
  deps.guests.add(grant)
  deps.guests.log({ grant: id, event: "invited", detail: `${guest}: ${name}` })
  return { ok: true, code, codeExpiresAt, grant }
}

export type JoinResult =
  | { status: 200; body: { grant: string; name: string; agentId: string; level: AutonomyLevel; expiresAt: string; state: "pending" }; token: string }
  | { status: 401 | 403; body: { error: string } }
  | { status: 429; body: { error: string; retryAfter: number }; retryAfter: number }

export const JOIN_FAILED = "That code didn't work. Ask the host for a new one."

/** POST /mesh/guest/join: the guest trades the code for its key and asks
 *  the host to approve the join. */
export async function joinGuest(
  body: Record<string, unknown>,
  client: string,
  deps: GuestDeps,
): Promise<JoinResult> {
  const started = Date.now()
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) {
    log(`[guests] join refused from ${client}: locked out for ${wait}s more`)
    return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  }
  const redeemed = deps.codes.redeem(body.code)
  const rec = redeemed ? deps.tokens.verify(redeemed.token) : null
  const grantId = rec ? grantIdOf(rec) : null
  const grant = grantId ? deps.guests.get(grantId) : null
  await padTo(started, deps.minMs ?? MIN_MS)
  if (!redeemed || !rec || !grant || grant.tokenId !== rec.id || grant.state === "ended") {
    deps.limiter.fail(client)
    log(`[guests] join failed from ${client}`)
    return { status: 401, body: { error: PAIR_CODE_FAILED } }
  }
  deps.limiter.succeed(client)
  const node = (body.node && typeof body.node === "object" ? body.node : {}) as Record<string, unknown>
  const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, n) : undefined)
  const guestNode = { id: str(node.id, 80), name: str(node.name, 80), address: client }
  const until = grant.expiresAt.slice(0, 10)
  const card = createCard(deps.root, {
    title: `Guest mesh: ${grant.guest} wants to join`,
    ask: `Let "${guestNode.name ?? guestNode.id ?? "a node"}" at ${client} use ${grant.agentId} inside "${grant.name}" (${grant.level}, until ${until})?`,
    recommend: `Yes if ${grant.guest} told you they are joining now. No if you did not expect it.`,
    if_silent: "discard",
    raised_by: JOIN_CARD_BY,
  }, { now: now() })
  if (!card.ok) {
    log(`[guests] ${grant.id}: join from ${client} could not raise a card: ${card.error}`)
    return { status: 403, body: { error: "The host cannot take a join right now. Try again later." } }
  }
  deps.guests.update(grant.id, { guestNode, cardId: card.card.id })
  deps.guests.log({ grant: grant.id, event: "joined", address: client, detail: guestNode.name ?? guestNode.id })
  log(`[guests] ${grant.id}: ${grant.guest} joined from ${client}; waiting for the owner (card ${card.card.id})`)
  return {
    status: 200,
    body: { grant: grant.id, name: grant.name, agentId: grant.agentId, level: grant.level, expiresAt: grant.expiresAt, state: "pending" },
    token: redeemed.token,
  }
}

export type AccessResult =
  | { ok: true; grant: GuestGrant }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 403; error: string; waiting?: true; paused?: true }

export const NO_GRANT = "no grant opens this"
export const WAITING_HOST = "waiting for the host to approve the join"
export const PAUSED = "the host paused this grant"

type SettleDeps = Pick<GuestDeps, "tokens" | "guests" | "root" | "now" | "log">

/** Applies what time and the host's card say: an expired grant ends, a
 *  decided join card activates or ends the grant. Returns the grant as it
 *  stands now. Both sides call this: the guest on every request, the host
 *  before listing or acting, so a yes on the card counts at once. */
export function settleGrant(deps: SettleDeps, grant: GuestGrant): GuestGrant {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  if (grant.state === "ended") return grant
  if (Date.parse(grant.expiresAt) <= now()) {
    log(`[guests] ${grant.id}: expired`)
    return endGrant({ tokens: deps.tokens, guests: deps.guests, now }, grant.id, "expired") ?? grant
  }
  if (grant.state !== "pending") return grant
  const card = grant.cardId ? readCard(deps.root, grant.cardId) : null
  const answer = !card ? null : card.status === "decided" ? card.verdict : card.status === "expired" ? "no" : null
  if (answer === "yes") {
    const out = deps.guests.update(grant.id, { state: "active", approvedAt: new Date(now()).toISOString() }) ?? grant
    deps.guests.log({ grant: grant.id, event: "approved", detail: card?.decided_by })
    log(`[guests] ${grant.id}: join approved`)
    return out
  }
  if (answer === "no") {
    const reason = card?.status === "expired" ? "the host did not answer in time" : "the host said no"
    const out = endGrant({ tokens: deps.tokens, guests: deps.guests, now }, grant.id, reason) ?? grant
    deps.guests.log({ grant: grant.id, event: "refused", detail: reason })
    log(`[guests] ${grant.id}: join refused: ${reason}`)
    return out
  }
  return grant
}

/** Whether `token` opens a grant right now. */
export function guestAccess(token: string | null, deps: SettleDeps): AccessResult {
  const rec = token ? deps.tokens.verify(token) : null
  const grantId = rec ? grantIdOf(rec) : null
  const found = grantId ? deps.guests.get(grantId) : null
  if (!rec || !found || found.tokenId !== rec.id) return { ok: false, status: 401, error: NO_GRANT }
  const grant = settleGrant(deps, found)
  if (grant.state === "ended") return { ok: false, status: 401, error: NO_GRANT }
  if (grant.state === "pending") return { ok: false, status: 403, error: WAITING_HOST, waiting: true }
  if (grant.state === "paused") return { ok: false, status: 403, error: PAUSED, paused: true }
  return { ok: true, grant }
}

/** What the host agent is told on every guest turn. */
export function grantBrief(grant: GuestGrant): string {
  const none = (xs: string[], word: string) => xs.length ? xs.join(", ") : `none named: do not touch ${word} unless the owner's own instructions already allow it for this work`
  const level =
    grant.level === "report" ? "report: read and answer only; change nothing" :
    grant.level === "propose" ? "propose: you may prepare changes and open a merge request or draft; never merge, deploy or delete" :
    "act: you may act inside the grant without asking"
  return [
    `[Guest mesh] You are working for a guest organisation, "${grant.guest}", under the grant "${grant.name}" that the owner of this node opened.`,
    `Stay inside it. Folders: ${none(grant.folders, "files")}. Skills: ${none(grant.skills, "skills")}. Commands: ${none(grant.commands, "commands")}. Freedom: ${level}. The grant ends on ${grant.expiresAt.slice(0, 10)}.`,
    `Anything outside the grant: say it is not covered and stop. The guest sees only your answers: never reveal other chats, agents, people or files of this node.`,
  ].join("\n")
}

/** A guest's message as a turn of the host agent. */
export function guestTask(grant: GuestGrant, message: string): {
  agentId: string
  message: string
  context: { channel: "guest"; chatId: string; sender: string }
  systemPromptAppend: string
  autonomy?: AutonomyLevel
} {
  return {
    agentId: grant.agentId,
    message,
    context: { channel: "guest", chatId: `guest:${grant.id}`, sender: `guest:${grant.guest}` },
    systemPromptAppend: grantBrief(grant),
    ...(grant.level === "act" ? {} : { autonomy: grant.level }),
  }
}

type ControlDeps = Pick<GuestDeps, "tokens" | "guests" | "now">

export function pauseGrant(deps: ControlDeps, id: string): GuestGrant | null {
  const grant = deps.guests.get(id)
  if (!grant || grant.state !== "active") return null
  const out = deps.guests.update(id, { state: "paused", pausedAt: new Date((deps.now ?? Date.now)()).toISOString() })
  deps.guests.log({ grant: id, event: "paused" })
  return out
}

export function resumeGrant(deps: ControlDeps, id: string): GuestGrant | null {
  const grant = deps.guests.get(id)
  if (!grant || grant.state !== "paused") return null
  const out = deps.guests.update(id, { state: "active", pausedAt: undefined })
  deps.guests.log({ grant: id, event: "resumed" })
  return out
}

/** Ends the grant: its key stops at once. */
export function endGrant(deps: ControlDeps, id: string, reason = "ended by the host"): GuestGrant | null {
  const grant = deps.guests.get(id)
  if (!grant || grant.state === "ended") return null
  deps.tokens.revoke(grant.tokenId)
  const out = deps.guests.update(id, { state: "ended", endedAt: new Date((deps.now ?? Date.now)()).toISOString(), endedReason: reason })
  deps.guests.log({ grant: id, event: reason === "expired" ? "expired" : "ended", detail: reason })
  return out
}

export interface GrantPatch { folders?: unknown; skills?: unknown; commands?: unknown; level?: unknown; days?: unknown }

/** Widen or narrow a grant while it is in use. */
export function updateGrant(deps: ControlDeps, id: string, patch: GrantPatch): { ok: true; grant: GuestGrant } | { ok: false; error: string } {
  const grant = deps.guests.get(id)
  if (!grant || grant.state === "ended") return { ok: false, error: `no open grant "${id}"` }
  const next: Partial<GuestGrant> = {}
  if (patch.folders !== undefined) next.folders = list(patch.folders)
  if (patch.skills !== undefined) next.skills = list(patch.skills)
  if (patch.commands !== undefined) next.commands = list(patch.commands)
  if (patch.level !== undefined) {
    const level = autonomyLevelSchema.safeParse(patch.level)
    if (!level.success) return { ok: false, error: "level must be report, propose or act" }
    next.level = level.data
  }
  if (patch.days !== undefined) {
    const days = Number(patch.days)
    if (!Number.isFinite(days) || days < 1 || days > MAX_GRANT_DAYS) return { ok: false, error: `days must be between 1 and ${MAX_GRANT_DAYS}` }
    next.expiresAt = new Date((deps.now ?? Date.now)() + days * 86_400_000).toISOString()
  }
  const out = deps.guests.update(id, next)!
  const order: AutonomyLevel[] = ["report", "propose", "act"]
  const wider = (next.level && order.indexOf(next.level) > order.indexOf(grant.level))
    || (next.folders && next.folders.length > grant.folders.length)
    || (next.skills && next.skills.length > grant.skills.length)
    || (next.commands && next.commands.length > grant.commands.length)
    || (next.expiresAt && next.expiresAt > grant.expiresAt)
  deps.guests.log({ grant: id, event: wider ? "widened" : "narrowed", detail: Object.keys(next).join(", ") })
  return { ok: true, grant: out }
}

/** What the guest may know about its grant. */
export function grantForGuest(grant: GuestGrant): Record<string, unknown> {
  return {
    grant: grant.id, name: grant.name, agentId: grant.agentId, level: grant.level,
    folders: grant.folders, skills: grant.skills, commands: grant.commands,
    state: grant.state, expiresAt: grant.expiresAt, usage: grant.usage,
  }
}

async function padTo(started: number, minMs: number): Promise<void> {
  const left = started + minMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}
