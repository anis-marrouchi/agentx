import type { IncomingMessage, ServerResponse } from "http"
import type Database from "better-sqlite3"
import { TokenStore } from "./token-store"
import { PairCodeStore } from "./pair-codes"
import { PairAttemptLimiter } from "./app-pair-code"
import { RejectLog, credentialState, rejectFields } from "./app-auth-log"
import { appIconPng } from "./app-icon"
import { MemberStore } from "@/members/store"
import { clientAddress, memberAccess, pairMemberMachine } from "@/members/pairing"
import { PERSON_COOKIE, PERSON_SESSION_MAX_AGE_S, PersonSessionStore } from "@/members/person-sessions"
import { SendLimiter, SignInLinkStore, askSignInLink, personAccess, signInWithLink, type SignInDeps, type SignInSetup } from "@/members/signin"
import { loadDaemonConfig } from "./config"
import { workOf, type LinkFor, type PersonWork, type SentItem, type WorkItem } from "@/members/work"
import { agentIdsFor, agentsOf, type AgentCard } from "@/members/agents"
import { queueOf, type QueuedItem, type QueueView } from "@/members/queue"
import type { Person } from "@/people/people"
import {
  MEMBER_SERVICE_WORKER,
  renderMemberLockedPage,
  renderMemberManifest,
  renderMemberPage,
  renderMemberSignInPage,
  renderMemberWaitingPage,
} from "./ui/pages/member"
import { CLIENT_MANIFEST_PATH, renderClientManifest, renderClientPage } from "./ui/pages/client"

// --- A teammate's or a client's page: /member and /api/member/* (#385, #386, #453) ---
//
// Served like the phone app (app-routes.ts): no loopback exemption, since
// `tailscale serve` proxies from 127.0.0.1; only a machine's own key,
// carrying `member:<person>`, opens anything here, and it opens this
// person's own work and nothing else. An `app` key or a dashboard key is
// refused the same as no key. The manifests, icons and service worker stay
// public: they hold no data.
//
// The person's role picks the page (#453): a `member` gets "My work", a
// `client` gets "Your project" (client.ts), which shows no agent ids and
// no cards about the owner's agents, so /api/member/work sends a client
// no agent cards.
//
// A browser signed in by an email link (#1478, members/signin.ts) holds an
// ax_person session instead of a key; it opens the same page for the same
// person, once the owner has let that person in.

export const MEMBER_COOKIE = "agentx_member"
const COOKIE_MAX_AGE = 90 * 86400

export interface MemberRouteCtx {
  nodeName?: string
  tokens?: TokenStore
  members?: MemberStore
  pairCodes?: PairCodeStore
  pairLimiter?: PairAttemptLimiter
  pairMinMs?: number
  people: () => Person[]
  /** The install folder: decision cards live under it. */
  root: string
  db?: () => Database.Database | null
  linkFor?: LinkFor
  rejectLog?: RejectLog
  log?: (line: string) => void
  now?: () => number
  /** Signing in by email (#1478): null while it is not set up. */
  signInSetup?: () => SignInSetup | null
  sessions?: PersonSessionStore
  signInLinks?: SignInLinkStore
  signInPerAddress?: SendLimiter
  signInPerClient?: SendLimiter
  sendMail?: SignInDeps["send"]
}

const defaultPairLimiter = new PairAttemptLimiter()
const defaultPerAddress = new SendLimiter(5)
const defaultPerClient = new SendLimiter(20)
const asMember = (line: string) => line.replace(/^\[app\]/, "[member]")
const defaultRejectLog = new RejectLog((line) => console.log(asMember(line)))
/** One reject log per log sink, so its once-a-minute rule spans requests. */
const rejectLogs = new WeakMap<(line: string) => void, RejectLog>()
function rejectLogFor(ctx: MemberRouteCtx): RejectLog {
  if (ctx.rejectLog) return ctx.rejectLog
  if (!ctx.log) return defaultRejectLog
  let found = rejectLogs.get(ctx.log)
  if (!found) rejectLogs.set(ctx.log, (found = new RejectLog((line) => ctx.log!(asMember(line)))))
  return found
}

let lastRead: Person[] | null = null

/** The people list as agentx.json holds it now. The dashboard keeps the
 *  config it started with, and a person added since then must still pair;
 *  one removed since then must stop. While the file cannot be read (a
 *  half-saved edit), the last list that was read stands: falling back to
 *  the start-time list would end the keys of everyone added since. */
export function currentPeople(atStart: Person[], load: () => { people: Person[] } = loadDaemonConfig): Person[] {
  try { return (lastRead = load().people) } catch { return lastRead ?? atStart }
}

/** Handles the request and returns true if `path` belongs to the member page. */
export async function handleMemberRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  ctx: MemberRouteCtx,
): Promise<boolean> {
  if (path !== "/member" && !path.startsWith("/member/") && !path.startsWith("/api/member/")) return false
  const tokens = ctx.tokens ?? new TokenStore(ctx.root)
  const members = ctx.members ?? new MemberStore(ctx.root)
  const deps = {
    tokens, members, people: ctx.people, root: ctx.root,
    codes: ctx.pairCodes ?? new PairCodeStore(ctx.root),
    limiter: ctx.pairLimiter ?? defaultPairLimiter,
    minMs: ctx.pairMinMs, log: ctx.log, now: ctx.now,
  }

  if (method === "GET") {
    if (path === "/member/manifest.webmanifest") return send(res, 200, "application/manifest+json", renderMemberManifest())
    if (path === CLIENT_MANIFEST_PATH) return send(res, 200, "application/manifest+json", renderClientManifest())
    if (path === "/member/sw.js") {
      res.setHeader("Service-Worker-Allowed", "/member")
      return send(res, 200, "text/javascript; charset=utf-8", MEMBER_SERVICE_WORKER)
    }
    if (path === "/member/icon-192.png") return send(res, 200, "image/png", appIconPng(192), "public, max-age=86400")
    if (path === "/member/icon-512.png") return send(res, 200, "image/png", appIconPng(512), "public, max-age=86400")
  }

  if (method === "POST" && path === "/api/member/pair-code") {
    const result = await pairMemberMachine(req, deps)
    if (result.status === 200) res.setHeader("Set-Cookie", sessionCookie(result.token))
    if (result.status === 429) res.setHeader("Retry-After", String(result.retryAfter))
    return sendJson(res, result.status, result.body)
  }

  // Signing in with a link sent by email (#1478, members/signin.ts).
  const signIn: SignInDeps = {
    links: ctx.signInLinks ?? new SignInLinkStore(ctx.root), sessions: ctx.sessions ?? new PersonSessionStore(ctx.root),
    members, people: ctx.people, root: ctx.root, limiter: deps.limiter, setup: ctx.signInSetup ?? (() => null),
    perAddress: ctx.signInPerAddress ?? defaultPerAddress, perClient: ctx.signInPerClient ?? defaultPerClient,
    send: ctx.sendMail, minMs: ctx.pairMinMs, log: ctx.log, now: ctx.now,
  }
  if (method === "GET" && path === "/member/signin") return send(res, 200, "text/html; charset=utf-8", renderMemberSignInPage(!!signIn.setup()))
  if (method === "POST" && path === "/api/member/signin-link") {
    const result = await askSignInLink(req, signIn)
    return sendJson(res, result.status, result.body)
  }
  if (method === "POST" && path === "/api/member/signin") {
    const result = await signInWithLink(req, signIn)
    if (result.status === 200) res.setHeader("Set-Cookie", personCookie(result.value))
    if (result.status === 429) res.setHeader("Retry-After", String(result.retryAfter))
    return sendJson(res, result.status, result.body)
  }

  // Who this is: a paired machine's key, else a signed-in browser's session.
  const access = memberAccess(memberToken(req), deps, clientAddress(req))
  const signed = !access.ok && access.status === 401 ? personAccess(cookie(req, PERSON_COOKIE), signIn) : null
  if (signed && !signed.ok && signed.waiting) {
    if (path === "/member") return send(res, 202, "text/html; charset=utf-8", renderMemberWaitingPage(true))
    return sendJson(res, 403, { error: "waiting for the owner to let you in", waiting: true })
  }
  const who = access.ok
    ? { personId: access.personId, device: access.device.name, since: access.device.approvedAt ?? access.device.createdAt }
    : signed?.ok ? { personId: signed.person.id, device: signed.session.label, since: signed.session.approvedAt ?? signed.session.startedAt } : null
  if (!access.ok && !who) {
    if (access.status === 401) {
      const sent = bearer(req)
      rejectLogFor(ctx).record(
        path.slice(0, 120),
        rejectFields(req, credentialState(cookie(req, MEMBER_COOKIE), tokens), sent ? credentialState(sent, tokens) : null),
      )
      if (path === "/member") return send(res, 401, "text/html; charset=utf-8", renderMemberLockedPage(!!signIn.setup()))
      return sendJson(res, 401, { error: access.error, hint: "ask the owner to run: agentx people invite <you>" })
    }
    // Paired, waiting for the owner. 202 on the page: the service worker
    // keeps only a 200 as the saved shell, so an approved machine never
    // opens on a stale "waiting" page offline.
    if (path === "/member") return send(res, 202, "text/html; charset=utf-8", renderMemberWaitingPage())
    return sendJson(res, 403, { error: access.error, waiting: true })
  }
  if (!who) return sendJson(res, 401, { error: "not signed in" })

  const person = ctx.people().find((p) => p.id === who.personId)
  const client = person?.role === "client"
  if (method === "GET" && path === "/member") {
    const c = access.ok ? cookie(req, MEMBER_COOKIE) : null
    if (c && !bearer(req)) res.setHeader("Set-Cookie", sessionCookie(c))
    return send(res, 200, "text/html; charset=utf-8", client ? renderClientPage() : renderMemberPage())
  }
  if (method === "GET" && path === "/api/member/me") {
    return sendJson(res, 200, {
      person: who.personId, name: person?.name ?? who.personId, role: person?.role ?? "member",
      device: who.device, since: who.since,
      node: ctx.nodeName ?? null,
    })
  }
  if (method === "GET" && path === "/api/member/work") {
    const db = ctx.db?.() ?? null
    if (!db) return sendJson(res, 503, { error: "the work list needs the database" })
    const now = (ctx.now ?? Date.now)()
    const work = workOf(db, who.personId, { now, linkFor: ctx.linkFor })
    // No task_traces or queued_messages yet means nothing to read; anything else is logged.
    const quiet = (what: string, err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/no such table/i.test(msg)) ctx.log?.(`[member] ${what} failed: ${msg}`)
    }
    // The messages waiting behind each of this person's agents, and their own among them (#443).
    let queue: { byAgent: Map<string, QueueView>; mine: QueuedItem[] } = { byAgent: new Map(), mine: [] }
    try { queue = queueOf(db, who.personId, { linkFor: ctx.linkFor }) } catch (err) { quiet("the line", err) }
    // The agents this person uses, and what each is doing (#443). Not for
    // a client: their page names no agent, so their data carries none (#453).
    let agents: AgentCard[] = []
    if (client) return sendJson(res, 200, { ...withoutAgents(work), agents })
    try {
      const ids = agentIdsFor(db, person ?? { id: who.personId }, now)
      agents = agentsOf(db, who.personId, ids, { people: ctx.people(), linkFor: ctx.linkFor, queue: queue.byAgent })
    } catch (err) { quiet("agent cards", err) }
    return sendJson(res, 200, { ...work, agents, queued: queue.mine })
  }
  return sendJson(res, 404, { error: "not found" })
}

/** A client's work with the agent ids taken out of every row (#453). */
export function withoutAgents(work: PersonWork): Omit<PersonWork, "open" | "recent" | "runs" | "other"> & {
  open: Omit<WorkItem, "agentId">[]
  recent: Omit<WorkItem, "agentId">[]
  runs: Omit<SentItem, "agentId">[]
  other: Omit<WorkItem, "agentId">[]
} {
  const strip = <T extends { agentId: string }>(rows: T[]): Omit<T, "agentId">[] => rows.map(({ agentId: _agentId, ...rest }) => rest)
  return { ...work, open: strip(work.open), recent: strip(work.recent), runs: strip(work.runs), other: strip(work.other) }
}

export function sessionCookie(token: string): string {
  return `${MEMBER_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
}

/** The ax_person cookie a sign-in by email sets (#1478). */
export function personCookie(value: string): string {
  return `${PERSON_COOKIE}=${value}; Path=/; Max-Age=${PERSON_SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`
}

function memberToken(req: IncomingMessage): string | null {
  return bearer(req) ?? cookie(req, MEMBER_COOKIE)
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization || ""
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() || null : null
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null
  }
  return null
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache = "no-store"): true {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": cache })
  res.end(body)
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  return send(res, status, "application/json", JSON.stringify(body))
}
