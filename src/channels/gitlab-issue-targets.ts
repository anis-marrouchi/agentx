// Which agents a GitLab issue webhook should wake, and how to name the change
// in the wake message. Pure functions so the rules can be unit-tested without
// an adapter. See noqta/noqta#532: an edit that only touches milestone,
// labels, time or estimate must not wake anyone.

export type IssueTrigger = "mention" | "assignee-added" | "assignee-current" | "default-route"

type User = { username: string }

export interface IssueTargetEvent {
  user: { name: string; username: string }
  object_attributes: { action: string; description?: string | null }
  assignees?: User[]
  changes?: Record<string, unknown> & {
    assignees?: { previous?: User[]; current?: User[] }
    description?: { previous?: string | null; current?: string | null }
  }
}

function mentionsIn(text: string | null | undefined): string[] {
  return (text || "").match(/@(\w[\w.-]*)/g)?.map((m) => m.slice(1).replace(/[.]+$/, "").toLowerCase()) || []
}

/** Deterministic target set for an issue event. Order:
 *    1. agents @mentioned in the description: all of them on `open`; on an
 *       update, only mentions the description edit added
 *    2. agents newly added as assignees (changes.assignees diff)
 *    3. agents in the full assignee list, on `open` only (create-with-assignee
 *       has no `changes`)
 *    4. project default route, on `open` only, when 1-3 found nobody
 *  Each agent appears at most once; the first trigger that found it wins. */
export function computeIssueTargets(
  event: IssueTargetEvent,
  usernameToAgent: Map<string, string>,
  defaultAgentId: string | undefined,
): Array<{ agentId: string; trigger: IssueTrigger }> {
  const out: Array<{ agentId: string; trigger: IssueTrigger }> = []
  const seen = new Set<string>()
  const add = (agentId: string | undefined, trigger: IssueTrigger) => {
    if (!agentId || seen.has(agentId)) return
    seen.add(agentId)
    out.push({ agentId, trigger })
  }
  const opened = event.object_attributes.action === "open"

  // 1. Mentions in the description
  const descChange = event.changes?.description
  if (opened) {
    for (const u of mentionsIn(event.object_attributes.description)) add(usernameToAgent.get(u), "mention")
  } else if (descChange) {
    const before = new Set(mentionsIn(descChange.previous))
    for (const u of mentionsIn(descChange.current)) {
      if (!before.has(u)) add(usernameToAgent.get(u), "mention")
    }
  }

  // 2. Newly added assignees
  const previous = new Set((event.changes?.assignees?.previous ?? []).map((a) => a.username.toLowerCase()))
  for (const a of event.changes?.assignees?.current ?? []) {
    const u = a.username.toLowerCase()
    if (!previous.has(u)) add(usernameToAgent.get(u), "assignee-added")
  }

  // 3. Created with an agent assignee
  if (opened && out.length === 0) {
    for (const a of event.assignees ?? []) add(usernameToAgent.get(a.username.toLowerCase()), "assignee-current")
  }

  // 4. Project default route
  if (opened && out.length === 0) add(defaultAgentId, "default-route")

  return out
}

// Bookkeeping fields GitLab sends with every update; never a change by itself.
const NOISE = new Set(["updated_at", "updated_by_id", "last_edited_at", "last_edited_by_id"])
const FIELD_NAMES: Record<string, string> = {
  milestone_id: "milestone",
  total_time_spent: "time spent",
  time_change: "time spent",
  time_estimate: "estimate",
  state_id: "state",
  due_date: "due date",
}

/** One line for the wake message: what changed and who changed it. */
export function describeIssueChange(event: IssueTargetEvent): string {
  const who = `${event.user.name} (@${event.user.username})`
  const action = event.object_attributes.action
  if (action !== "update") return `Change: ${action === "open" ? "opened" : action === "reopen" ? "reopened" : action} by ${who}`
  const fields = [...new Set(Object.keys(event.changes ?? {})
    .filter((k) => !NOISE.has(k))
    .map((k) => FIELD_NAMES[k] ?? k.replace(/_/g, " ")))]
  return `Change: ${fields.length ? fields.join(", ") : "issue"} updated by ${who}`
}
