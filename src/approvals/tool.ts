import { resolveScheduleCaller } from "@/crons/schedule-tool"

// --- Agent-facing `agentx_approval` tool ---
//
// Lets an agent raise a decision card instead of asking the operator in
// chat, and check what happened to one. It talks to the daemon's
// /approvals endpoints, which never decide: there is no action here that
// approves or rejects anything.

export type ApprovalToolAction = "create" | "status"

export interface ApprovalToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const NON_CHAT_CHANNELS = new Set(["cron", "heartbeat", "api", "a2a", "mesh", "approvals"])

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runApprovalTool(args: Record<string, unknown>, deps: ApprovalToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "create").toLowerCase() as ApprovalToolAction
  const caller = resolveScheduleCaller(args, deps.env ?? process.env)

  if (action === "status") {
    const id = str(args.id)
    if (!id) return "Error: `id` is required for status (the card id you got when you raised it)."
    try {
      const res = await doFetch(`${base}/approvals/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      const c = data.card
      if (caller && c.raised_by !== caller.agentId) return `Error: card "${id}" was raised by another agent.`
      if (c.status === "pending") return `Card ${c.id} is still waiting for the operator. It expires ${c.expires}; then "${c.if_silent}" applies.`
      if (c.status === "decided") return `Card ${c.id}: the operator said ${String(c.verdict).toUpperCase()}.${c.note ? ` Note: ${c.note}` : ""}`
      return `Card ${c.id} expired unanswered; the default applied: ${c.outcome ?? c.if_silent}.`
    } catch (e: any) {
      return `Error: couldn't reach the daemon (${e?.message ?? e}).`
    }
  }

  if (action !== "create") return `Error: unknown action "${action}". Use create or status.`
  if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."

  const reply = caller.channel && caller.chatId && !NON_CHAT_CHANNELS.has(caller.channel)
    ? { channel: caller.channel, chatId: caller.chatId, ...(caller.accountId ? { accountId: caller.accountId } : {}) }
    : undefined
  const payload = {
    title: args.title,
    ask: args.ask,
    recommend: args.recommend,
    if_silent: args.if_silent,
    expires: args.expires,
    source: args.source,
    raised_by: caller.agentId,
    ...(reply ? { reply } : {}),
  }
  try {
    const res = await doFetch(`${base}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    const c = data.card
    return [
      `Decision card ${c.id} is in the operator's Approvals inbox.`,
      `If nobody answers by ${c.expires}, "${c.if_silent}" applies.`,
      "You will get a message with the result. Tell the requester it is waiting for approval; don't ask the operator again in chat.",
    ].join(" ")
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
