import type { OverrideAction, SituationRow, SituationStore } from "./store"

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
  }
}

export function situationsList(store: SituationStore, q: URLSearchParams, mode: string): Reply {
  const agent = q.get("agent")?.trim() || undefined
  const phase = q.get("phase")?.trim() || undefined
  if (phase && !PHASES.has(phase)) return { status: 400, body: { error: "phase must be during, ending or ended" } }
  const limit = Math.max(1, Math.min(Number(q.get("limit")) || 50, 200))
  // Filter by phase after the read: at most 500 rows, newest first.
  const rows = store.list({ agent, limit: phase ? 500 : limit }).filter((r) => !phase || r.phase === phase).slice(0, limit)
  return { status: 200, body: { mode, rows: rows.map(situationView) } }
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
