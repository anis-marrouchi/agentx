import type { IncomingMessage } from "http"
import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { readJson } from "@/daemon/app-fleet"
import type { MailSenderConfig } from "@/daemon/config"
import type { OutgoingMail } from "@/channels/email/smtp"
import { sendSystemMail } from "@/mail/sender"
import { createCard, readCard } from "@/approvals/cards"
import { splitIdentity, type Person } from "@/people/people"
import type { PairAttemptLimiter } from "@/daemon/app-pair-code"
import type { MemberStore } from "./store"
import { PersonSessionStore, type PersonSession } from "./person-sessions"
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
//   who      a member or a client whose people entry has `email:<address>`.
//            The owner, a guest or an unknown address gets no link, and the
//            answer is the same either way. The owner's sign-in waits for
//            its home-machine confirmation (design note, answer 4).
//   the link 32 random bytes, once, for 15 minutes; only its hash is kept.
//            It sits after the # in the mailed address, so it never reaches
//            a server log, and opening it only shows a Sign in button: a
//            mail filter that opens links does not spend it.
//   checked  again when spent: the address must still be the person's.
//   first    a person's first sign-in raises the owner's card, the one a new
//            machine gets; until the yes, the browser waits. Later sign-ins
//            go straight in. `wall.signIn.firstSignIn: "auto"` skips the
//            card for members, never for clients.

export const LINK_TTL_MS = 15 * 60 * 1000
export const LINK_MINUTES = LINK_TTL_MS / 60000
/** Roles that may sign in by link. */
export const SIGN_IN_ROLES = ["member", "client"]
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
  /** Links per address, and per network address, an hour (design note §3). */
  perAddress: SendLimiter
  perClient: SendLimiter
  /** Null while `wall.signIn.origin` or `mail.sender` is unset. */
  setup: () => SignInSetup | null
  send?: (sender: MailSenderConfig, mail: OutgoingMail) => Promise<string>
  now?: () => number
  minMs?: number
  log?: (line: string) => void
}

/** The mail with the link. Plain text: no tracking, nothing to load. */
export function signInMail(p: { person: Pick<Person, "name" | "role">; email: string; origin: string; code: string; senderName: string }): OutgoingMail {
  return {
    to: p.email,
    subject: `${p.senderName}: your sign-in link`,
    text: [
      `Hi ${p.person.name},`,
      ``,
      `Open this link to sign in to "${pageFor(p.person.role)}":`,
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
  if (!person || !SIGN_IN_ROLES.includes(person.role)) {
    // The typed address is not logged: it may belong to nobody here.
    log(`[member] sign-in link asked from ${client}: no link (${person ? `role ${person.role}` : "unknown address"})`)
  } else if (!deps.perAddress.take(email)) {
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
  const now = deps.now ?? Date.now
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
  const person = found && found.id === link!.personId && SIGN_IN_ROLES.includes(found.role) ? found : null
  await padTo(started, deps.minMs ?? MIN_MS)
  if (!person) {
    deps.limiter.fail(client)
    if (link) deps.members.log({ person: link.personId, event: "refused", address: client, detail: "sign-in link: address or role changed" })
    log(`[member] sign-in link failed from ${client}${link ? ` (${link.personId}: address or role changed)` : ""}`)
    return { status: 401, body: { error: LINK_FAILED } }
  }
  deps.limiter.succeed(client)
  const login = networkLogin(req)
  const expected = networkIdentities(person)
  if (expected.length && (!login || !expected.includes(login))) {
    deps.members.log({ person: person.id, event: "refused", address: client, detail: `sign-in link: network login ${login ?? "missing"}; expected ${expected.join(" or ")}` })
    log(`[member] ${person.id}: sign-in from ${client} refused: the network says "${login ?? "nobody"}", expected ${expected.join(" or ")}`)
    return { status: 403, body: { error: NETWORK_MISMATCH } }
  }
  const name = label || "Unnamed browser"
  const at = new Date(now()).toISOString()

  // Let in before, or a member under `auto`: straight in. A yes on an
  // earlier card counts even if that browser has not called back yet.
  const auto = person.role === "member" && setup.firstSignIn === "auto"
  for (const s of deps.sessions.sessions(person.id)) if (s.state === "pending" && !s.endedAt) settle(s, person, deps)
  if (deps.sessions.approved(person.id) || auto) {
    const { session, value } = deps.sessions.create(person.id, name, { approvedAt: at })
    deps.members.log({ person: person.id, event: "signed-in", address: client, detail: `${name} (email link${auto ? ", auto" : ""})` })
    log(`[member] ${person.id} signed in by email link on "${name}" from ${client} (session ${session.id})`)
    return { status: 200, body: { person: person.id, name, state: "active" }, value }
  }

  // The first sign-in: the owner's card. The name is in the title, so the
  // question stays under its 300 characters: at most 45 + 80 + 60 + 85.
  const who = person.name.slice(0, 60)
  const card = createCard(deps.root, {
    title: `${who} signed in for the first time`,
    ask: `From ${client}, ${login ? `network login ${login}` : "no network login reported"}. Browser name, as typed there: "${name}". Let them see their own work?`,
    recommend: `Signed in with the link mailed to ${who}. Yes if you expected it. No if you did not.`,
    if_silent: "discard",
    raised_by: PAIRING_CARD_BY,
  }, { now: now() })
  if (!card.ok) {
    deps.members.log({ person: person.id, event: "refused", address: client, detail: card.error })
    log(`[member] ${person.id}: sign-in from ${client} refused: ${card.error}`)
    return { status: 503, body: { error: TOO_MANY_WAITING } }
  }
  const { session, value } = deps.sessions.create(person.id, name, { state: "pending", cardId: card.card.id })
  deps.members.log({ person: person.id, event: "paired", address: client, detail: `${name} (email link, first sign-in)` })
  log(`[member] ${person.id} signed in by email link for the first time on "${name}" from ${client}; waiting for the owner (card ${card.card.id}, session ${session.id})`)
  return { status: 200, body: { person: person.id, name, state: "pending" }, value }
}

export type PersonAccess =
  | { ok: true; session: PersonSession; person: Person }
  | { ok: false; waiting: boolean }

/** Whether an ax_person cookie value opens the member page right now. Reads
 *  the owner's answer on a first sign-in's card the first time it is there. */
export function personAccess(value: string | null, deps: Pick<SignInDeps, "sessions" | "members" | "people" | "root" | "log">): PersonAccess {
  const found = value ? deps.sessions.verify(value, deps.people()) : null
  if (!found || !SIGN_IN_ROLES.includes(found.person.role)) return { ok: false, waiting: false }
  const { session, person } = found
  if (session.state !== "pending") return { ok: true, session, person }
  const settled = settle(session, person, deps)
  if (settled === "yes") return { ok: true, session: { ...session, state: undefined }, person }
  return { ok: false, waiting: settled === null }
}

/** Applies the owner's answer on a waiting session's card, once it is there. */
function settle(session: PersonSession, person: Person, deps: Pick<SignInDeps, "sessions" | "members" | "root" | "log">): "yes" | "no" | null {
  const log = deps.log ?? ((line: string) => console.log(line))
  const card = session.cardId ? readCard(deps.root, session.cardId) : null
  const answer = cardAnswer(card)
  if (answer === "yes") {
    deps.sessions.approve(session.id)
    deps.members.log({ person: person.id, event: "approved", detail: `${session.label} (email link)${card?.decided_by ? `, by ${card.decided_by}` : ""}` })
    log(`[member] ${person.id}: first sign-in on "${session.label}" approved`)
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
