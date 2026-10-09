import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"
import { answerLines } from "./choices"

// --- Agent-facing `agentx_approval` tool ---
//
// Lets an agent raise a decision card instead of asking the operator in
// chat, check what happened to one, and close its own card once the owner
// answered the same thing in chat and it acted on that (#909). It talks to
// the daemon's /approvals endpoints, which never decide: there is no
// action here that approves or rejects anything.

export type ApprovalToolAction = "create" | "status" | "resolve"

export interface ApprovalToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const NON_CHAT_CHANNELS = new Set(["cron", "heartbeat", "api", "a2a", "mesh", "approvals", "requests"])

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
      if (c.status === "decided") {
        const picked = c.verdict === "yes" ? answerLines(c).join("\n") : ""
        return `Card ${c.id}: the operator said ${String(c.verdict).toUpperCase()}.${c.note ? ` Note: ${c.note}` : ""}${picked ? `\n${picked}` : ""}`
      }
      if (c.status === "resolved") return `Card ${c.id} was closed by ${c.raised_by}: ${c.resolution ?? "answered outside the card"}.`
      return `Card ${c.id} expired unanswered; the default applied: ${c.outcome ?? c.if_silent}.`
    } catch (e: any) {
      return `Error: couldn't reach the daemon (${e?.message ?? e}).`
    }
  }

  if (action === "resolve") {
    const id = str(args.id)
    const reason = str(args.reason)
    if (!id) return "Error: `id` is required for resolve (the card id you got when you raised it)."
    if (!reason) return "Error: `reason` is required for resolve: where the owner answered and what you did, e.g. \"approved in chat, done\"."
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    try {
      const res = await doFetch(`${base}/approvals/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...callerHeaders(deps.env ?? process.env) },
        body: JSON.stringify({ raised_by: caller.agentId, reason }),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      return `Card ${data.card.id} is closed. It left the operator's inbox, so nobody will be asked about it again.`
    } catch (e: any) {
      return `Error: couldn't reach the daemon (${e?.message ?? e}).`
    }
  }

  if (action !== "create") return `Error: unknown action "${action}". Use create, status or resolve.`
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
    choices: args.choices,
    draft: args.draft,
    say: args.say,
    context: args.context,
    raised_by: caller.agentId,
    ...(reply ? { reply } : {}),
  }
  try {
    const res = await doFetch(`${base}/approvals`, {
      method: "POST",
      // The headers name this run: a card moves a request to "waiting on
      // the owner" only when it comes from the turn of that request.
      headers: { "Content-Type": "application/json", ...callerHeaders(deps.env ?? process.env) },
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
      `If the operator answers the same thing in chat and you act on it, close the card with {action:"resolve", id:"${c.id}", reason:"approved in chat, done"} so it is not asked again.`,
    ].join(" ")
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
