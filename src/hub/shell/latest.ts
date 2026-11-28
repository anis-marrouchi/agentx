// --- What a click on an agent opens (#2101 R26), as data ---
//
// A working agent opens its live run on its Task page. An agent with
// questions opens them (#2505). Any other agent opens its latest
// conversation, from any channel, read only, with a "New Hub chat" button;
// an agent with no conversation, or whose latest one is a Hub chat, opens the
// Hub chat as before.
//
// The conversation is read in two GETs behind the dashboard's own guard (the
// one /api/live sits behind): which chat the agent spoke in last
// (GET /api/mesh/latest → the node's /analytics/latest, storage/mesh-drill.ts
// latestThread, built on listThreadRuns), then that chat's last turns
// (GET /api/task/history?session=1, the run's session, #2101 R4). A node
// that does not answer is "not checked", never "no conversation".
//
// Plain data and pure functions, so the tests check them without a browser.

import { haChannelLabel, type HaRow } from "../../daemon/ui/pages/hub-agents"

/** How many of the latest turns the view shows. */
export const LATEST_TURNS = 10

/** What a row opens. */
export type RowOpens = "run" | "chat" | "latest"

export function rowOpens(r: Pick<HaRow, "state" | "taskId" | "nodeUrl"> | undefined): RowOpens {
  if (!r) return "chat"
  // A working agent never opens an older conversation (Anis 11-28: a click
  // on a working Dev Session opened its last voice thread). Its run, on this
  // machine too (nodeUrl "", as the old Hub's haRunHref takes it); a row
  // with no run id yet opens the Hub chat, which shows the run going.
  if (r.state === "working") return r.taskId ? "run" : "chat"
  if (r.state === "needs" || !r.nodeUrl) return "chat"
  return "latest"
}

/** A working row's live run, on its Task page: the address the old Hub's
 *  row opens (hub-nav.client.ts haRunHref, wall-task.client.ts wallTaskHref). */
export function runHref(r: Pick<HaRow, "id" | "taskId" | "nodeUrl">): string {
  const q = new URLSearchParams({ page: "task", task: r.taskId, agent: r.id, node: r.nodeUrl })
  return "#" + q.toString()
}

export function latestUrl(nodeUrl: string, agent: string): string {
  return "/api/mesh/latest?" + new URLSearchParams({ node: nodeUrl, agent, limit: "1" }).toString()
}

export function sessionUrl(nodeUrl: string, agent: string, taskId: string): string {
  return "/api/task/history?" + new URLSearchParams({ node: nodeUrl, agent, task: taskId, session: "1", limit: String(LATEST_TURNS) }).toString()
}

/** GET /api/mesh/latest (mesh-drill.ts LatestThread). */
export interface LatestReply {
  found: boolean
  channel?: string
  chatId?: string
  runs?: { taskId: string }[]
}

/** One turn of GET /api/task/history?session=1 (agents/task-session.ts SessionTurn). */
export interface LatestTurn {
  id: string
  message: string
  responseText?: string
  ok?: boolean
  error?: string
  running?: boolean
  /** When the turn started (ISO); who sent it on its channel. */
  startedAt?: string
  sender?: string
}

/** The Hub's own chat with an agent (POST /api/assistant's run context). */
export function isHubChat(channel?: string, chatId?: string): boolean {
  return channel === "dashboard" && chatId === "assistant"
}

/** What the centre shows for the latest-conversation read. */
export type LatestView =
  | { kind: "loading" }
  | { kind: "hub" }
  | { kind: "unchecked"; node: string }
  | { kind: "read"; channel: string; chat: string; taskId: string }

export function latestView(r: { data?: LatestReply; failed: boolean }, node: string, agent = ""): LatestView {
  if (r.failed) return { kind: "unchecked", node }
  if (!r.data) return { kind: "loading" }
  const taskId = r.data.runs?.[0]?.taskId
  if (!r.data.found || !taskId || isHubChat(r.data.channel, r.data.chatId)) return { kind: "hub" }
  return { kind: "read", channel: haChannelLabel(r.data.channel) || "another channel", chat: chatName(r.data.channel, r.data.chatId, agent), taskId }
}

/** Which chat it was, said plainly (Anis 11-28: "no idea where it came
 *  from"): the other agent on an agent-to-agent chat, the job of a
 *  schedule, else the chat's own id, cut short. "" when there is none. */
export function chatName(channel?: string, chatId?: string, agent = ""): string {
  const id = String(chatId || "")
  if (!id || id === "-") return ""
  if (channel === "a2a") {
    const p = id.split(":")
    if (p[0] === "a2a" && p.length >= 3) {
      const peer = p[1] === agent ? p[2] : p[1]
      if (peer && peer !== "?") return "with " + peer
    }
  }
  // A phone number or a numeric chat id names nothing: the turns say who
  // wrote ("from …") instead.
  if (OPAQUE_IDS.has(String(channel)) || /^[+-]?\d+(@\S+)?$/.test(id)) return ""
  const plain = channel === "cron" && id.startsWith("cron:") ? id.slice(5) : id
  return plain.length > 32 ? plain.slice(0, 31) + "…" : plain
}

const OPAQUE_IDS = new Set(["telegram", "whatsapp", "app", "voice", "discord"])

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** When a turn was, in local time: "Today 08:55", "Yesterday 21:10",
 *  "Fri 27 Nov, 08:55", with the year when it is not this year. */
export function whenLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now)
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const gap = Math.round((day(n) - day(d)) / 86400000)
  if (gap === 0) return "Today " + hm
  if (gap === 1) return "Yesterday " + hm
  const year = d.getFullYear() === n.getFullYear() ? "" : " " + d.getFullYear()
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + year + ", " + hm
}

/** A machine's name from its address, for "not checked" (host, else the address). */
export function nodeName(nodeUrl: string, name?: string): string {
  if (name) return name
  try { return new URL(nodeUrl).host || nodeUrl } catch { return nodeUrl }
}

/** The turns as chat messages: what was asked, then the answer, the error,
 *  or the pending line for a run still going. */
export function turnMessages(turns: LatestTurn[]): { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error"; at?: number; from?: string }[] {
  const out: { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error"; at?: number; from?: string }[] = []
  for (const t of turns) {
    const at = Date.parse(t.startedAt || "")
    if (t.message) out.push({ seq: out.length, role: "user", content: t.message, status: "done", ...(Number.isFinite(at) ? { at } : {}), ...(t.sender ? { from: t.sender } : {}) })
    if (t.running) out.push({ seq: out.length, role: "assistant", content: "", status: "pending" })
    else if (t.ok === false || t.error) out.push({ seq: out.length, role: "assistant", content: t.error || "", status: "error" })
    else if (t.responseText) out.push({ seq: out.length, role: "assistant", content: t.responseText, status: "done" })
  }
  return out
}
