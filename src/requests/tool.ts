import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"

// --- Agent-facing `agentx_request` tool (#356) ---
//
// Lets an agent say what it is doing with the owner's request, so the
// request stays visible until it is closed:
//   accept   I am taking this on; keep it open after this turn. With
//            `steps` (two or more): a tracked plan the daemon follows (#788)
//   step     report on one step of a plan: progress, done, blocked
//   wait     the next step is the owner's answer to this question
//   done     finished, with a link to the evidence
//   decline  I will not do it, with the reason
//   list     what is still open
// It talks to the daemon's /requests endpoints. Dropping a request is the
// owner's alone; there is no action for it here.

export interface RequestToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

const STATE_WORDS: Record<string, string> = {
  in_progress: "in progress",
  waiting_owner: "waiting on the owner",
  waiting_other: "waiting on another agent",
  needs_attention: "needs attention",
}

/** One line per open request, oldest first. */
export function describeOpen(items: any[]): string {
  if (!items.length) return "No open requests."
  return items.map((r) => {
    const when = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")
    const extra = r.state === "waiting_owner" && r.question ? ` Question: ${r.question}`
      : r.state === "needs_attention" && r.attentionReason ? ` ${r.attentionReason}` : ""
    const words = String(r.text).replace(/\s+/g, " ").trim()
    return `- ${r.id} [${STATE_WORDS[r.state] ?? r.state}] ${when} UTC, ${r.channel}, ${r.agentId}: ${words.length > 160 ? `${words.slice(0, 159)}…` : words}.${extra}`
  }).join("\n")
}

/** One line per plan step. */
export function describeSteps(steps: any[]): string[] {
  return (steps ?? []).map((s) => `${s.idx}. ${s.name} (${s.agentId}, ${s.kind}) [${s.state}]${s.needsApproval ? ` approval: ${s.approval}` : ""}`)
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runRequestTool(args: Record<string, unknown>, deps: RequestToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "list").toLowerCase()

  try {
    if (action === "list") {
      const res = await doFetch(`${base}/requests`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      if (!data.enabled) return "Requests are turned off on this node (requests.enabled), so nothing is recorded."
      return `${data.count} open request${data.count === 1 ? "" : "s"}, oldest first.\n${describeOpen(data.items ?? [])}`
    }

    const env = deps.env ?? process.env
    const caller = resolveScheduleCaller(args, env)
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    const res = await doFetch(`${base}/requests`, {
      method: "POST",
      // The headers name this run: the daemon refuses a write that does
      // not come from a running turn of the agent.
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({
        action, agentId: caller.agentId,
        id: args.id, question: args.question, evidence: args.evidence, reason: args.reason,
        steps: args.steps, step: args.step, status: args.status, note: args.note,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    const r = data.request
    if (action === "accept" && data.plan) {
      return [
        `Request ${r.id} is open with a plan of ${data.steps.length} steps. The daemon hands each step to its agent in order, nudges a step that goes quiet, and tells the owner when it is finished or blocked.`,
        ...describeSteps(data.steps),
        `Steps the owner approves get a decision card now; an approved message is sent by the daemon itself. Report your own steps with {action:"step", id:"${r.id}", step:<n>, status:"progress"|"done"|"blocked"}.`,
      ].join("\n")
    }
    if (action === "step") return [`Step reported. Plan of ${r.id}:`, ...describeSteps(data.steps)].join("\n")
    if (action === "accept") return `Request ${r.id} is open and in progress. Close it with done (and a link to the evidence) or decline (and the reason); it stays on the owner's list until then.`
    if (action === "wait") return `Request ${r.id} is waiting on the owner with your question. Ask them the question now, once.`
    if (action === "done") return `Request ${r.id} is closed as done. Evidence: ${r.evidence}`
    return `Request ${r.id} is closed as declined. Reason: ${r.closeReason}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
