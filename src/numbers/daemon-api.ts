import type { CallerProof } from "@/requests/daemon-api"
import { READING_NOTE_MAX, lastPeriod, parsePeriod, parseTags, statusOf, STATUS_WORDS } from "./model"
import { parseNumberInput } from "./input"
import { reviewList } from "./review"
import type { NumberSource } from "./sources"
import type { NumberRecord, NumberStore } from "./store"

// --- The daemon's /numbers endpoints (#1826) ---
//
// Reachable by agents (the agentx_numbers tool), gated like /sprints.
//   GET  /numbers          tracked numbers, each with its status and newest
//                          reading. ?tags=channel:youtube,product:x narrows
//                          to numbers with every tag; ?archived=1 adds the
//                          ones no longer tracked; ?review=1 keeps only
//                          the missed, missed-twice and no-reading ones,
//                          worst first, each with its missed-twice card
//   GET  /numbers/:id      one number and its readings, newest first
//   POST /numbers          an agent's statement: create (make or change a
//                          number it owns), record (a reading of a number
//                          it owns, for a window) or archive (stop
//                          tracking one). The call must come from a running
//                          turn of that agent. Numbers set up in agentx.json
//                          are changed there, not here; a command source
//                          is refused.

export interface NumbersApiDeps {
  store: NumberStore
  hasAgent: (agentId: string) => boolean
  runningTurn: (agentId: string, proof: CallerProof) => { channel: string; chatId: string } | null
  now?: number
}

export interface NumbersReply { status: number; body: unknown }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export const MASK = "***"

/** The url with each query value masked (`?api_key=***`); keys stay. Text
 *  work, not URL(), so `{start}` and `{end}` stay as written. */
export function maskQuery(url: string): string {
  const m = url.match(/^([^?#]*)(?:\?([^#]*))?(#.*)?$/)
  if (!m || m[2] === undefined) return url
  const query = m[2].split("&").map((p) => (p.includes("=") ? `${p.slice(0, p.indexOf("="))}=${MASK}` : p)).join("&")
  return `${m[1]}?${query}${m[3] ?? ""}`
}

/** The source as agents may see it: header values, query values and
 *  command text can hold tokens, so they are masked. Header and query
 *  names stay, so an agent can tell one is set. */
export function sourceView(s: NumberSource): NumberSource {
  if (s.kind === "http-json") {
    const { headers, ...rest } = s
    return { ...rest, url: maskQuery(s.url), ...(headers ? { headers: Object.fromEntries(Object.keys(headers).map((k) => [k, MASK])) } : {}) }
  }
  if (s.kind === "command") return { ...s, command: MASK }
  return s
}

/** A number with where it stands: for lists and the tool. */
export function numberView(store: NumberStore, n: NumberRecord, now: number, readings = 2) {
  const recent = store.readings(n.id, Math.max(2, readings))
  const status = statusOf(n, recent, now)
  return { ...n, source: sourceView(n.source), status, statusWords: STATUS_WORDS[status], latest: recent[0] ?? null, ...(readings > 2 ? { readings: recent } : {}) }
}

export function handleNumbersApi(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
  deps: NumbersApiDeps,
  caller: CallerProof = {},
): NumbersReply {
  const { store } = deps
  const now = deps.now ?? Date.now()
  const id = path.startsWith("/numbers/") ? decodeURIComponent(path.slice("/numbers/".length)) : ""

  if (method === "GET") {
    if (id) {
      const n = store.get(id)
      if (!n) return { status: 404, body: { error: `no number "${id}"` } }
      const limit = Math.min(200, Math.max(3, Number(query.get("limit")) || 20))
      return { status: 200, body: { number: numberView(store, n, now, limit) } }
    }
    const tags = parseTags(query.get("tags") ?? "")
    if (!Array.isArray(tags)) return { status: 400, body: { error: tags.error } }
    if (query.get("review") === "1") {
      const items = reviewList(store, now, { tags })
      return { status: 200, body: { count: items.length, numbers: items.map((i) => ({ ...numberView(store, i.number, now), card: i.card })) } }
    }
    const list = store.list({ archived: query.get("archived") === "1", tags })
    return { status: 200, body: { count: list.length, numbers: list.map((n) => numberView(store, n, now)) } }
  }
  if (method !== "POST" || id) return { status: 405, body: { error: "use GET /numbers, GET /numbers/:id or POST /numbers" } }

  const input = body ?? {}
  const action = str(input.action).toLowerCase()
  if (!["create", "record", "archive"].includes(action)) return { status: 400, body: { error: `unknown action "${action}": use create, record or archive` } }
  const agentId = str(input.agentId)
  if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }
  if (!deps.runningTurn(agentId, caller)) {
    return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: record numbers from inside your own run` } }
  }

  const numberId = str(input.id)
  const had = numberId ? store.get(numberId) : null
  const notYours = had && had.ownerAgent && had.ownerAgent !== agentId ? `number "${had.id}" belongs to ${had.ownerAgent}` : null

  if (action === "create") {
    const { action: _a, agentId: _b, ...fields } = input
    const parsed = parseNumberInput(fields, "agent")
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } }
    if (had?.origin === "config") return { status: 409, body: { error: `number "${had.id}" is set up in agentx.json: change it there` } }
    if (notYours) return { status: 403, body: { error: notYours } }
    if (!had && !parsed.name) return { status: 400, body: { error: "create needs name: what the number counts, in a few plain words" } }
    if (parsed.ownerAgent && !deps.hasAgent(parsed.ownerAgent)) return { status: 400, body: { error: `owner must be an agent on this node` } }
    const n = store.upsert({ ...parsed, ownerAgent: parsed.ownerAgent ?? had?.ownerAgent ?? agentId }, now)
    return { status: had ? 200 : 201, body: { number: numberView(store, n, now) } }
  }

  if (!numberId) return { status: 400, body: { error: `${action} needs id: the number's id (list shows them)` } }
  if (!had) return { status: 404, body: { error: `no number "${numberId}"` } }
  if (notYours) return { status: 403, body: { error: notYours } }

  if (action === "archive") {
    if (had.origin === "config") return { status: 409, body: { error: `number "${had.id}" is set up in agentx.json: take it out there` } }
    store.archive(had.id, now)
    return { status: 200, body: { number: numberView(store, store.get(had.id)!, now) } }
  }

  // record
  const value = typeof input.value === "number" ? input.value : str(input.value) ? Number(str(input.value).replace(/,/g, "")) : NaN
  if (!Number.isFinite(value)) return { status: 400, body: { error: "record needs value: a number (a failed read is not recorded as 0)" } }
  const period = input.from !== undefined && input.from !== "" ? parsePeriod(input.from, input.to) : lastPeriod(had.rhythm, now)
  if ("error" in period) return { status: 400, body: { error: period.error } }
  if (period.start > now) return { status: 400, body: { error: "the window starts in the future" } }
  const note = str(input.note).slice(0, READING_NOTE_MAX)
  store.record({ numberId: had.id, value, readAt: now, periodStart: period.start, periodEnd: period.end, by: agentId, note: note || null })
  return { status: 200, body: { number: numberView(store, had, now) } }
}
