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
  if ((counts[key] ?? 0) >= settings.perAgentPerDay) {
    return { status: 429, body: { error: `${deps.agentId} already added ${settings.perAgentPerDay} notes today; the limit is native.notes.perAgentPerDay` } }
  }

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
    reply = await deps.forward({ title, body, agentId: deps.agentId, node: deps.node })
    if (reply.status !== 201) return reply
  } else {
    return { status: 501, body: { error: "this machine has no notes app, and native.forwardTo (or approvals.forwardTo) names no peer to send it to" } }
  }
  counts[key] = (counts[key] ?? 0) + 1
  writeCounts(root, date, counts)
  return reply
}
