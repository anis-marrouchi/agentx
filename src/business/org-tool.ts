import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"

// --- Agent-facing `agentx_org` tool (#1678 point 5) ---
//
// The owner asks in chat for a change to the org chart. The agent reads the
// chart with `show`, maps the names it heard to member refs, and sends the
// changes with `propose`. The tool never writes: the daemon checks every
// change (POST /api/org/proposals, org-proposals.ts) and raises one
// Approvals card; on the owner's yes the daemon applies it, not the agent.

export interface OrgToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const NON_CHAT_CHANNELS = new Set(["cron", "heartbeat", "api", "a2a", "mesh", "approvals", "requests"])

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runOrgTool(args: Record<string, unknown>, deps: OrgToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const env = deps.env ?? process.env
  const action = (str(args.action) || "show").toLowerCase()

  if (action === "show") {
    try {
      const res = await doFetch(`${base}/api/org`, { headers: callerHeaders(env), signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      return String(data.text ?? "")
    } catch (e: any) {
      return `Error: couldn't reach the daemon (${e?.message ?? e}).`
    }
  }

  if (action !== "propose") return `Error: unknown action "${action}". Use show or propose.`
  const caller = resolveScheduleCaller(args, env)
  if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
  const reply = caller.channel && caller.chatId && !NON_CHAT_CHANNELS.has(caller.channel)
    ? { channel: caller.channel, chatId: caller.chatId, ...(caller.accountId ? { accountId: caller.accountId } : {}) }
    : undefined
  try {
    const res = await doFetch(`${base}/api/org/proposals`, {
      method: "POST",
      // The headers name this run: the daemon checks that the owner started it.
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({ changes: args.changes, newAgent: args.newAgent, why: args.why, raised_by: caller.agentId, ...(reply ? { reply } : {}) }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    // A refusal is a plain sentence: say it to the owner as it is.
    if (!res.ok) return `Not proposed: ${data?.error || `HTTP ${res.status}`}`
    return [
      `Card ${data.card.id} is in the owner's Approvals inbox: "${data.text}"`,
      "Nothing is changed yet. On the owner's yes the daemon applies it and you get a message with the result; do not edit the org chart yourself.",
      "Tell the owner it is waiting for their yes.",
    ].join(" ")
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
