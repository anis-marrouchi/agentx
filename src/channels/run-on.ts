import { normalizeHome } from "@/a2a/home"
import { worktreeTarget } from "@/agents/task-worktrees"
import { LOCAL_PLACEMENT, type Placement } from "@/requests/store"

// --- Which node a run goes to (#2104 B1) ---
//
// One order, read by the router (channel messages) and by registry.execute
// (every task, so Hub turns, crons with a home and workflow agent steps too):
//   1. the home node of an active workflow run on the entity (the router
//      forwards the message to it, as before; a workflow that starts runs
//      its engine where it starts, and each agent step comes back through
//      registry.execute);
//   2. the issue's placement, chosen from the Hub and kept per issue chat
//      in `issue_placements` (requests/store.ts). "local" is a choice too:
//      it beats a mapping;
//   3. the source's mapping: `agentMappings[].node` (the message's
//      `preferNode`), or `webhookEntries[].node` for a mapped webhook;
//   4. nothing: local, then the mesh fallback.
// A task a peer sent (`placed`, or arrived on /task from the mesh) is
// never forwarded again. A picked node that keeps an issue's work left
// behind by a forced move (`issue_left_behind`, #2104 Q4) never gets its
// runs: they are held with a note until the owner clears the record (C-d).

export const LOCAL_NODE = LOCAL_PLACEMENT

/** An issue chat, as placements are keyed: channel and lower-cased chat id. */
export interface IssueKey { channel: "github" | "gitlab"; chatId: string }

/** The forge issue a channel chat is, or null (pull and merge requests,
 *  tracker issues and chats are not placed). */
export function issueOfChat(channel: string | undefined, chatId: string | undefined): { provider: "github" | "gitlab"; project: string; number: number } | null {
  const t = worktreeTarget(channel, chatId)
  if (!t || t.kind === "change" || !t.repo || (t.source !== "github" && t.source !== "gitlab") || !/^\d+$/.test(t.id)) return null
  return { provider: t.source, project: t.repo, number: Number(t.id) }
}

export function issueKeyOfChat(channel: string | undefined, chatId: string | undefined): IssueKey | null {
  const i = issueOfChat(channel, chatId)
  return i ? { channel: i.provider, chatId: `${i.project}:issue:${i.number}`.toLowerCase() } : null
}

/** The issue chats a home ref ("group/project#12" or an issue link) can
 *  be: GitHub's and GitLab's, which share the form. */
export function issueKeysOfHome(home: unknown): IssueKey[] {
  const h = normalizeHome(home)
  const m = h?.match(/^(.+)#(\d+)$/)
  if (!m) return []
  const chatId = `${m[1]}:issue:${m[2]}`
  return [{ channel: "github", chatId }, { channel: "gitlab", chatId }]
}

export interface RunNodeDeps {
  placement: (channel: string, chatId: string) => Placement | null
  /** The home of a request, for a pick-up turn whose chat is the request. */
  requestHome?: (requestId: string) => string | null | undefined
  /** The nodes keeping work left behind on an issue chat (#2104 C-d). */
  leftBehind?: (channel: string, chatId: string) => string[]
}

/** The pick-up channel (requests/tracker.ts PICKUP_CHANNEL), named here so
 *  this module stays free of the tracker. */
const PICKUP_CHANNEL = "requests"

/** The issue chats a task names: its own chat, else its `home`, else (a
 *  pick-up turn) its request's home. */
export function issueKeysOfTask(ctx: Record<string, unknown> | undefined | null, deps: Pick<RunNodeDeps, "requestHome">): IssueKey[] {
  if (!ctx) return []
  const channel = typeof ctx.channel === "string" ? ctx.channel : undefined
  const chatId = typeof ctx.chatId === "string" ? ctx.chatId : undefined
  const own = issueKeyOfChat(channel, chatId)
  if (own) return [own]
  const home = issueKeysOfHome(ctx.home)
  if (home.length) return home
  if (channel === PICKUP_CHANNEL && chatId && deps.requestHome) {
    try { return issueKeysOfHome(deps.requestHome(chatId)) } catch { return [] }
  }
  return []
}

/** The placement of the issue a task names, with the issue chat it is
 *  kept under, or null when the task names no placed issue. `held`: the
 *  placed node keeps work left behind on the issue (C-d). */
export function resolveRunNode(task: { context?: Record<string, unknown> | null }, deps: RunNodeDeps): { key: IssueKey; placement: Placement; held?: true } | null {
  for (const key of issueKeysOfTask(task.context, deps)) {
    let p: Placement | null = null
    try { p = deps.placement(key.channel, key.chatId) } catch { p = null }
    if (p) return leftBehindOn(deps, key).includes(p.node) ? { key, placement: p, held: true } : { key, placement: p }
  }
  return null
}

/** The nodes keeping work left behind on an issue chat; a read that fails
 *  counts as none. */
export function leftBehindOn(deps: Pick<RunNodeDeps, "leftBehind">, key: IssueKey | null): string[] {
  if (!key || !deps.leftBehind) return []
  try { return deps.leftBehind(key.channel, key.chatId) } catch { return [] }
}

/** Whether a task came from a peer: it is never forwarded again. */
export function fromPeer(ctx: Record<string, unknown> | undefined | null): boolean {
  return !!ctx && (ctx.placed === true || ctx.fromPeer === true)
}

/** The workflow entities a channel chat can be (workflows/hooks.ts names a
 *  GitLab issue `group/project#7` and a merge request `group/project!7`;
 *  a channel-triggered run names the chat `<channel>:<chatId>`). */
export function workflowEntityRefs(channel: string | undefined, chatId: string | undefined): Array<{ backend: string; id: string }> {
  if (!channel || !chatId) return []
  const out: Array<{ backend: string; id: string }> = []
  const t = worktreeTarget(channel, chatId)
  if (t?.repo && (t.source === "github" || t.source === "gitlab")) {
    out.push({ backend: t.source, id: `${t.repo}${t.kind === "change" && t.source === "gitlab" ? "!" : "#"}${t.id}` })
  }
  out.push({ backend: channel, id: `${channel}:${chatId}` })
  return out
}

/** Where the run goes and why. `node` unset: this node (or, with source
 *  "none", the local then mesh fallback). `held`: `node` keeps work left
 *  behind on the issue, so the run is not sent there (C-d). */
export interface PreferNodePick {
  node?: string
  source: "workflow" | "placement" | "mapping" | "none"
  held?: true
}

/** The order above. `workflowHome`: the active run's home node, LOCAL_NODE
 *  when it is this node, null when none is active. A placement of
 *  LOCAL_NODE keeps the run here, whatever the mapping says. */
export function pickPreferNode(input: { workflowHome?: string | null; placement?: Placement | null; mapping?: string | null; leftBehind?: string[] }): PreferNodePick {
  const pick = orderedPick(input)
  return pick.node && input.leftBehind?.includes(pick.node) ? { ...pick, held: true } : pick
}

function orderedPick(input: { workflowHome?: string | null; placement?: Placement | null; mapping?: string | null }): PreferNodePick {
  if (input.workflowHome) return input.workflowHome === LOCAL_NODE ? { source: "workflow" } : { node: input.workflowHome, source: "workflow" }
  if (input.placement) return input.placement.node === LOCAL_NODE ? { source: "placement" } : { node: input.placement.node, source: "placement" }
  if (input.mapping) return { node: input.mapping, source: "mapping" }
  return { source: "none" }
}

/** The note on an issue whose run was not sent to a node keeping its
 *  left-behind work (#2104 C-d). */
export function leftBehindNoteText(node: string): string {
  return `${node} keeps unpushed work on this issue from a forced move, so this run was not sent there. Recover or drop that work on ${node}, clear it from the Hub (or run the issue on another node), then write again.`
}

/** The one note posted on an issue whose node is offline (#2104 B5). */
export function offlineNoteText(node: string): string {
  return `${node} is offline; this issue's runs wait for it.`
}

/** The note on an issue whose held messages were dropped (#2104 C1). */
export function droppedNoteText(node: string, count: number, why: "ttl" | "full"): string {
  const n = `${count} message${count === 1 ? "" : "s"} held for ${node}`
  return why === "ttl"
    ? `${n} ${count === 1 ? "was" : "were"} dropped: ${node} was offline for more than 30 minutes. Write again if it still matters.`
    : `${n} ${count === 1 ? "was" : "were"} dropped: more than 50 were waiting for it. Write again if it still matters.`
}
