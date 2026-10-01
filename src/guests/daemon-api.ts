import type { GuestStore, GuestGrant } from "./store"
import {
  endGrant, grantForGuest, guestAccess, guestTask, joinGuest, pauseGrant, resumeGrant, settleGrant, updateGrant, type GuestDeps,
} from "./grants"

// --- The daemon's guest-mesh endpoints (#380) ---
//
// Guest side, opened by the guest's key alone (never the mesh token, and
// loopback is not trusted here):
//   POST /mesh/guest/join    {code, node:{id,name}}: trade the code for the key
//   GET  /mesh/guest/me      the grant as the guest may see it
//   POST /mesh/guest/task    {message}: a turn of the host agent inside the grant
// Host side, the operator's panel (loopback or the mesh token, like the
// other control routes):
//   GET  /mesh/guests            every grant, with its trail
//   GET  /mesh/guests/:id        one grant and its trail
//   POST /mesh/guests/:id/pause | resume | end | update
export const GUEST_PATHS = /^\/mesh\/guest\//
export const GUESTS_PATHS = /^\/mesh\/guests(\/|$)/

export interface GuestApiDeps extends GuestDeps {
  /** Runs the guest's message as a turn of the host agent. */
  run: (task: ReturnType<typeof guestTask>) => Promise<{ content: string; error?: string; tokensUsed?: number }>
  /** Stops the grant's running turns (pause, end). */
  cancel?: (grant: GuestGrant) => number
}

export interface ApiReply { status: number; body: unknown; token?: string }

export async function handleGuestApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  req: { token: string | null; address: string },
  deps: GuestApiDeps,
): Promise<ApiReply> {
  const m = method.toUpperCase()
  const log = deps.log ?? ((line: string) => console.log(line))

  if (path === "/mesh/guest/join" && m === "POST") {
    const r = await joinGuest(body ?? {}, req.address, deps)
    return r.status === 200 ? { status: 200, body: r.body, token: r.token } : { status: r.status, body: r.body }
  }
  if (GUEST_PATHS.test(path)) {
    const access = guestAccess(req.token, deps)
    if (!access.ok) return { status: access.status, body: { error: access.error, ...("waiting" in access && access.waiting ? { waiting: true } : {}), ...("paused" in access && access.paused ? { paused: true } : {}) } }
    const { grant } = access
    if (path === "/mesh/guest/me" && m === "GET") return { status: 200, body: grantForGuest(grant) }
    if (path === "/mesh/guest/task" && m === "POST") {
      const message = typeof body?.message === "string" ? body.message.trim() : ""
      if (!message) return { status: 400, body: { error: "message is required" } }
      if (message.length > 20_000) return { status: 413, body: { error: "message is longer than 20000 characters" } }
      deps.guests.log({ grant: grant.id, event: "task", address: req.address, detail: message.slice(0, 120) })
      log(`[guests] ${grant.id}: ${grant.guest} asked ${grant.agentId} (${grant.level}): ${message.slice(0, 80).replace(/\s+/g, " ")}`)
      const r = await deps.run(guestTask(grant, message))
      deps.guests.used(grant.id, r.tokensUsed ?? 0)
      return r.error
        ? { status: 502, body: { error: r.error, grant: grant.id } }
        : { status: 200, body: { content: r.content, grant: grant.id, agentId: grant.agentId } }
    }
    return { status: 404, body: { error: "Not found" } }
  }

  if (path === "/mesh/guests" && m === "GET") {
    const grants = deps.guests.grants().map((g) => settleGrant(deps, g)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { status: 200, body: { grants: grants.map((g) => withTrail(deps.guests, g, 5)) } }
  }
  const one = path.match(/^\/mesh\/guests\/([^/]+)(?:\/(pause|resume|end|update))?$/)
  if (one) {
    const id = decodeURIComponent(one[1])
    const action = one[2]
    const found = deps.guests.get(id)
    if (!found) return { status: 404, body: { error: `no grant "${id}"` } }
    const grant = settleGrant(deps, found)
    if (!action && m === "GET") return { status: 200, body: { grant: withTrail(deps.guests, grant, 50) } }
    if (!action || m !== "POST") return { status: 405, body: { error: "Method not allowed" } }
    if (action === "pause") {
      const out = pauseGrant(deps, id)
      if (!out) return { status: 409, body: { error: `grant "${id}" is ${grant.state}, not active` } }
      const stopped = deps.cancel?.(out) ?? 0
      log(`[guests] ${id}: paused by the operator; ${stopped} running turn(s) stopped`)
      return { status: 200, body: { grant: out, stopped } }
    }
    if (action === "resume") {
      const out = resumeGrant(deps, id)
      if (!out) return { status: 409, body: { error: `grant "${id}" is ${grant.state}, not paused` } }
      return { status: 200, body: { grant: out } }
    }
    if (action === "end") {
      const out = endGrant(deps, id)
      if (!out) return { status: 409, body: { error: `grant "${id}" is already ended` } }
      const stopped = deps.cancel?.(out) ?? 0
      log(`[guests] ${id}: ended by the operator; ${stopped} running turn(s) stopped`)
      return { status: 200, body: { grant: out, stopped } }
    }
    const r = updateGrant(deps, id, body ?? {})
    return r.ok ? { status: 200, body: { grant: r.grant } } : { status: 400, body: { error: r.error } }
  }
  return { status: 404, body: { error: "Not found" } }
}

function withTrail(store: GuestStore, grant: GuestGrant, n: number): GuestGrant & { trail: ReturnType<GuestStore["events"]> } {
  return { ...grant, trail: store.events(grant.id, n) }
}
