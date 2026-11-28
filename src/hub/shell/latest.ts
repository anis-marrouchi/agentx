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
  if (r.state === "working" && r.taskId && r.nodeUrl) return "run"
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
  | { kind: "read"; channel: string; taskId: string }

export function latestView(r: { data?: LatestReply; failed: boolean }, node: string): LatestView {
  if (r.failed) return { kind: "unchecked", node }
  if (!r.data) return { kind: "loading" }
  const taskId = r.data.runs?.[0]?.taskId
  if (!r.data.found || !taskId || isHubChat(r.data.channel, r.data.chatId)) return { kind: "hub" }
  return { kind: "read", channel: haChannelLabel(r.data.channel) || "another channel", taskId }
}

/** A machine's name from its address, for "not checked" (host, else the address). */
export function nodeName(nodeUrl: string, name?: string): string {
  if (name) return name
  try { return new URL(nodeUrl).host || nodeUrl } catch { return nodeUrl }
}

/** The turns as chat messages: what was asked, then the answer, the error,
 *  or the pending line for a run still going. */
export function turnMessages(turns: LatestTurn[]): { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error" }[] {
  const out: { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error" }[] = []
  for (const t of turns) {
    if (t.message) out.push({ seq: out.length, role: "user", content: t.message, status: "done" })
    if (t.running) out.push({ seq: out.length, role: "assistant", content: "", status: "pending" })
    else if (t.ok === false || t.error) out.push({ seq: out.length, role: "assistant", content: t.error || "", status: "error" })
    else if (t.responseText) out.push({ seq: out.length, role: "assistant", content: t.responseText, status: "done" })
  }
  return out
}
