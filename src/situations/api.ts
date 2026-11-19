import type { ClosingSlots, OverrideAction, Phase, SituationRow, SituationStore } from "./store"
import { SITUATION_CHANNELS, situationKey } from "./key"

// --- The daemon's situation routes (#1892, phase 2) ---
//
//   GET  /situations?agent=&phase=&limit=   the chats' records, newest first
//   POST /situations/override {id, action, by?}
//        action: end | not-this | clear; id: a record id, a unique id
//        prefix, or the record key
//
// Authorised like other owner actions: GET is mesh-gated (isMeshGatedPath),
// POST is in MESH_PROTECTED_PATHS, so only this machine (the CLI, the
// same-host dashboard proxy, which checks the owner) or a mesh token may
// call them. No chat message can override a situation.

export interface Reply { status: number; body: unknown }

const ACTIONS: ReadonlySet<string> = new Set(["end", "not-this", "clear"])
const PHASES: ReadonlySet<string> = new Set(["during", "ending", "ended"])

/** A row as the routes return it: the key split into its parts. */
export function situationView(r: SituationRow) {
  const [channel, account, ...chat] = r.key.split("|")
  return {
    id: r.id, key: r.key, channel, account, chatId: chat.join("|"), template: r.template, phase: r.phase,
    endReason: r.endReason, endGeneration: r.endGeneration, enteredAt: r.enteredAt, phaseChangedAt: r.phaseChangedAt,
    setBy: r.setBy, why: r.why, ownerAgent: r.ownerAgent, override: r.override,
    closing: r.closing, expiryRunId: r.expiryRunId, closeRunId: r.closeRunId, closeGeneration: r.closeGeneration,
  }
}

export function situationsList(store: SituationStore, q: URLSearchParams, mode: string): Reply {
  const agent = q.get("agent")?.trim() || undefined
  const phase = q.get("phase")?.trim() || undefined
  if (phase && !PHASES.has(phase)) return { status: 400, body: { error: "phase must be during, ending or ended" } }
  const limit = Math.max(1, Math.min(Number(q.get("limit")) || 50, 200))
  const rows = store.list({ agent, phase: phase as Phase | undefined, limit })
  return { status: 200, body: { mode, rows: rows.map(situationView) } }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "")

/** POST /situations/closing (phase 4): give a talk closing steps, or
 *  remove them (`clear: true`).
 *    {id | channel+chatId[+account], purpose, home, agent?, message?,
 *     template?}
 *  A talk with no record yet (set up before its first message) gets one,
 *  in `during`. Like the override: only this machine or a mesh token,
 *  never a chat message. */
export function situationsClosing(store: SituationStore, body: Record<string, unknown>): Reply {
  const ref = str(body.id, 300)
  const channel = str(body.channel, 40)
  const rawChat = str(body.chatId, 300)
  let row = ref ? store.resolve(ref) : null
  if (!row && !ref && channel && rawChat) {
    if (!SITUATION_CHANNELS.has(channel)) return { status: 400, body: { error: "channel must be telegram, whatsapp, discord or slack" } }
    const key = situationKey(channel, str(body.account, 200) || undefined, rawChat)
    store.create(key, "during", "closing steps set by a person")
    row = store.get(key)
  }
  if (!row) return { status: ref ? 404 : 400, body: { error: ref ? `no situation ${ref.slice(0, 80)}` : "Required: id, or channel and chatId" } }
  if (body.clear === true) {
    const after = store.setClosing(row.id, null)
    return { status: 200, body: { ok: true, row: after ? situationView(after) : null } }
  }
  const purpose = str(body.purpose, 200)
  const home = str(body.home, 500)
  if (!purpose || !home) return { status: 400, body: { error: "Required: purpose (what the talk is) and home (where its note goes)" } }
  const message = str(body.message, 2000)
  const keyChannel = row.key.split("|")[0]
  // The key holds a normalised WhatsApp id, which the channel cannot send to.
  if (message && keyChannel === "whatsapp" && !rawChat.includes("@")) {
    return { status: 400, body: { error: "a closing message on WhatsApp needs chatId as WhatsApp names it (ending in @g.us or @s.whatsapp.net)" } }
  }
  const agent = str(body.agent, 100)
  const closing: ClosingSlots = {
    purpose, home,
    ...(agent ? { agent } : {}),
    ...(message ? { message } : {}),
    ...(message && rawChat ? { chatId: rawChat } : {}),
  }
  const template = str(body.template, 40) || "meeting"
  const after = store.setClosing(row.id, closing, template)
  return { status: 200, body: { ok: true, row: after ? situationView(after) : null } }
}

export function situationsOverride(store: SituationStore, body: Record<string, unknown>): Reply {
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const action = String(body.action ?? "")
  if (!id) return { status: 400, body: { error: "Required: id (a situation id, id prefix or key)" } }
  if (!ACTIONS.has(action)) return { status: 400, body: { error: "action must be end, not-this or clear" } }
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "a person"
  const r = store.override(id, action as OverrideAction, by)
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  return { status: 200, body: { ok: true, action, row: r.row ? situationView(r.row) : null } }
}
