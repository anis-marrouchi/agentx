import type { ClosingSlots, OverrideAction, Phase, SituationRow, SituationStore } from "./store"
import { SITUATION_CHANNELS, situationKey } from "./key"
import { noteTargetOf } from "./closing-actions"
import { agentTemplateIds, oneLine, situationTemplate, templateIds } from "./templates"

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
    importance: r.importance, importanceWhy: r.importanceWhy,
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
 *  never a chat message.
 *  Refused (409) while closing steps are off: they would never run. The
 *  home must be a GitHub or GitLab (this node's) issue, pull or merge
 *  request: the note is posted there as one comment. `agent` and each of
 *  `agents` (who else may own a follow-up) must be agents of this node. */
export interface ClosingApiContext {
  closingEnabled: boolean
  /** situations.templates.enabled (phase 6): the template must be one of
   *  the catalog. Off: any name is kept as a label, as before. */
  templatesEnabled?: boolean
  isAgent: (id: string) => boolean
  gitlabUrl: string | null
}

export function situationsClosing(store: SituationStore, body: Record<string, unknown>, ctx: ClosingApiContext): Reply {
  if (!ctx.closingEnabled && body.clear !== true) {
    return { status: 409, body: { error: "closing steps are off on this node: set situations.closing.enabled to true (and situations.mode not off), then try again" } }
  }
  const clear = body.clear === true
  const purpose = str(body.purpose, 200)
  const home = str(body.home, 500)
  const message = str(body.message, 2000)
  const agentList: unknown[] = Array.isArray(body.agents) ? body.agents : typeof body.agents === "string" ? body.agents.split(",") : []
  const agents = [...new Set(agentList.map((a) => str(a, 100)).filter(Boolean))].slice(0, 20)
  // Checked before a record is made for a new talk.
  if (!clear) {
    if (!purpose || !home) return { status: 400, body: { error: "Required: purpose (what the talk is) and home (where its note goes)" } }
    if (!noteTargetOf(home, ctx.gitlabUrl)) {
      return { status: 400, body: { error: "home must be a GitHub or GitLab issue, pull request or merge request link (the note is posted there)" } }
    }
    const unknown = [str(body.agent, 100), ...agents].filter((a) => a && !ctx.isAgent(a))
    if (unknown.length) return { status: 400, body: { error: `not an agent of this node: ${unknown.join(", ")}` } }
    const named = str(body.template, 40)
    if (ctx.templatesEnabled && named && !situationTemplate(named)) {
      return { status: 400, body: { error: `unknown template ${named}; one of: ${templateIds()}` } }
    }
  }
  const ref = str(body.id, 300)
  const channel = str(body.channel, 40)
  const rawChat = str(body.chatId, 300)
  let row = ref ? store.resolve(ref) : null
  if (!row && !ref && channel && rawChat && !clear) {
    if (!SITUATION_CHANNELS.has(channel)) return { status: 400, body: { error: "channel must be telegram, whatsapp, discord or slack" } }
    if (message && channel === "whatsapp" && !rawChat.includes("@")) {
      return { status: 400, body: { error: "a closing message on WhatsApp needs chatId as WhatsApp names it (ending in @g.us or @s.whatsapp.net)" } }
    }
    const key = situationKey(channel, str(body.account, 200) || undefined, rawChat)
    store.create(key, "during", "closing steps set by a person")
    row = store.get(key)
  }
  if (!row) return { status: ref ? 404 : 400, body: { error: ref ? `no situation ${ref.slice(0, 80)}` : "Required: id, or channel and chatId" } }
  if (clear) {
    const after = store.setClosing(row.id, null)
    return { status: 200, body: { ok: true, row: after ? situationView(after) : null } }
  }
  const keyChannel = row.key.split("|")[0]
  // The key holds a normalised WhatsApp id, which the channel cannot send to.
  if (message && keyChannel === "whatsapp" && !rawChat.includes("@")) {
    return { status: 400, body: { error: "a closing message on WhatsApp needs chatId as WhatsApp names it (ending in @g.us or @s.whatsapp.net)" } }
  }
  const agent = str(body.agent, 100)
  const closing: ClosingSlots = {
    purpose, home,
    ...(agent ? { agent } : {}),
    ...(agents.length ? { agents } : {}),
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

// --- Phase 6: the chat's own agent names its talk ---

/** POST /situations/fill: the chat's agent, in its running turn, names
 *  the talk's template and purpose, and may draft a closing message to
 *  the other side. The chat is the turn's own, proven by the daemon from
 *  the caller's task or chat headers; anything the body says about a chat
 *  is ignored. The agent may not:
 *    - pick a note home (the note goes to the owner's message only), name
 *      another writer, or widen who may own a follow-up;
 *    - change what a person set (409);
 *    - fill a talk that has ended, another agent's chat, or a chat with
 *      no record.
 *  Its text is made one line and capped: the owner reads it on a card. */
export interface FillApiContext {
  templatesEnabled: boolean
  agentFill: boolean
  closingEnabled: boolean
  /** The caller's running turn: its agent, the chat's situation key and
   *  the chat id as the channel names it. Null: no running turn proven. */
  turn: { agentId: string; key?: string; chatId?: string } | null
}

export const FILL_PURPOSE_MAX = 200
export const FILL_MESSAGE_MAX = 1000

export function situationsFill(store: SituationStore, body: Record<string, unknown>, ctx: FillApiContext): Reply {
  if (!ctx.templatesEnabled || !ctx.agentFill) {
    return { status: 409, body: { error: "an agent may not name its talk on this node: situations.templates.enabled and situations.templates.agentFill are off" } }
  }
  if (!ctx.turn) return { status: 403, body: { error: "only an agent in its running turn may name its talk (no running turn proven)" } }
  const { agentId, key } = ctx.turn
  if (!key) return { status: 400, body: { error: "this turn's chat has no situation (telegram, whatsapp, discord or slack only)" } }
  const template = situationTemplate(str(body.template, 40))
  if (!template || !template.agentMay) {
    return { status: 400, body: { error: `template must be one of: ${agentTemplateIds()}` } }
  }
  const purpose = oneLine(body.purpose, FILL_PURPOSE_MAX)
  if (!purpose) return { status: 400, body: { error: "Required: purpose (what the talk is, in a few words)" } }
  const message = oneLine(body.message, FILL_MESSAGE_MAX)
  const row = store.get(key)
  if (!row) return { status: 404, body: { error: "this chat has no talk yet" } }
  if (row.ownerAgent && row.ownerAgent !== agentId) return { status: 403, body: { error: "this chat's talk belongs to another agent" } }
  if (row.phase === "ended") return { status: 409, body: { error: "this talk has ended" } }
  if (row.closing && row.closing.setBy !== "agent") {
    return { status: 409, body: { error: "a person set this talk's closing steps; they are kept as they are" } }
  }
  if (!row.ownerAgent) store.claimOwner(key, agentId)
  const rawChat = str(ctx.turn.chatId, 300)
  // The key holds a normalised WhatsApp id the channel cannot send to.
  const canSend = !!rawChat && (key.split("|")[0] !== "whatsapp" || rawChat.includes("@"))
  const closing: ClosingSlots | null = ctx.closingEnabled && template.closing ? {
    purpose, home: "", agent: agentId, setBy: "agent",
    ...(message && canSend ? { message, chatId: rawChat } : {}),
  } : null
  const after = store.setClosing(row.id, closing, template.id)
  return {
    status: 200,
    body: { ok: true, closingSteps: !!closing, ...(message ? { messageKept: !!closing?.message } : {}), row: after ? situationView(after) : null },
  }
}

/** What a caller shows about the agent turn behind it (the daemon reads
 *  the X-AgentX-Task, -Channel and -Chat headers). */
export interface TurnProof { taskId?: string; channel?: string; chatId?: string }

/** The running turn a /situations/fill call proves: with a task id, that
 *  task's owner and its own chat; else the claimed agent's one running
 *  turn in the named channel and chat. The chat and its situation key
 *  always come from the turn, never from the request body. */
export function fillTurnFrom(
  proof: TurnProof,
  claimed: string | undefined,
  deps: {
    taskOwner: (taskId: string) => string | null
    findRunningTurn: (agentId: string, by: { taskId?: string; channel?: string; chatId?: string }) => { context: { situationKey?: string; chatId?: string } } | null
  },
): FillApiContext["turn"] {
  const agentId = proof.taskId ? deps.taskOwner(proof.taskId) : (proof.channel && proof.chatId ? claimed : undefined)
  if (!agentId) return null
  const turn = deps.findRunningTurn(agentId, proof.taskId ? { taskId: proof.taskId } : { channel: proof.channel, chatId: proof.chatId })
  return turn ? { agentId, key: turn.context.situationKey, chatId: turn.context.chatId } : null
}

/** A request that shows an agent turn's headers comes from an agent's
 *  tool. The person-only routes (`/situations/closing`) refuse it. This
 *  stops the agent's own tools, not a process that leaves the headers
 *  out (loopback is not an identity; see the docs' limits). */
export function agentProofShown(proof: TurnProof): boolean {
  return !!(proof.taskId || (proof.channel && proof.chatId))
}
