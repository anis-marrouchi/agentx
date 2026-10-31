import type { IncomingMessage } from "http"
import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { readJson } from "@/daemon/app-fleet"
import type { MailSenderConfig } from "@/daemon/config"
import type { OutgoingMail } from "@/channels/email/smtp"
import { sendSystemMail } from "@/mail/sender"
import { splitIdentity, type Person } from "@/people/people"
import { MEMBER_KEY_DAYS, MEMBER_SCOPE_PREFIX, clientAddress, machineName, pageFor, startMachine, type MemberDeps } from "./pairing"

// --- Signing in with a link sent by email (#1478) ---
//
// Another road to the same place as a pairing code: the person's own
// `member:<person>` key for this machine, held until the owner says yes on
// the same card (startMachine in pairing.ts), then their /member page. So a
// signed-in browser shows on People with End access like any paired machine,
// and no owner gate accepts its key.
//
//   who      a member or a client whose people entry has `email:<address>`.
//            The owner, a guest or an unknown address gets no link, and the
//            answer is the same either way.
//   the link 32 random bytes, once, for 15 minutes; only its hash is kept.
//            It sits after the # in the mailed address, so it never reaches
//            a server log, and opening it only shows a Sign in button: a
//            mail filter that opens links does not spend it.
//   checked  again when spent: the address must still be the person's.

export const LINK_TTL_MS = 15 * 60 * 1000
export const LINK_MINUTES = LINK_TTL_MS / 60000
/** Roles that may sign in by link. The owner keeps the dashboard token
 *  until #1478 question 4 is answered; guests reach agents by channel only. */
export const SIGN_IN_ROLES = ["member", "client"]
export const LINK_FAILED = `That link didn't work. A link works once, for ${LINK_MINUTES} minutes. Ask for a new one.`
export const LINK_ASKED = "If this address may sign in here, a link is on its way. Check your inbox."
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
    const tmp = `${this.file}.tmp`
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
    return s?.channel === "email" && s.value === want
  })) ?? null
}

export interface SignInSetup { origin: string; sender: MailSenderConfig }

export interface SignInDeps extends MemberDeps {
  links: SignInLinkStore
  /** Links per address, and per network address, an hour (design note §3). */
  perAddress: SendLimiter
  perClient: SendLimiter
  /** Null while `wall.signIn.origin` or `mail.sender` is unset. */
  setup: () => SignInSetup | null
  send?: (sender: MailSenderConfig, mail: OutgoingMail) => Promise<string>
}

export const NOT_SET_UP = "Signing in by email is not set up here. Ask the person who invited you for a pairing code."

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
      `It works once, for ${LINK_MINUTES} minutes. The owner approves each new browser once.`,
      ``,
      `If you did not ask for it, you can ignore this mail.`,
    ].join("\n"),
  }
}

export type AskResult = { status: 200 | 400 | 404 | 429; body: { ok?: true; message?: string; error?: string } }

/** POST /api/member/signin-link: mail a link if the address may sign in.
 *  The answer does not say whether it may; the mail goes out after it. */
export async function askSignInLink(req: IncomingMessage, deps: SignInDeps): Promise<AskResult> {
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
    log(`[member] sign-in link for ${person.id} not sent: too many this hour`)
  } else {
    const { code } = deps.links.create(person.id, email)
    const mail = signInMail({ person, email, origin: setup.origin, code, senderName: setup.sender.name })
    ;(deps.send ?? sendSystemMail)(setup.sender, mail).then(
      () => {
        deps.members.log({ person: person.id, event: "invited", address: client, detail: "sign-in link mailed" })
        log(`[member] sign-in link mailed to ${person.id}, asked from ${client}`)
      },
      (err) => log(`[member] sign-in link for ${person.id} not sent: ${err instanceof Error ? err.message : String(err)}`),
    )
  }
  return { status: 200, body: { ok: true, message: LINK_ASKED } }
}

export type SignInResult =
  | { status: 200; body: { person: string; name: string; state: "pending" }; token: string }
  | { status: 401 | 403 | 404 | 503; body: { error: string } }
  | { status: 429; body: { error: string; retryAfter: number }; retryAfter: number }

/** POST /api/member/signin: spend the link, and start this browser as a
 *  machine of the person's, waiting for the owner's yes. */
export async function signInWithLink(req: IncomingMessage, deps: SignInDeps): Promise<SignInResult> {
  const started = Date.now()
  const log = deps.log ?? ((line: string) => console.log(line))
  if (!deps.setup()) return { status: 404, body: { error: NOT_SET_UP } }
  const client = clientAddress(req)
  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  let code: unknown = null
  let machine = ""
  try { const body = await readJson(req, 2048); code = body.code; machine = machineName(body.machine) } catch { /* a wrong link */ }
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
  const { token, record } = deps.tokens.create({
    name: `${person.name} (signed in by email)`,
    scopes: [`${MEMBER_SCOPE_PREFIX}${person.id}`],
    expiresInDays: MEMBER_KEY_DAYS,
  })
  const begun = await startMachine(req, deps, record, person.id, machine, "email link")
  return begun.ok
    ? { status: 200, body: { person: person.id, name: begun.name, state: "pending" }, token }
    : { status: begun.status, body: { error: begun.error } }
}

async function padTo(started: number, minMs: number): Promise<void> {
  const left = started + minMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}
