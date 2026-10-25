import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"

// --- Agent-facing `agentx_sprint` tool (#1241) ---
//
// A lead agent hands the daemon a sprint: lanes side by side, each with an
// agent and an ordered list of items. The daemon gives each lane its next
// item when the lane's turn ends, so the lanes go on after the lead's
// session does.
//   start    a new sprint: title, ref (the plan's link), lanes
//   list     active sprints and the last finished ones
//   show     one sprint, item by item
//   block    stop a lane (its agent or the lead), with a note
//   retry, skip, hold, release
//            the lead moves a lane on
//   cancel   the lead stops the sprint
// It talks to the daemon's /sprints endpoints.

export interface SprintToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** One block per sprint: its lanes, item by item. */
export function describeSprint(v: any): string {
  const s = v.sprint
  const lines = [`${s.id} "${s.title}" [${s.state}], lead ${s.createdBy}${s.ref ? `, plan ${s.ref}` : ""}`]
  for (const l of v.lanes ?? []) {
    const items = (v.items ?? []).filter((i: any) => i.lane === l.lane)
    lines.push(`  lane ${l.lane} (${l.agentId}) [${l.state}]${l.note ? ` ${l.note}` : ""}`)
    for (const i of items) lines.push(`    ${i.idx}. ${i.ref}${i.title ? ` (${i.title})` : ""} [${i.state}]${i.note && i.state !== "done" ? ` ${i.note}` : ""}`)
  }
  return lines.join("\n")
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runSprintTool(args: Record<string, unknown>, deps: SprintToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "list").toLowerCase()

  try {
    if (action === "list" || action === "show") {
      const id = str(args.id)
      if (action === "show" && !id) return "Error: show needs id: the sprint's id (spr-…)."
      const res = await doFetch(`${base}/sprints${action === "show" ? `/${encodeURIComponent(id)}` : ""}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      if (action === "show") return describeSprint(data)
      if (!data.enabled) return "Sprints are turned off on this node (requests.sprints.enabled)."
      const items = data.items ?? []
      return items.length ? items.map(describeSprint).join("\n\n") : "No sprints."
    }

    const env = deps.env ?? process.env
    const caller = resolveScheduleCaller(args, env)
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    const res = await doFetch(`${base}/sprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({
        action, agentId: caller.agentId,
        id: args.id, title: args.title, ref: args.ref, idleMinutes: args.idleMinutes, lanes: args.lanes,
        lane: args.lane, item: args.item, note: args.note,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    if (action === "start") {
      return [
        `Sprint ${data.sprint.id} is running. AgentX hands each lane its first item now, and the next one each time the lane's turn ends; a lane that fails, or sits idle with items left, is told to the owner.`,
        describeSprint(data),
        "You do not need to stay in this session to keep the lanes going.",
      ].join("\n")
    }
    if (action === "cancel") return `Sprint ${data.sprint.id} is cancelled: no more items are handed out. A turn already running goes on.`
    return [`Done. Sprint ${data.sprint.id} now:`, describeSprint(data)].join("\n")
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
