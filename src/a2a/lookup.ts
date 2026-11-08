// --- Look a colleague's work up instead of asking them (agentx_lookup) ---
//
// In an office you check the board before you interrupt a colleague. Agents
// could not: the only way to learn where a piece of work stood, or what a
// colleague was on, was to message them, which starts a run on their side
// and often a second one on yours for the answer. Over three days in
// November 2026 about one direct agent-to-agent message in seven only
// relayed or asked for a status.
//
// Two read-only questions, answered from what the daemon already keeps,
// with no model call:
//   agent  what a colleague is on now, their open requests, what they
//          finished lately, and their hand-offs still running
//   work   everything known about one piece of work (an issue or merge
//          request link or ref, or an owner's request id), across agents
//
// Bounded summaries only. A run that came from a person's own chat (phone
// app, chat apps, voice, email, the owner's answer on a decision card)
// shows that it happened, never its words: what a person said to one agent
// is not handed to another. On "api" only the owner's runs are private
// (sender operator or owner, or not recorded); a script's runs show.

import { homeRefsOf, normalizeHome } from "./home"

/** Channels where a person talks to the agent: their words stay private.
 *  "approvals" carries the owner's note on a decision card. */
export const PERSON_CHANNELS = new Set(["app", "telegram", "whatsapp", "voice", "slack", "discord", "email", "sms", "ntfy", "dashboard", "web-chat", "tui", "guest", "public-api", "approvals"])

/** Channels shared by the owner and by scripts: private when the owner sent it. */
const OWNER_SENDERS = new Set(["operator", "owner"])

export const RECENT_HOURS = 48
export const WORK_DAYS = 7
const TEXT_CLIP = 220
const MAX_RUNS = 12

const REQUEST_ID = /^req-[0-9A-HJKMNP-TV-Z]{26}$/

export interface LookupRun {
  agentId: string
  channel: string
  /** Where it came from or what it is about: a chat id that is not a
   *  person's, the work it names, or "a person's chat". */
  about: string
  startedAt: string
  status: string
  /** First part of the answer, for work channels only. */
  answer?: string
  /** First part of what was asked, for work channels only (running runs). */
  asked?: string
}

export interface LookupRequest {
  id: string
  agentId: string
  state: string
  headline: string
  need?: string
  home?: string
  updatedAt: string
}

export interface LookupHandOff { id: string; caller: string; callee: string; peer?: string; status: string; startedAt: string }

export interface AgentLookup {
  agent: string
  node?: string
  running: LookupRun[]
  requests: LookupRequest[]
  recent: LookupRun[]
  handOffs: LookupHandOff[]
}

export interface WorkLookup {
  work: string
  requests: LookupRequest[]
  runs: LookupRun[]
  /** The scan ran out of time before the window's oldest runs. */
  partial?: boolean
}

export interface TraceRow {
  agent_id: string
  channel: string | null
  chat_id: string | null
  status: string
  started_at: number
  original_message: string | null
  final_response: string | null
  error: string | null
  /** Who sent it; "" when no one was named, null or absent when the row
   *  predates the record. */
  sender?: string | null
}

export interface RequestRow {
  id: string; agentId: string; state: string; text: string; headline: string | null; need: string | null
  home: { kind: string; link: string } | null; updatedAt: number
}

export function isPersonChannel(channel: string | null | undefined): boolean {
  return !!channel && PERSON_CHANNELS.has(channel)
}

/** Are this run's words a person's? A person's channel always; "api" when
 *  the owner sent it, or when the sender was never recorded (older rows). */
export function isPrivateRun(channel: string | null | undefined, sender: string | null | undefined): boolean {
  if (isPersonChannel(channel)) return true
  if (channel !== "api") return false
  return sender == null || OWNER_SENDERS.has(sender.trim().toLowerCase())
}

function clip(t: string | null | undefined, n = TEXT_CLIP): string | undefined {
  if (!t) return undefined
  const s = t.replace(/\s+/g, " ").trim()
  if (!s) return undefined
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z"

/** One run, as another agent may see it. */
export function runView(r: TraceRow): LookupRun {
  const channel = r.channel ?? "?"
  const person = isPrivateRun(channel, r.sender)
  const refs = homeRefsOf(r.original_message?.slice(0, 2000) ?? "")
  const reqs = (r.original_message?.slice(0, 2000) ?? "").match(/\breq-[0-9A-HJKMNP-TV-Z]{26}\b/g) ?? []
  const named = [...new Set([...reqs, ...refs])].slice(0, 3).join(", ")
  const about = person
    ? `a person's chat${named ? ` (about ${named})` : ""}`
    : named || r.chat_id || channel
  const view: LookupRun = { agentId: r.agent_id, channel, about, startedAt: iso(r.started_at), status: r.status }
  if (!person) {
    const answer = clip(r.status === "ok" || r.status === "completed" ? r.final_response : r.error ?? r.final_response)
    if (answer) view.answer = answer
    if (r.status === "in-flight") {
      const asked = clip(r.original_message)
      if (asked) view.asked = asked
    }
  }
  return view
}

export function requestView(r: RequestRow): LookupRequest {
  const v: LookupRequest = { id: r.id, agentId: r.agentId, state: r.state, headline: clip(r.headline || r.text, 160) ?? "(no words)", updatedAt: iso(r.updatedAt) }
  const need = clip(r.need, 160)
  if (need) v.need = need
  if (r.home?.link) v.home = r.home.link
  return v
}

/** The comparable key of a work reference: an owner's request id as is,
 *  an issue or merge request in its `group/project#12` / `!12` form.
 *  Null for anything else (a bare `#12` names different work in every
 *  project). */
export function workKey(ref: string): { kind: "request" | "home"; key: string } | null {
  const s = ref.trim()
  if (REQUEST_ID.test(s)) return { kind: "request", key: s }
  const h = normalizeHome(s)
  if (h && /[#!]\d+$/.test(h) && h.includes("/")) return { kind: "home", key: h }
  return null
}

/** Strings a SQL LIKE can pre-filter runs by, before homeRefsOf confirms. */
export function likeNeedles(key: { kind: "request" | "home"; key: string }): string[] {
  if (key.kind === "request") return [key.key]
  const m = /^(.*\/)?([^/]+)([#!])(\d+)$/.exec(key.key)
  if (!m) return [key.key]
  const project = m[2]
  const n = m[4]
  // The bare form too: the run is kept only if it also names the project
  // (runConcerns), so the wide match costs a filter, not a wrong answer.
  return m[3] === "!"
    ? [`${project}!${n}`, `merge_requests/${n}`, `!${n}`]
    : [`${project}#${n}`, `issues/${n}`, `pull/${n}`]
}

/** Does this run concern the work? Confirmed on the parsed references,
 *  not the substring the pre-filter used. */
export function runConcerns(r: TraceRow, key: { kind: "request" | "home"; key: string }): boolean {
  const text = `${r.chat_id ?? ""}\n${r.original_message?.slice(0, 4000) ?? ""}`
  if (key.kind === "request") return text.includes(key.key)
  if (homeRefsOf(text).includes(key.key)) return true
  return bareRefNamesProject(text, key.key)
}

/** Agents often write "wa-crm-pipeline … !52" rather than the full ref. A
 *  bare merge request ref counts when the same text names the project. A
 *  bare issue number (#52) never does: it is too common in prose. */
export function bareRefNamesProject(text: string, key: string): boolean {
  const m = /^(?:.*\/)?([^/]+)!(\d+)$/.exec(key)
  if (!m) return false
  const project = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w.-])${project}(?![\\w-])`, "i").test(text) && new RegExp(`(?<![\\w/!])!${m[2]}(?!\\d)`).test(text)
}

export function requestConcerns(r: RequestRow, key: { kind: "request" | "home"; key: string }): boolean {
  if (key.kind === "request") return r.id === key.key
  if (r.home?.link && normalizeHome(r.home.link) === key.key) return true
  return homeRefsOf(r.text).includes(key.key)
}

export const MAX_LOOKUP_RUNS = MAX_RUNS

/** Text for the agent: short lines, the newest first. */
export function formatAgentLookup(l: AgentLookup): string {
  const lines = [`${l.agent}${l.node ? ` (on ${l.node})` : ""}`]
  lines.push(l.running.length ? "Working on now:" : "Working on now: nothing.")
  for (const r of l.running) lines.push(`- since ${r.startedAt}, ${r.channel}: ${r.about}${r.asked ? ` — asked: ${r.asked}` : ""}`)
  lines.push(l.requests.length ? "Open requests from the owner:" : "Open requests from the owner: none.")
  for (const q of l.requests) lines.push(`- ${q.id} [${q.state}] ${q.headline}${q.need ? ` — needs: ${q.need}` : ""}${q.home ? ` — ${q.home}` : ""} (updated ${q.updatedAt})`)
  lines.push(l.handOffs.length ? "Hand-offs still running:" : "Hand-offs still running: none.")
  for (const h of l.handOffs) lines.push(`- ${h.id}: ${h.caller} -> ${h.callee}${h.peer ? `@${h.peer}` : ""}, since ${h.startedAt}`)
  lines.push(l.recent.length ? `Finished in the last ${RECENT_HOURS} h (newest first):` : `Finished in the last ${RECENT_HOURS} h: nothing.`)
  for (const r of l.recent) lines.push(`- ${r.startedAt} ${r.status}, ${r.channel}: ${r.about}${r.answer ? ` — ${r.answer}` : ""}`)
  return lines.join("\n")
}

export function formatWorkLookup(l: WorkLookup): string {
  const lines = [`Work ${l.work}`]
  lines.push(l.requests.length ? `Owner's requests about it (open, or closed in the last ${WORK_DAYS} days):` : "Owner's requests about it: none.")
  for (const q of l.requests) lines.push(`- ${q.id} (${q.agentId}) [${q.state}] ${q.headline}${q.need ? ` — needs: ${q.need}` : ""} (updated ${q.updatedAt})`)
  lines.push(l.runs.length ? `Runs about it in the last ${WORK_DAYS} days (newest first):` : `Runs about it in the last ${WORK_DAYS} days: none on this computer.`)
  for (const r of l.runs) lines.push(`- ${r.startedAt} ${r.agentId} ${r.status}, ${r.channel}${r.answer ? ` — ${r.answer}` : r.asked ? ` — asked: ${r.asked}` : ""}`)
  if (l.partial) lines.push("(Search stopped early; older runs in the window were not read.)")
  return lines.join("\n")
}
