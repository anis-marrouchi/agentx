import type { IncomingMessage } from "http"
import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { readJson } from "@/daemon/app-fleet"
import type { MailSenderConfig } from "@/daemon/config"
import type { OutgoingMail } from "@/channels/email/smtp"
import { sendSystemMail } from "@/mail/sender"
import { HUB_NAME } from "@/daemon/ui/hub-name"
import { createCard, readCard } from "@/approvals/cards"
import { splitIdentity, type Person } from "@/people/people"
import type { PairAttemptLimiter } from "@/daemon/app-pair-code"
import type { MemberStore } from "./store"
import { PersonSessionStore, type PersonSession } from "./person-sessions"
import { SignInAccountStore, type SignInAccount } from "./signin-accounts"
import {
  NETWORK_MISMATCH, PAIRING_CARD_BY, TOO_MANY_WAITING,
  cardAnswer, clientAddress, machineName, networkIdentities, networkLogin, pageFor,
} from "./pairing"

// --- Signing in with a link sent by email (#1478, slice 3) ---
//
// The link gives the browser a personal session (person-sessions.ts, the
// ax_person cookie), never a member key and never the owner's ax_session.
// That session opens the person's /member page, as a paired machine does.
//
//   who      a member, a client or the owner whose people entry has
//            `email:<address>`. A guest or an unknown address gets no link,
//            and the answer is the same either way.
//   the link 32 random bytes, once, for 15 minutes; only its hash is kept.
//            It sits after the # in the mailed address, so it never reaches
//            a server log, and opening it only shows a Sign in button: a
//            mail filter that opens links does not spend it.
//   checked  again when spent: the address must still be the person's.
//   first    a person's first sign-in raises the owner's card, the one a new
//            machine gets; until the yes, the browser waits. Later sign-ins
//            go straight in. `wall.signIn.firstSignIn: "auto"` skips the
//            card for members, never for clients.
//   owner    every new owner browser raises its own card, whatever was said
//            before, and `auto` never applies. The card is popup-only: a yes
//            is taken only in the daemon's popup on the home machine (macOS,
//            approvals.popup.enabled), where a person has to click it. The
//            dashboard, even opened on this machine, the CLI, a phone, a
//            mesh peer and a channel reply can say no, never yes: an ssh
//            tunnel or an agent looks the same as the owner at a loopback
//            address. Popup-only stops a remote yes (phone, mesh, channel,
//            dashboard), not a local process running as the owner: that
//            can write .agentx/approvals/*.json or the person-sessions file
//            directly and read dashboard.token. Once confirmed, the session carries full owner rights
//            at every owner gate of board-dashboard.ts (ownerAccess), for as
//            long as the person's role is still owner (design note, answer 4).

export const LINK_TTL_MS = 15 * 60 * 1000
export const LINK_MINUTES = LINK_TTL_MS / 60000
/** Roles that may sign in with a provider account (oidc.ts). */
export const SIGN_IN_ROLES = ["member", "client"]
/** Roles that may sign in by link: the owner too, each new browser
 *  confirmed on the home machine. */
export const LINK_ROLES = [...SIGN_IN_ROLES, "owner"]
/** Where the owner lands once a browser is confirmed: the Wall. */
export const OWNER_HOME = "/"
export const LINK_FAILED = `That link didn't work. A link works once, for ${LINK_MINUTES} minutes. Ask for a new one.`
export const LINK_ASKED = "If this address may sign in here, a link is on its way. Check your inbox."
export const NOT_SET_UP = "Signing in by email is not set up here. Ask the person who invited you for a pairing code."
const FILE = ".agentx/signin-links.json"
const MIN_MS = 400

interface LinkRecord { id: string; personId: string; email: string; expiresAt: string }

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex")

export class SignInLinkStore {
  private file: string

  constructor(baseDir: string = process.cwd(), private now: () => number = Date.now) {
    this.file = resolve(baseDir, FILE)
  }

  /** A new link for this person; an earlier one of theirs stops working. */
  create(personId: string, email: string): { code: string; expiresAt: string } {
    const code = randomBytes(32).toString("base64url")
    const expiresAt = new Date(this.now() + LINK_TTL_MS).toISOString()
    const links = this.live().filter((l) => l.personId !== personId)
    links.push({ id: hashOf(code), personId, email, expiresAt })
    this.save(links)
    return { code, expiresAt }
  }

  /** The link's record if `code` is a live link; it is spent either way. */
  spend(code: unknown): LinkRecord | null {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null
    const id = hashOf(code)
    const links = this.live()
    const found = links.find((l) => l.id === id) ?? null
    if (found) this.save(links.filter((l) => l !== found))
    return found
  }

  private live(): LinkRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const links = JSON.parse(readFileSync(this.file, "utf-8")).links
      return Array.isArray(links) ? links.filter((l: LinkRecord) => Date.parse(l.expiresAt) > this.now()) : []
    } catch { return [] }
  }

  private save(links: LinkRecord[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify({ links }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/** At most `limit` hits per key in a sliding window, kept in memory. */
export class SendLimiter {
  private hits = new Map<string, number[]>()
  constructor(private limit: number, private windowMs = 60 * 60 * 1000, private now: () => number = Date.now) {}

  take(key: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs)
    const ok = recent.length < this.limit
    if (ok) recent.push(t)
    this.hits.set(key, recent)
    return ok
  }
}

/** The person whose `email:` identity is this address, else null. */
export function personByEmail(people: Person[], email: string): Person | null {
  const want = email.trim().toLowerCase()
  return people.find((p) => p.identities.some((i) => {
    const s = splitIdentity(i)
    return s?.channel === "email" && s.value.toLowerCase() === want
  })) ?? null
}

export interface SignInSetup { origin: string; sender: MailSenderConfig; firstSignIn: "card" | "auto" }

export interface SignInDeps {
  links: SignInLinkStore
  sessions: PersonSessionStore
  members: MemberStore
  people: () => Person[]
  /** The install folder: where the decision cards live. */
  root: string
  /** Wrong links per network address, the pairing code's lockout. */
  limiter: PairAttemptLimiter
  /** Links an hour (design note §3): per address from one network address,
   *  per address from anywhere (a higher ceiling), and per network address.
   *  Keyed by requester first, so a stranger asking for the owner's address
   *  cannot use up the owner's own links (#1478). */
  perRequester: SendLimiter
  perAddress: SendLimiter
  perClient: SendLimiter
  /** Null while `wall.signIn.origin` or `mail.sender` is unset. */
  setup: () => SignInSetup | null
  send?: (sender: MailSenderConfig, mail: OutgoingMail) => Promise<string>
  now?: () => number
  minMs?: number
  log?: (line: string) => void
  /** The account each person first signed in with (#1675); the file in `root` when unset. */
  accounts?: SignInAccountStore
}

const accountsOf = (deps: Pick<SignInDeps, "accounts" | "root">) => deps.accounts ?? new SignInAccountStore(deps.root)

/** The mail with the link. Plain text: no tracking, nothing to load. */
export function signInMail(p: { person: Pick<Person, "name" | "role">; email: string; origin: string; code: string; senderName: string }): OutgoingMail {
  return {
    to: p.email,
    subject: `${p.senderName}: your sign-in link`,
    text: [
      `Hi ${p.person.name},`,
      ``,
      p.person.role === "owner" ? `Open this link to sign in to your ${HUB_NAME} as the owner:` : `Open this link to sign in to "${pageFor(p.person.role)}":`,
      ``,
      `${p.origin.replace(/\/+$/, "")}/member/signin#${p.code}`,
      ``,
      `It works once, for ${LINK_MINUTES} minutes.`,
      ``,
      `If you did not ask for it, you can ignore this mail.`,
    ].join("\n"),
  }
}

export type AskResult = { status: 200 | 400 | 404 | 429; body: { ok?: true; message?: string; error?: string } }

/** POST /api/member/signin-link: mail a link if the address may sign in.
 *  The answer does not say whether it may; the mail goes out after it. */
export async function askSignInLink(req: IncomingMessage, deps: SignInDeps): Promise<AskResult> {
  const started = Date.now()
  const log = deps.log ?? ((line: string) => console.log(line))
  const setup = deps.setup()
  if (!setup) return { status: 404, body: { error: NOT_SET_UP } }
  const client = clientAddress(req)
  if (!deps.perClient.take(client)) {
    log(`[member] sign-in link refused from ${client}: too many asks this hour`)
    return { status: 429, body: { error: "Too many tries from here. Try again in an hour." } }
  }
  let email = ""
  try { const body = await readJson(req, 1024); email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "" } catch { /* empty */ }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: "Type your email address." } }

  const person = personByEmail(deps.people(), email)
  if (!person || !LINK_ROLES.includes(person.role)) {
    // The typed address is not logged: it may belong to nobody here.
    log(`[member] sign-in link asked from ${client}: no link (${person ? `role ${person.role}` : "unknown address"})`)
  } else if (!deps.perRequester.take(`${client} ${email}`) || !deps.perAddress.take(email)) {
    deps.members.log({ person: person.id, event: "refused", address: client, detail: "sign-in link: too many this hour" })
    log(`[member] sign-in link for ${person.id} not sent: too many this hour`)
  } else {
    const { code } = deps.links.create(person.id, email)
    const mail = signInMail({ person, email, origin: setup.origin, code, senderName: setup.sender.name })
    ;(deps.send ?? sendSystemMail)(setup.sender, mail).then(
      () => {
        deps.members.log({ person: person.id, event: "invited", address: client, detail: "sign-in link mailed" })
        log(`[member] sign-in link mailed to ${person.id}, asked from ${client}`)
      },
      (err) => {
        deps.members.log({ person: person.id, event: "refused", address: client, detail: "sign-in link: mail not sent" })
        log(`[member] sign-in link for ${person.id} not sent: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
  }
  // A known address writes the links file; the same wait hides that.
  await padTo(started, deps.minMs ?? MIN_MS)
  return { status: 200, body: { ok: true, message: LINK_ASKED } }
}

export type SignInResult =
  | { status: 200; body: { person: string; name: string; state: "pending" | "active" }; value: string }
  | { status: 401 | 403 | 404 | 503; body: { error: string } }
  | { status: 429; body: { error: string; retryAfter: number }; retryAfter: number }

/** POST /api/member/signin: spend the link and give this browser a session
 *  of the person's, waiting for the owner on their first sign-in. */
export async function signInWithLink(req: IncomingMessage, deps: SignInDeps): Promise<SignInResult> {
  const started = Date.now()
  const log = deps.log ?? ((line: string) => console.log(line))
  const setup = deps.setup()
  if (!setup) return { status: 404, body: { error: NOT_SET_UP } }
  const client = clientAddress(req)
  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  let code: unknown = null
  let label = ""
  try { const body = await readJson(req, 2048); code = body.code; label = machineName(body.machine) } catch { /* a wrong link */ }
  const link = deps.links.spend(code)
  // Checked again now: the address must still be this person's, in a role that signs in.
  const found = link ? personByEmail(deps.people(), link.email) : null
  const person = found && found.id === link!.personId && LINK_ROLES.includes(found.role) ? found : null
  await padTo(started, deps.minMs ?? MIN_MS)
  if (!person) {
    deps.limiter.fail(client)
    if (link) deps.members.log({ person: link.personId, event: "refused", address: client, detail: "sign-in link: address or role changed" })
    log(`[member] sign-in link failed from ${client}${link ? ` (${link.personId}: address or role changed)` : ""}`)
    return { status: 401, body: { error: LINK_FAILED } }
  }
  deps.limiter.succeed(client)
  return openSession(req, person, label, { via: "email link", proof: `the link mailed to ${person.name.slice(0, 60)}` }, setup, deps)
}

/** How a person proved who they are, for the logs and the owner's card. */
export interface SignInProof {
  via: string
  proof: string
  /** A provider account (#1675): kept for the person once they are let in. */
  account?: SignInAccount
}

/** What follows once the person is known, by a link or a sign-in provider:
 *  the network check, then straight in, or the owner's first-sign-in card. */
export function openSession(
  req: IncomingMessage, person: Person, label: string, how: SignInProof,
  setup: Pick<SignInSetup, "firstSignIn">, deps: SignInDeps,
): Exclude<SignInResult, { status: 429 }> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const client = clientAddress(req)
  const login = networkLogin(req)
  const expected = networkIdentities(person)
  if (expected.length && (!login || !expected.includes(login))) {
    deps.members.log({ person: person.id, event: "refused", address: client, detail: `sign-in ${how.via}: network login ${login ?? "missing"}; expected ${expected.join(" or ")}` })
    log(`[member] ${person.id}: sign-in from ${client} refused: the network says "${login ?? "nobody"}", expected ${expected.join(" or ")}`)
    return { status: 403, body: { error: NETWORK_MISMATCH } }
  }
  const name = label || "Unnamed browser"
  const at = new Date(now()).toISOString()

  // Let in before, or a member under `auto`: straight in. A yes on an
  // earlier card counts even if that browser has not called back yet.
  // Never for the owner: each new owner browser waits for its own card.
  const owner = person.role === "owner"
  const auto = person.role === "member" && setup.firstSignIn === "auto"
  settlePending(person, deps)
  if (!owner && (deps.sessions.approved(person.id) || auto)) {
    const { session, value } = deps.sessions.create(person.id, name, { approvedAt: at })
    if (how.account) accountsOf(deps).keepFirst(person.id, how.account)
    deps.members.log({ person: person.id, event: "signed-in", address: client, detail: `${name} (${how.via}${auto ? ", auto" : ""})` })
    log(`[member] ${person.id} signed in by ${how.via} on "${name}" from ${client} (session ${session.id})`)
    return { status: 200, body: { person: person.id, name, state: "active" }, value }
  }

  // The first sign-in: the owner's card. The name is in the title, so the
  // question stays under its 300 characters: at most 45 + 80 + 60 + 85.
  const who = person.name.slice(0, 60)
  const from = `From ${client}, ${login ? `network login ${login}` : "no network login reported"}.`
  const card = createCard(deps.root, owner ? {
    title: `${who} signed in as the owner from a new browser`,
    ask: `${from} Browser: "${name}". Give it full owner rights? A yes counts only in the popup here.`,
    recommend: `Signed in with ${how.proof}. Yes only if it is you: the yes is taken only in the popup on the home machine. No if it is not you.`,
    if_silent: "discard",
    raised_by: PAIRING_CARD_BY,
  } : {
    title: `${who} signed in for the first time`,
    ask: `${from} Browser name, as typed there: "${name}". Let them see their own work?`,
    recommend: `Signed in with ${how.proof}. Yes if you expected it. No if you did not.`,
    if_silent: "discard",
    raised_by: PAIRING_CARD_BY,
  }, { now: now(), popupOnly: owner })
  if (!card.ok) {
    deps.members.log({ person: person.id, event: "refused", address: client, detail: card.error })
    log(`[member] ${person.id}: sign-in from ${client} refused: ${card.error}`)
    return { status: 503, body: { error: TOO_MANY_WAITING } }
  }
  const { session, value } = deps.sessions.create(person.id, name, { state: "pending", cardId: card.card.id, account: how.account, ...(owner ? { role: "owner" as const } : {}) })
  deps.members.log({ person: person.id, event: "paired", address: client, detail: `${name} (${how.via}, ${owner ? "new owner browser" : "first sign-in"})` })
  log(owner
    ? `[member] ${person.id} signed in as the owner by ${how.via} on a new browser "${name}" from ${client}; waiting for a yes on the home machine (card ${card.card.id}, session ${session.id})`
    : `[member] ${person.id} signed in by ${how.via} for the first time on "${name}" from ${client}; waiting for the owner (card ${card.card.id}, session ${session.id})`)
  return { status: 200, body: { person: person.id, name, state: "pending" }, value }
}

export type PersonAccess =
  | { ok: true; session: PersonSession; person: Person }
  /** `owner`: an owner browser waiting for the home machine; `elsewhere`:
   *  its yes was given away from the home machine and does not count. */
  | { ok: false; waiting: boolean; owner?: boolean; elsewhere?: boolean }

type AccessDeps = Pick<SignInDeps, "sessions" | "members" | "people" | "root" | "log" | "accounts">

/** Whether an ax_person cookie value is let in right now. Reads the owner's
 *  answer on a first sign-in's card the first time it is there. The person's
 *  role is the one on the people list now, read again on each call. */
export function personAccess(value: string | null, deps: AccessDeps): PersonAccess {
  const found = value ? deps.sessions.verify(value, deps.people()) : null
  if (!found || !LINK_ROLES.includes(found.person.role)) return { ok: false, waiting: false }
  const { session, person } = found
  const owner = person.role === "owner"
  // A session started as a member or a client never becomes the owner's.
  if (owner && session.role !== "owner") return { ok: false, waiting: false }
  if (session.state !== "pending") return { ok: true, session, person }
  const settled = settle(session, person, deps)
  if (settled === "yes") return { ok: true, session: { ...session, state: undefined, approvedAt: session.approvedAt ?? new Date().toISOString() }, person }
  return { ok: false, waiting: settled === null || settled === "elsewhere", ...(owner ? { owner } : {}), ...(settled === "elsewhere" ? { elsewhere: true } : {}) }
}

/** Whether an ax_person cookie value carries owner rights right now: a
 *  session started as the owner, confirmed on the home machine, not ended,
 *  of a person whose role on the people list is still owner. Every owner
 *  gate of board-dashboard.ts asks this through ownerCredential. */
export function ownerAccess(value: string | null, deps: AccessDeps): boolean {
  if (!value) return false
  const access = personAccess(value, deps)
  return access.ok && access.person.role === "owner" && access.session.role === "owner" && !!access.session.approvedAt
}

/** Applies the owner's answers on this person's waiting sessions. Before a
 *  provider account is matched too, so a yes keeps its account first. */
export function settlePending(person: Person, deps: Pick<SignInDeps, "sessions" | "members" | "root" | "log" | "accounts">): void {
  for (const s of deps.sessions.sessions(person.id)) if (s.state === "pending" && !s.endedAt) settle(s, person, deps)
}

/** Applies the owner's answer on a waiting session's card, once it is there.
 *  "elsewhere": a yes for an owner browser, given away from the home machine. */
function settle(session: PersonSession, person: Person, deps: Pick<SignInDeps, "sessions" | "members" | "root" | "log" | "accounts">): "yes" | "no" | "elsewhere" | null {
  const log = deps.log ?? ((line: string) => console.log(line))
  const card = session.cardId ? readCard(deps.root, session.cardId) : null
  const answer = cardAnswer(card)
  // An owner browser takes only a yes clicked in the popup. decideCard
  // already refuses any other yes on its card; this is the second lock.
  if (answer === "yes" && (session.role === "owner" || person.role === "owner") && card?.decided_from !== "popup") {
    if (deps.sessions.noteOffBoxYes(session.id)) {
      const reason = `the yes came from away from the home machine${card?.decided_by ? ` (${card.decided_by})` : ""}; confirm this browser on the home machine`
      deps.members.log({ person: person.id, event: "refused", detail: `${session.label}: ${reason}` })
      log(`[member] ${person.id}: owner browser "${session.label}" not let in: ${reason}`)
    }
    return "elsewhere"
  }
  // A yes for a second provider account, after another was kept for this
  // person (two cards waiting, both answered yes), lets nobody in.
  const kept = answer === "yes" && session.account ? accountsOf(deps).get(person.id, session.account.issuer) : null
  if (kept && kept !== session.account!.subject) {
    const reason = "another account was kept for this person first"
    deps.sessions.end(person.id, session.id, reason)
    deps.members.log({ person: person.id, event: "refused", detail: `${session.label}: ${reason}` })
    log(`[member] ${person.id}: first sign-in on "${session.label}" refused: ${reason}`)
    return "no"
  }
  if (answer === "yes") {
    if (deps.sessions.approve(session.id) && session.account) accountsOf(deps).keepFirst(person.id, session.account)
    const owner = session.role === "owner"
    deps.members.log({ person: person.id, event: "approved", detail: `${session.label} (email link${owner ? ", owner, on the home machine" : ""})${card?.decided_by ? `, by ${card.decided_by}` : ""}` })
    log(`[member] ${person.id}: ${owner ? "owner browser" : "first sign-in on"} "${session.label}" approved${owner ? " on the home machine: full owner rights" : ""}`)
  } else if (answer === "no") {
    const reason = card?.status === "expired" ? "the owner did not answer in time" : "the owner said no"
    deps.sessions.end(person.id, session.id, reason)
    deps.members.log({ person: person.id, event: "refused", detail: `${session.label} (email link): ${reason}` })
    log(`[member] ${person.id}: first sign-in on "${session.label}" refused: ${reason}`)
  }
  return answer
}

async function padTo(started: number, minMs: number): Promise<void> {
  const left = started + minMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}
