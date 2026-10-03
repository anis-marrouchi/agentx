import type { IncomingMessage, ServerResponse } from "http"
import type Database from "better-sqlite3"
import { TokenStore } from "./token-store"
import { PairCodeStore } from "./pair-codes"
import { PairAttemptLimiter } from "./app-pair-code"
import { RejectLog, credentialState, rejectFields } from "./app-auth-log"
import { appIconPng } from "./app-icon"
import { MemberStore } from "@/members/store"
import { clientAddress, memberAccess, pairMemberMachine } from "@/members/pairing"
import { loadDaemonConfig } from "./config"
import { workOf, type LinkFor } from "@/members/work"
import { agentIdsFor, agentsOf, type AgentCard } from "@/members/agents"
import type { Person } from "@/people/people"
import {
  MEMBER_SERVICE_WORKER,
  renderMemberLockedPage,
  renderMemberManifest,
  renderMemberPage,
  renderMemberWaitingPage,
} from "./ui/pages/member"

// --- A teammate's page: /member and /api/member/* (#385, #386) ---
//
// Served like the phone app (app-routes.ts): no loopback exemption, since
// `tailscale serve` proxies from 127.0.0.1; only a machine's own key,
// carrying `member:<person>`, opens anything here, and it opens this
// person's own work and nothing else. An `app` key or a dashboard key is
// refused the same as no key. The manifest, icons and service worker stay
// public: they hold no data.

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
}

const defaultPairLimiter = new PairAttemptLimiter()
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

  const access = memberAccess(memberToken(req), deps, clientAddress(req))
  if (!access.ok) {
    if (access.status === 401) {
      const sent = bearer(req)
      rejectLogFor(ctx).record(
        path.slice(0, 120),
        rejectFields(req, credentialState(cookie(req, MEMBER_COOKIE), tokens), sent ? credentialState(sent, tokens) : null),
      )
      if (path === "/member") return send(res, 401, "text/html; charset=utf-8", renderMemberLockedPage())
      return sendJson(res, 401, { error: access.error, hint: "ask the owner to run: agentx people invite <you>" })
    }
    // Paired, waiting for the owner. 202 on the page: the service worker
    // keeps only a 200 as the saved shell, so an approved machine never
    // opens on a stale "waiting" page offline.
    if (path === "/member") return send(res, 202, "text/html; charset=utf-8", renderMemberWaitingPage())
    return sendJson(res, 403, { error: access.error, waiting: true })
  }

  const person = ctx.people().find((p) => p.id === access.personId)
  if (method === "GET" && path === "/member") {
    const c = cookie(req, MEMBER_COOKIE)
    if (c && !bearer(req)) res.setHeader("Set-Cookie", sessionCookie(c))
    return send(res, 200, "text/html; charset=utf-8", renderMemberPage())
  }
  if (method === "GET" && path === "/api/member/me") {
    return sendJson(res, 200, {
      person: access.personId, name: person?.name ?? access.personId,
      device: access.device.name, since: access.device.approvedAt ?? access.device.createdAt,
      node: ctx.nodeName ?? null,
    })
  }
  if (method === "GET" && path === "/api/member/work") {
    const db = ctx.db?.() ?? null
    if (!db) return sendJson(res, 503, { error: "the work list needs the database" })
    const now = (ctx.now ?? Date.now)()
    const work = workOf(db, access.personId, { now, linkFor: ctx.linkFor })
    // The agents this person uses, and what each is doing (#443).
    let agents: AgentCard[] = []
    try {
      const ids = agentIdsFor(db, person ?? { id: access.personId }, now)
      agents = agentsOf(db, access.personId, ids, { people: ctx.people(), linkFor: ctx.linkFor })
    } catch (err) {
      // No task_traces yet means no runs to read; anything else is logged.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/no such table/i.test(msg)) ctx.log?.(`[member] agent cards failed: ${msg}`)
    }
    return sendJson(res, 200, { ...work, agents })
  }
  return sendJson(res, 404, { error: "not found" })
}

export function sessionCookie(token: string): string {
  return `${MEMBER_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
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
