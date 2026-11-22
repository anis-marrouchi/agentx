import { worktreeTarget } from "@/agents/task-worktrees"
import type { RunOn } from "@/requests/store"

// --- Which node a message's run goes to (#2104 B1) ---
//
// One order, for every entry point the router serves (channel messages,
// forge comments and hooks, CI wakes):
//   1. the home node of an active workflow run on the entity: a choice
//      never splits a live workflow;
//   2. the issue's `runOn`, chosen from the Hub and kept on the request
//      homed on the issue (requests/store.ts);
//   3. `agentMappings[].node`, which the channel adapter sets as the
//      message's `preferNode`;
//   4. nothing: today's local, then mesh, fallback.
// Pure: the router does the reads (MessageRouter.resolvePreferNode).

/** The forge issue a channel chat is, or null (pull and merge requests,
 *  tracker issues and chats are not placed). */
export function issueOfChat(channel: string | undefined, chatId: string | undefined): { provider: "github" | "gitlab"; project: string; number: number } | null {
  const t = worktreeTarget(channel, chatId)
  if (!t || t.kind === "change" || !t.repo || (t.source !== "github" && t.source !== "gitlab") || !/^\d+$/.test(t.id)) return null
  return { provider: t.source, project: t.repo, number: Number(t.id) }
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

/** Where the run goes and why. `node` unset: this node (or the local, then
 *  mesh, fallback when `source` is "none"). */
export interface PreferNodePick {
  node?: string
  source: "workflow" | "runOn" | "mapping" | "none"
  runOn?: RunOn
}

/** Marks a workflow run homed on this node. */
export const LOCAL_NODE = "local"

/** The order above. `workflowHome`: the active run's home node, LOCAL_NODE
 *  when it is this node, null when no run is active. */
export function pickPreferNode(input: { workflowHome?: string | null; runOn?: RunOn | null; mapping?: string | null }): PreferNodePick {
  if (input.workflowHome) return input.workflowHome === LOCAL_NODE ? { source: "workflow" } : { node: input.workflowHome, source: "workflow" }
  if (input.runOn?.node) return { node: input.runOn.node, source: "runOn", runOn: input.runOn }
  if (input.mapping) return { node: input.mapping, source: "mapping" }
  return { source: "none" }
}

/** The one note posted on an issue whose node is offline (#2104 B5). */
export function offlineNoteText(node: string): string {
  return `${node} is offline; this issue's runs wait for it.`
}
