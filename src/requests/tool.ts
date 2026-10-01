import { resolveScheduleCaller } from "@/crons/schedule-tool"

// --- Agent-facing `agentx_request` tool (#356) ---
//
// Lets an agent say what it is doing with the owner's request, so the
// request stays visible until it is closed:
//   accept   I am taking this on; keep it open after this turn
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

    const caller = resolveScheduleCaller(args, deps.env ?? process.env)
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    const res = await doFetch(`${base}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action, agentId: caller.agentId, channel: caller.channel, chatId: caller.chatId,
        id: args.id, question: args.question, evidence: args.evidence, reason: args.reason,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    const r = data.request
    if (action === "accept") return `Request ${r.id} is open and in progress. Close it with done (and a link to the evidence) or decline (and the reason); it stays on the owner's list until then.`
    if (action === "wait") return `Request ${r.id} is waiting on the owner with your question. Ask them the question now, once.`
    if (action === "done") return `Request ${r.id} is closed as done. Evidence: ${r.evidence}`
    return `Request ${r.id} is closed as declined. Reason: ${r.closeReason}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
