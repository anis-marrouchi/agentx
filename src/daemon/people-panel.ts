import type { IncomingMessage, ServerResponse } from "http"
import type Database from "better-sqlite3"
import { TokenStore } from "./token-store"
import { MemberStore, type MemberDevice } from "@/members/store"
import { pendingAnswer, removeDevice } from "@/members/pairing"
import { requestsOf, runsOf, type PersonRequest, type PersonRun } from "@/people/activity"
import { IMPLICIT_OWNER, type Person } from "@/people/people"
import { renderPeoplePage } from "./ui/pages/people"
import type { TopbarPeer } from "./topbar"

// --- Dashboard side of the People page (#441) ---
//
// The owner's view of what `agentx people list`, `devices` and `show`
// print: every person, the machines each has paired, what each asked the
// agents for, and a way to end one machine. Runs in the dashboard process,
// behind the same checks as every /api/admin route: the dashboard token
// when one is configured, and X-Requested-With from a same-origin page on a
// write.
//
//   GET  /people                                          the page
//   GET  /api/admin/people                                everyone, with machine counts
//   GET  /api/admin/people/<id>                           one person: machines, requests, runs
//   POST /api/admin/people/<id>/devices/<tokenId>/end     end one machine at once
//
// A teammate's `tailscale serve` paths forward /member and /api/member
// only, and those belong to member-routes.ts, so none of this is under
// them. The address is also matched as it was sent, before dot segments are
// folded: "/member/../people" never opens this page.

export const PEOPLE_API = "/api/admin/people"

export interface PeoplePanelDeps {
  /** The people list as agentx.json holds it now. */
  people: () => Person[]
  members: MemberStore
  tokens?: TokenStore
  /** The install folder: pairing cards live under it. */
  root: string
  db: () => Database.Database | null
  peers?: TopbarPeer[]
  localToken?: string
  now?: () => number
}

export interface PersonRow extends Pick<Person, "id" | "name" | "role" | "identities"> {
  agents: string[]
  /** This machine's owner on an install that lists no owner. */
  builtIn?: true
  machines: { active: number; pending: number }
}

/** A machine as the page shows it. `answer` is what the owner said on the
 *  card of a machine that has not called since: its record still says
 *  "pending" until it does. */
export interface ShownDevice extends MemberDevice {
  answer?: "yes" | "no"
}

function shown(root: string, d: MemberDevice): ShownDevice {
  const answer = pendingAnswer(root, d)
  return answer ? { ...d, answer } : d
}

/** Where a machine stands for the owner: approved counts as working, refused as gone. */
function standing(d: ShownDevice): MemberDevice["state"] {
  return d.state !== "pending" || !d.answer ? d.state : d.answer === "yes" ? "active" : "removed"
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

/** The list the page shows: everyone in `people`, and the built-in owner
 *  first when no owner is listed, so an install with no `people` still
 *  shows who the work on this machine is recorded under. */
export function peopleRows(people: Person[], devices: ShownDevice[]): PersonRow[] {
  const count = (id: string, state: MemberDevice["state"]) => devices.filter((d) => d.personId === id && standing(d) === state).length
  const row = (p: Pick<Person, "id" | "name" | "role" | "identities" | "agents">): PersonRow => ({
    id: p.id, name: p.name, role: p.role, identities: p.identities, agents: p.agents ?? [],
    machines: { active: count(p.id, "active"), pending: count(p.id, "pending") },
  })
  const rows = people.map(row)
  if (!people.some((p) => p.role === "owner")) {
    rows.unshift({ ...row({ id: IMPLICIT_OWNER, name: "Owner of this machine", role: "owner", identities: [] }), builtIn: true })
  }
  return rows
}

/** Newest pairing first. */
const byNewest = (a: MemberDevice, b: MemberDevice) => b.createdAt.localeCompare(a.createdAt)

/** Returns false when the path isn't one of ours. */
export async function handlePeoplePanel(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PeoplePanelDeps,
): Promise<boolean> {
  if (path !== "/people" && path !== PEOPLE_API && !path.startsWith(`${PEOPLE_API}/`)) return false
  const method = (req.method || "GET").toUpperCase()
  // `path` has dot segments folded; a proxy mounted on another path forwards
  // the address as it was typed. Only the address itself opens this.
  if ((req.url || "").split(/[?#]/)[0] !== path) { sendJson(res, 404, { error: "not found" }); return true }

  if (path === "/people") {
    if (method !== "GET") { sendJson(res, 405, { error: "GET only" }); return true }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(renderPeoplePage({ peers: deps.peers, localToken: deps.localToken }))
    return true
  }

  if (method !== "GET" && req.headers["x-requested-with"] !== "agentx-board") {
    sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
    return true
  }

  const devicesOf = (personId?: string) => deps.members.devices(personId).map((d) => shown(deps.root, d))
  const rows = () => peopleRows(deps.people(), devicesOf())

  if (method === "GET" && path === PEOPLE_API) {
    const people = rows()
    sendJson(res, 200, { people, paired: people.reduce((n, p) => n + p.machines.active + p.machines.pending, 0) })
    return true
  }

  const one = path.match(/^\/api\/admin\/people\/([a-z0-9][a-z0-9_-]{0,39})$/)
  if (method === "GET" && one) {
    const person = rows().find((p) => p.id === one[1])
    if (!person) { sendJson(res, 404, { error: `no person "${one[1]}"` }); return true }
    const db = deps.db()
    let requests: PersonRequest[] = []
    let runs: PersonRun[] = []
    // A table that is not there yet reads as nothing asked, like `agentx people show`.
    try { if (db) requests = requestsOf(db, person.id) } catch { /* requests never turned on */ }
    try { if (db) runs = runsOf(db, person.id, 20) } catch { /* no runs recorded yet */ }
    sendJson(res, 200, { person, devices: devicesOf(person.id).sort(byNewest), requests, runs, database: !!db })
    return true
  }

  const end = path.match(/^\/api\/admin\/people\/([a-z0-9][a-z0-9_-]{0,39})\/devices\/([A-Za-z0-9_-]{1,80})\/end$/)
  if (method === "POST" && end) {
    const [, personId, tokenId] = end
    const device = deps.members.byToken(tokenId)
    if (!device || device.personId !== personId) { sendJson(res, 404, { error: "no such machine for this person" }); return true }
    if (device.state === "removed") { sendJson(res, 409, { error: "this machine's access has already ended" }); return true }
    const removed = removeDevice({ tokens: deps.tokens ?? new TokenStore(), members: deps.members, now: deps.now }, tokenId, "removed by the owner (dashboard)")
    sendJson(res, 200, { ok: true, device: removed })
    return true
  }

  sendJson(res, 404, { error: "not found" })
  return true
}
