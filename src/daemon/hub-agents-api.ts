// --- GET /api/admin/hub/agents (#2101 P4a) ---
//
// The rows of the Hub's left column (ui/pages/hub-agents.ts), built on the
// server for the phone's Agents tab (C1a): the live snapshot (/api/live's
// quick read) and what waits on the owner (the Needs you list: inbox items
// and the Desk's requests, as wall-decide.client.ts decAll reads them).

import { listInbox } from "@/approvals/inbox"
import { readOwnerList } from "@/desk/owner-list"
import { hubAgentRows, type HaModel, type HaNeed } from "./ui/pages/hub-agents"
import { ltPlain, ltTitle, type LtNode } from "./ui/pages/wall-tree"

/** What waits on the owner, one entry per item, with the agent that asks. */
export function hubNeeds(root: string, node: { url: string; name: string }): HaNeed[] {
  const out: HaNeed[] = []
  const seen = new Set<string>()
  for (const i of listInbox({ root }, { includeSnoozed: true }).items) {
    seen.add(i.key)
    out.push({ key: i.key, title: i.title, agent: i.raised_by, at: Date.parse(i.created_at) || 0, snoozed: i.snoozed_until ? Date.parse(i.snoozed_until) || 1 : 0 })
  }
  for (const c of readOwnerList({ root }, node).items || []) {
    if (seen.has(c.key) || !c.key.startsWith("request:")) continue
    out.push({ key: c.key, title: c.title, agent: c.agent, at: Date.parse(c.askedAt || "") || 0 })
  }
  return out
}

/** The rows, from a live snapshot's nodes (board-dashboard's buildLiveSnapshot, quick). */
export function hubAgentsFor(nodes: LtNode[], node: { url: string; name: string }, now: number, dayStart: number, root = process.cwd()): HaModel & { at: string } {
  const model = hubAgentRows(nodes || [], hubNeeds(root, node), now, dayStart, (t) => ltTitle(t, null), ltPlain)
  return { ...model, at: new Date(now).toISOString() }
}
