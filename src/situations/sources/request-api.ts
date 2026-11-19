import { isValidCardId, readCard, type CardSettings, type ReplyTarget } from "@/approvals/cards"
import { askSourceConsent, consentState, type ConsentSettings } from "./consent"
import type { SourceReadLog } from "./read-log"
import type { SignalSources } from "./registry"
import { isUnknown } from "./types"

// --- The daemon side of `agentx_sources` (#1892 phase 7) ---
//
//   POST /situations/sources/ask    the agent asks the person: one card
//   POST /situations/sources/read   the agent reads, for one request
//   GET  /situations/sources/reads  the read log (the CLI, this machine)
//
// All three answer callers on this machine only: signals stay on the node
// (design 2.3). Ask and read also need a running turn of the agent (the
// turn's proof headers, as /situations/fill): the agent is the turn's,
// never the body's.

export interface SourcesTurn {
  agentId: string
  /** The running task, when the proof named one: the request of a read
   *  that needs no yes. */
  taskId?: string
  reply?: ReplyTarget
  key?: string
  /** The turn's chat, "channel:chatId". */
  chat?: string
}

export interface SourcesApiReply {
  status: number
  body: Record<string, unknown>
}

/** The running turn the proof headers name (as fillTurnFrom): by the task
 *  id, or by a warm process's channel and chat with the agent it claims,
 *  checked against the registry. Null when no running turn matches. */
export function sourcesTurnFrom(
  proof: { taskId?: string; channel?: string; chatId?: string },
  claimed: string | undefined,
  deps: {
    taskOwner: (taskId: string) => string | null
    findRunningTurn: (agentId: string, by: { taskId?: string; channel?: string; chatId?: string }) => { taskId: string; context: { channel?: string; chatId?: string; situationKey?: string; accountId?: string } } | null
  },
): SourcesTurn | null {
  const agentId = proof.taskId ? deps.taskOwner(proof.taskId) : (proof.channel && proof.chatId ? claimed : undefined)
  if (!agentId) return null
  const turn = deps.findRunningTurn(agentId, proof.taskId ? { taskId: proof.taskId } : { channel: proof.channel, chatId: proof.chatId })
  if (!turn) return null
  const c = turn.context
  return {
    agentId,
    taskId: turn.taskId,
    ...(c.situationKey ? { key: c.situationKey } : {}),
    ...(c.channel && c.chatId ? { chat: `${c.channel}:${c.chatId}`, reply: { channel: c.channel, chatId: c.chatId, ...(c.accountId ? { accountId: c.accountId } : {}) } } : {}),
  }
}

const MAX_SOURCES_PER_ASK = 3
const LOCAL_ONLY = "per-request sources answer only on this machine"
const NO_TURN = "no running turn of yours was found: ask from inside your turn"

export function sourcesAsk(body: Record<string, unknown>, deps: {
  local: boolean
  turn: SourcesTurn | null
  sources: SignalSources
  root: string
  settings: ConsentSettings
  cardSettings?: CardSettings
  /** The popup on this machine is on: the only place a yes counts. */
  popupOn: boolean
  now?: number
}): SourcesApiReply {
  if (!deps.local) return { status: 403, body: { error: LOCAL_ONLY } }
  if (!deps.turn) return { status: 403, body: { error: NO_TURN } }
  const ids = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : []
  if (!ids.length) return { status: 400, body: { error: "sources is required: one or more of open-apps, browser-tabs, news" } }
  if (ids.length > MAX_SOURCES_PER_ASK) return { status: 400, body: { error: `at most ${MAX_SOURCES_PER_ASK} sources per ask` } }
  for (const id of ids) {
    const no = deps.sources.askRefusal(id, deps.turn.agentId)
    if (no) return { status: 409, body: { error: `${id}: ${no}` } }
    if (!deps.sources.needsConsent(id)) return { status: 400, body: { error: `${id} needs no yes on this node: read it with action "read"` } }
  }
  if (!deps.popupOn) {
    return { status: 409, body: { error: "a yes counts only in the popup on this machine, and the popup is off here (approvals.popup.enabled): nothing can be read. Tell the person." } }
  }
  const t = deps.turn
  const r = askSourceConsent(deps.root, {
    agentId: t.agentId, sources: ids, why: body.why, minutes: body.minutes,
    ...(t.reply ? { reply: t.reply } : {}), ...(t.chat ? { chat: t.chat } : {}), ...(t.taskId ? { taskId: t.taskId } : {}),
  }, {
    settings: deps.settings, ...(deps.cardSettings ? { cardSettings: deps.cardSettings } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  if (!r.ok) return { status: 400, body: { error: r.error } }
  return { status: 201, body: { request: r.card.id, sources: ids, minutes: r.minutes, waitsUntil: r.card.expires } }
}

export async function sourcesRead(body: Record<string, unknown>, deps: {
  local: boolean
  turn: SourcesTurn | null
  sources: SignalSources
  root: string
  now?: number
}): Promise<SourcesApiReply> {
  if (!deps.local) return { status: 403, body: { error: LOCAL_ONLY } }
  if (!deps.turn) return { status: 403, body: { error: NO_TURN } }
  const source = typeof body.source === "string" ? body.source.trim() : ""
  if (!source) return { status: 400, body: { error: "source is required" } }
  if (!deps.sources.isPerRequest(source)) return { status: 409, body: { error: `${source}: not a per-request source on this node` } }
  const given = typeof body.request === "string" ? body.request.trim() : ""
  const consent = deps.sources.needsConsent(source)
  if (consent && !given) return { status: 400, body: { error: `request is required: ${source} needs the person's yes; ask first (action "ask") and use the request it gives` } }
  // A request is a consent card's id, or this turn's own task.
  if (given && !isValidCardId(given)) return { status: 400, body: { error: "request must be the id the ask gave" } }
  const requestId = given || deps.turn.taskId || ""
  if (!requestId) return { status: 400, body: { error: "request is required" } }
  const t = deps.turn
  const answers = await deps.sources.readForRequest(source, {
    agentId: t.agentId, requestId, ...(t.key ? { key: t.key } : {}), ...(t.chat ? { chat: t.chat } : {}), ...(t.taskId ? { taskId: t.taskId } : {}),
  })
  const out: Record<string, unknown> = {
    source,
    request: requestId,
    answers: answers.map((s) => ({ kind: s.kind, value: s.value, reason: s.reason })),
  }
  // Why a yes does not hold, in words the agent can pass on.
  if (consent && answers.every(isUnknown) && answers.some((s) => s.reason === "no consent")) {
    const card = isValidCardId(requestId) ? readCard(deps.root, requestId) : null
    const state = consentState(card, source, t.agentId, deps.now ?? Date.now(), { chat: t.chat, taskId: t.taskId })
    out.consent = state.granted ? "granted" : state.why
  }
  return { status: 200, body: out }
}

export function sourcesReads(query: URLSearchParams, deps: { local: boolean; log: SourceReadLog | undefined }): SourcesApiReply {
  if (!deps.local) return { status: 403, body: { error: LOCAL_ONLY } }
  if (!deps.log) return { status: 503, body: { error: "the read log is not available on this node" } }
  const limit = Number(query.get("limit") ?? 50)
  const request = query.get("request") ?? undefined
  return { status: 200, body: { reads: deps.log.list({ limit: Number.isFinite(limit) ? limit : 50, ...(request ? { requestId: request } : {}) }) } }
}
