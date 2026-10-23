import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { NativeNotes } from "./types"

// --- Ideas to the owner's notes app: POST /native/notes (#1062 step 9) ---
//
// An agent with an idea for the owner writes it as a note (Apple Notes on
// a Mac) through the agentx_note tool, instead of a message. Write-only:
// reading notes back is a separate question (#850). Off by default.
//
//   409  native.notes.enabled is off on this node
//   403  the caller is not an agent's running turn (or a peer naming one)
//   400  title or body missing or too long
//   429  this agent already wrote perAgentPerDay notes today
//   201  written here, or on the peer native.forwardTo names
//   501  no notes app here and nowhere to forward
//
// A node without a notes app (a Linux server) forwards to the owner's
// machine over the mesh; that node applies its own switch and limit too.

export const NOTE_LIMITS = { title: 120, body: 4000 } as const

export interface NoteSettings {
  enabled: boolean
  folder: string
  perAgentPerDay: number
}

export interface NoteReply {
  status: number
  body: Record<string, unknown>
}

export interface NoteDeps {
  root: string
  settings: NoteSettings
  /** This node's notes app; undefined when it has none. */
  notes?: NativeNotes
  /** Sends the note to the owner's machine; undefined when no peer is set. */
  forward?: (payload: { title: string; body: string; agentId: string; node: string }) => Promise<NoteReply>
  /** The agent the call proves, or null. */
  agentId: string | null
  /** Where the agent runs, for the signature: this node, or the peer that forwarded it. */
  node: string
  now?: number
}

/** Who a note is from. A peer is believed only when the call's token is
 *  that peer's own token (not this node's MESH_TOKEN, which local agents
 *  hold) and the agent it names is not one of this node's; otherwise the
 *  agent is the one the running turn proves. */
export function noteCaller(c: {
  node: string
  selfNode: string
  /** The peer whose own token the call carries, or null. */
  tokenPeer: string | null
  claimed?: string
  isLocalAgent: (id: string) => boolean
  /** The agent the call's running turn proves, or null. */
  proven: () => string | null
}): { agentId: string | null; node: string } | { error: string } {
  const fromPeer = !!c.node && c.node !== c.selfNode && c.tokenPeer === c.node
  if (!fromPeer) return { agentId: c.proven(), node: "" }
  if (c.claimed && c.isLocalAgent(c.claimed)) return { error: `"${c.claimed}" is an agent on this node; a peer may only write for its own agents` }
  return { agentId: c.claimed || null, node: c.node }
}

/** Notes being written now, per agent: counted against the limit, so two
 *  at once cannot both pass it. */
const inFlight = new Map<string, number>()

function countsPath(root: string): string {
  return resolve(root, ".agentx", "native-notes.json")
}

/** Notes written per agent on one local day: { date, counts }. */
function readCounts(root: string, date: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(countsPath(root), "utf-8"))
    return parsed?.date === date && parsed.counts && typeof parsed.counts === "object" ? parsed.counts : {}
  } catch {
    return {}
  }
}

function writeCounts(root: string, date: string, counts: Record<string, number>): void {
  const path = countsPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ date, counts }, null, 2) + "\n")
  renameSync(tmp, path)
}

function localDate(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export async function handleNoteRequest(input: Record<string, unknown> | undefined, deps: NoteDeps): Promise<NoteReply> {
  const { settings, root } = deps
  const now = deps.now ?? Date.now()
  if (!settings.enabled) return { status: 409, body: { error: "notes are off on this node (native.notes.enabled is false)" } }
  if (!deps.agentId) return { status: 403, body: { error: "only an agent's running turn can add a note" } }
  const title = typeof input?.title === "string" ? input.title.replace(/\s+/g, " ").trim() : ""
  const body = typeof input?.body === "string" ? input.body.trim() : ""
  if (!title || title.length > NOTE_LIMITS.title) return { status: 400, body: { error: `title is required, at most ${NOTE_LIMITS.title} characters` } }
  if (!body || body.length > NOTE_LIMITS.body) return { status: 400, body: { error: `body is required, at most ${NOTE_LIMITS.body} characters` } }

  const date = localDate(now)
  const counts = readCounts(root, date)
  const key = deps.node ? `${deps.agentId}@${deps.node}` : deps.agentId
  if ((counts[key] ?? 0) + (inFlight.get(key) ?? 0) >= settings.perAgentPerDay) {
    return { status: 429, body: { error: `${deps.agentId} already added ${settings.perAgentPerDay} notes today; the limit is native.notes.perAgentPerDay` } }
  }
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
  try {
    const reply = await write(title, body, deps, now)
    if (reply.status === 201) {
      const fresh = readCounts(root, date)
      fresh[key] = (fresh[key] ?? 0) + 1
      writeCounts(root, date, fresh)
    }
    return reply
  } finally {
    const n = (inFlight.get(key) ?? 1) - 1
    if (n > 0) inFlight.set(key, n)
    else inFlight.delete(key)
  }
}

async function write(title: string, body: string, deps: NoteDeps, now: number): Promise<NoteReply> {
  const { settings } = deps
  let reply: NoteReply
  if (deps.notes) {
    const signed = `${body}\n\n— ${deps.agentId}${deps.node ? ` on ${deps.node}` : ""}, ${new Date(now).toISOString()}`
    try {
      const { id } = await deps.notes.add({ folder: settings.folder, title, body: signed })
      reply = { status: 201, body: { ok: true, id, folder: settings.folder } }
    } catch (e: any) {
      return { status: 502, body: { error: `could not add the note: ${e?.message ?? e}` } }
    }
  } else if (deps.forward) {
    reply = await deps.forward({ title, body, agentId: deps.agentId!, node: deps.node })
  } else {
    return { status: 501, body: { error: "this machine has no notes app, and native.forwardTo (or approvals.forwardTo) names no peer to send it to" } }
  }
  return reply
}
