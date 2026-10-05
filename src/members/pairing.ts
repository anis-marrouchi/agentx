import type { IncomingMessage } from "http"
import { TokenStore, type TokenRecord } from "@/daemon/token-store"
import { PairCodeStore } from "@/daemon/pair-codes"
import type { PairAttemptLimiter } from "@/daemon/app-pair-code"
import { readJson } from "@/daemon/app-fleet"
import { createCard, readCard } from "@/approvals/cards"
import { splitIdentity, type Person } from "@/people/people"
import { MemberStore, type MemberDevice } from "./store"

// --- Inviting a teammate and pairing their machine (#385) ---
//
// The phone app is the model (app-pair-code.ts): a one-time code, a key
// per machine, a cookie the page holds. Three things are added for a
// teammate, because a member key must never be an owner key:
//
//   the right person   the code is minted for one person from the people
//                      list; the key it redeems carries `member:<person>`
//                      and opens that person's own work and nothing else.
//   the right machine  the owner says yes to each new machine on a decision
//                      card that names the person, the machine and where it
//                      came from. Until then the key is held.
//   the network's word where the private network says who is connecting
//                      (tailscale serve sets Tailscale-User-Login on what it
//                      proxies), the person must have that login among their
//                      identities as `tailscale:<login>`; a mismatch is
//                      refused and logged, and the code is spent. Only a
//                      request that arrives from this computer (where the
//                      proxy runs) is believed: anyone else could set the
//                      header themselves.

export const MEMBER_SCOPE_PREFIX = "member:"
/** How long a machine's key lives before the person must pair again. */
export const MEMBER_KEY_DAYS = 90
/** Who the pairing card is raised by: not an agent, so no agent is told
 *  the verdict; the member page reads it instead. */
export const PAIRING_CARD_BY = "members"
export const NETWORK_LOGIN_HEADER = "tailscale-user-login"
const MIN_MS = 400
const SEEN_EVERY_MS = 60 * 60 * 1000

/** The person a member key belongs to, from its scope. */
export function personOfToken(rec: TokenRecord): string | null {
  const scope = rec.scopes.find((s) => s.startsWith(MEMBER_SCOPE_PREFIX))
  return scope ? scope.slice(MEMBER_SCOPE_PREFIX.length) : null
}

/** The active member key `token` names, with its person, else null. */
export function verifyMemberToken(token: string | null, tokens: TokenStore): { rec: TokenRecord; personId: string } | null {
  if (!token) return null
  const rec = tokens.verify(token)
  const personId = rec ? personOfToken(rec) : null
  return rec && personId ? { rec, personId } : null
}

export interface MemberDeps {
  tokens: TokenStore
  codes: PairCodeStore
  members: MemberStore
  people: () => Person[]
  /** The install folder: where the decision cards live. */
  root: string
  limiter: PairAttemptLimiter
  now?: () => number
  minMs?: number
  log?: (line: string) => void
}

export type InviteResult =
  | { ok: true; code: string; expiresAt: string; tokenId: string; person: Person }
  | { ok: false; error: string }

/** Mint a key for one person and the one-time code that redeems it. */
export function inviteMember(deps: Pick<MemberDeps, "tokens" | "codes" | "members" | "people">, personId: string): InviteResult {
  const person = deps.people().find((p) => p.id === personId)
  if (!person) return { ok: false, error: `No person "${personId}". Add them first: agentx people add ${personId} --name "…"` }
  const { token, record } = deps.tokens.create({
    name: `${person.name} (machine not paired yet)`,
    scopes: [`${MEMBER_SCOPE_PREFIX}${person.id}`],
    expiresInDays: MEMBER_KEY_DAYS,
  })
  const { code, expiresAt } = deps.codes.create({ token, tokenId: record.id, name: person.id })
  deps.members.log({ person: person.id, device: record.id, event: "invited" })
  return { ok: true, code, expiresAt, tokenId: record.id, person }
}

export type PairResult =
  | { status: 200; body: { person: string; name: string; state: "pending" }; token: string }
  | { status: 401 | 403 | 503; body: { error: string } }
  | { status: 429; body: { error: string; retryAfter: number }; retryAfter: number }

export const NETWORK_MISMATCH = "The private network says someone else is connecting from this machine. Ask the person who invited you for a new code."
export const TOO_MANY_WAITING = "Too many machines are waiting for the owner's answer. Try again later."
/** A teammate or client has no terminal on the host, so the phone app's
 *  "run agentx app pair" (PAIR_CODE_FAILED) is the wrong advice here (#453). */
export const MEMBER_CODE_FAILED = "That code didn't work. Check it, or ask the person who invited you for a new one."

type ProxiedRequest = Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } | null }

const header = (req: ProxiedRequest, name: string): string => {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v || "").trim()
}

/** True when the request comes from this computer, which is where
 *  `tailscale serve` proxies from. A local process can still pretend. */
export function viaLocalProxy(req: ProxiedRequest): boolean {
  const a = req.socket?.remoteAddress || ""
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"
}

/** The login the private network reports for this request, if it does.
 *  A header on a request that did not come through the local proxy is the
 *  sender's own word, so it is ignored. */
export function networkLogin(req: ProxiedRequest): string | null {
  if (!viaLocalProxy(req)) return null
  const s = header(req, NETWORK_LOGIN_HEADER).toLowerCase()
  return s ? s.slice(0, 80) : null
}

/** Where the request came from: the address the local proxy reports
 *  (X-Forwarded-For) when there is one, else the socket's. Behind
 *  `tailscale serve` the socket is always this computer. The last entry is
 *  the one the proxy itself saw; earlier ones are the sender's own word
 *  when a proxy adds to the header instead of replacing it. */
export function clientAddress(req: ProxiedRequest): string {
  const socket = req.socket?.remoteAddress || "unknown"
  if (!viaLocalProxy(req)) return socket
  const seen = header(req, "x-forwarded-for").split(",").pop()!.trim()
  return /^[0-9a-fA-F:.]{2,45}$/.test(seen) ? seen : socket
}

/** A machine name as typed on the unpaired machine: letters, digits and a
 *  few marks only, so it cannot pass for part of the question the owner reads. */
export function machineName(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._'()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) : ""
}

/** The person's logins on the private network, from `tailscale:<login>` identities. */
export function networkIdentities(person: Person): string[] {
  return person.identities.map(splitIdentity).filter((i): i is { channel: string; value: string } => !!i && i.channel === "tailscale").map((i) => i.value)
}

/** POST /api/member/pair-code: trade the code for this machine's key, and
 *  ask the owner to approve the machine. */
export async function pairMemberMachine(req: IncomingMessage, deps: MemberDeps): Promise<PairResult> {
  const started = Date.now()
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const client = clientAddress(req)
  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) {
    log(`[member] pair-code refused from ${client}: locked out for ${wait}s more`)
    return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  }
  let code: unknown = null
  let machine = ""
  try {
    const body = await readJson(req, 2048)
    code = body.code
    machine = machineName(body.machine)
  } catch { /* counts as a wrong code */ }
  const redeemed = deps.codes.redeem(code)
  const verified = redeemed ? verifyMemberToken(redeemed.token, deps.tokens) : null
  await padTo(started, deps.minMs ?? MIN_MS)
  if (!redeemed || !verified) {
    deps.limiter.fail(client)
    log(`[member] pair-code failed from ${client}`)
    return { status: 401, body: { error: MEMBER_CODE_FAILED } }
  }
  deps.limiter.succeed(client)
  const { rec, personId } = verified
  const person = deps.people().find((p) => p.id === personId)
  if (!person) {
    deps.tokens.revoke(rec.id)
    deps.members.log({ person: personId, device: rec.id, event: "refused", address: client, detail: "person no longer listed" })
    log(`[member] pair-code for ${personId} refused from ${client}: person no longer listed`)
    return { status: 403, body: { error: MEMBER_CODE_FAILED } }
  }
  const login = networkLogin(req)
  const expected = networkIdentities(person)
  if (expected.length && (!login || !expected.includes(login))) {
    deps.tokens.revoke(rec.id)
    deps.members.log({ person: personId, device: rec.id, event: "refused", address: client, detail: `network login ${login ?? "missing"}; expected ${expected.join(" or ")}` })
    log(`[member] ${personId}: pairing from ${client} refused: the network says "${login ?? "nobody"}", expected ${expected.join(" or ")}`)
    return { status: 403, body: { error: NETWORK_MISMATCH } }
  }
  const name = machine || "Unnamed machine"
  // Cut so the card's 300-character question always fits.
  const who = person.name.slice(0, 40)
  const card = createCard(deps.root, {
    title: `New machine for ${who}`,
    ask: `From ${client}, ${login ? `network login ${login}` : "no network login reported"}. Machine name, as typed there: "${name}". Let it see ${who}'s own work?`,
    recommend: `Yes if ${who} told you they just paired this machine. No if you did not expect it.`,
    if_silent: "discard",
    raised_by: PAIRING_CARD_BY,
  }, { now: now() })
  if (!card.ok) {
    deps.tokens.revoke(rec.id)
    deps.members.log({ person: personId, device: rec.id, event: "refused", address: client, detail: card.error })
    log(`[member] ${personId}: pairing from ${client} refused: ${card.error}`)
    return { status: 503, body: { error: TOO_MANY_WAITING } }
  }
  deps.members.add({
    tokenId: rec.id, personId, name, state: "pending", cardId: card.card.id,
    address: client, ...(login ? { network: login } : {}), createdAt: new Date(now()).toISOString(),
  })
  deps.members.log({ person: personId, device: rec.id, event: "paired", address: client, detail: name })
  log(`[member] ${personId} paired "${name}" from ${client}; waiting for the owner (card ${card.card.id})`)
  return { status: 200, body: { person: personId, name, state: "pending" }, token: redeemed.token }
}

export type AccessResult =
  | { ok: true; device: MemberDevice; personId: string; rec: TokenRecord }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 403; error: string; waiting: true }

export const NOT_PAIRED = "this machine is not paired"
export const WAITING = "waiting for the owner to approve this machine"

/** The owner's answer on a pairing card: a card nobody answered in time is a
 *  no, and one still waiting is null. */
export function cardAnswer(card: ReturnType<typeof readCard>): "yes" | "no" | null {
  return !card ? null : card.status === "decided" ? (card.verdict ?? null) : card.status === "expired" ? "no" : null
}

/** A waiting machine's answer, read without changing anything. The record
 *  itself turns active or removed the next time that machine calls. */
export function pendingAnswer(root: string, device: Pick<MemberDevice, "state" | "cardId">): "yes" | "no" | null {
  return device.state === "pending" && device.cardId ? cardAnswer(readCard(root, device.cardId)) : null
}

/** Whether `token` opens the member page right now. Reads the owner's
 *  answer on the pairing card the first time it is there. */
export function memberAccess(token: string | null, deps: Pick<MemberDeps, "tokens" | "members" | "root" | "now" | "log"> & { people?: MemberDeps["people"] }, address?: string): AccessResult {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const verified = verifyMemberToken(token, deps.tokens)
  if (!verified) return { ok: false, status: 401, error: NOT_PAIRED }
  const { rec, personId } = verified
  let device = deps.members.byToken(rec.id)
  if (!device || device.state === "removed" || device.personId !== personId) return { ok: false, status: 401, error: NOT_PAIRED }
  // Taken off the people list by any road (the command, the file): the key ends.
  if (deps.people && !deps.people().some((p) => p.id === personId)) {
    removeDevice(deps, rec.id, "person no longer listed")
    log(`[member] ${personId}: "${device.name}" ended: person no longer listed`)
    return { ok: false, status: 401, error: NOT_PAIRED }
  }
  if (device.state === "pending") {
    const card = device.cardId ? readCard(deps.root, device.cardId) : null
    const answer = cardAnswer(card)
    if (answer === "yes") {
      device = deps.members.update(rec.id, { state: "active", approvedAt: new Date(now()).toISOString() }) ?? device
      deps.members.log({ person: personId, device: rec.id, event: "approved", detail: card?.decided_by })
      log(`[member] ${personId}: "${device.name}" approved`)
    } else if (answer === "no") {
      const reason = card?.status === "expired" ? "the owner did not answer in time" : "the owner said no"
      deps.tokens.revoke(rec.id)
      deps.members.update(rec.id, { state: "removed", removedAt: new Date(now()).toISOString(), removedReason: reason })
      deps.members.log({ person: personId, device: rec.id, event: "refused", detail: reason })
      log(`[member] ${personId}: "${device.name}" refused: ${reason}`)
      return { ok: false, status: 401, error: NOT_PAIRED }
    } else {
      return { ok: false, status: 403, error: WAITING, waiting: true }
    }
  }
  // Seen: once an hour per machine, or whenever it comes from somewhere new.
  const seenAt = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0
  if (address && (now() - seenAt >= SEEN_EVERY_MS || device.lastAddress !== address)) {
    device = deps.members.update(rec.id, { lastSeenAt: new Date(now()).toISOString(), lastAddress: address }) ?? device
    deps.members.log({ person: personId, device: rec.id, event: "signed-in", address })
  }
  return { ok: true, device, personId, rec }
}

/** The owner removes one machine: its key stops at once. */
export function removeDevice(deps: Pick<MemberDeps, "tokens" | "members" | "now">, tokenId: string, reason = "removed by the owner"): MemberDevice | null {
  const device = deps.members.byToken(tokenId)
  if (!device) return null
  deps.tokens.revoke(tokenId)
  const updated = deps.members.update(tokenId, { state: "removed", removedAt: new Date((deps.now ?? Date.now)()).toISOString(), removedReason: reason })
  deps.members.log({ person: device.personId, device: tokenId, event: "removed", detail: reason })
  return updated
}

/** The owner removes a person: every machine of theirs stops at once. */
export function removePersonDevices(deps: Pick<MemberDeps, "tokens" | "members" | "now">, personId: string): MemberDevice[] {
  return deps.members.devices(personId)
    .filter((d) => d.state !== "removed")
    .map((d) => removeDevice(deps, d.tokenId, "person removed by the owner"))
    .filter((d): d is MemberDevice => !!d)
}

async function padTo(started: number, minMs: number): Promise<void> {
  const left = started + minMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}
