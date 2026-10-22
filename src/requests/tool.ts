import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"

// --- Agent-facing `agentx_request` tool (#356) ---
//
// Lets an agent say what it is doing with the owner's request, so the
// request stays visible until it is closed:
//   accept   I am taking this on; keep it open after this turn. With
//            `steps` (two or more): a tracked plan the daemon follows (#788).
//            `work` and `estimateMinutes` say what it is: code work or a
//            long estimate is refused without steps (#1048)
//   step     report on one step of a plan: progress, done, blocked
//   wait     the next step is the owner's answer to this question
//   done     finished, with a link to the evidence. On a loop with a
//            closeWhen the daemon runs its check first (#1039)
//   decline  I will not do it, with the reason
//   promise  I owe someone something (owedTo, text, due, closeWhen):
//            an open loop of its own, listed with the open requests
//   describe give it a headline and a need line (#1126): what the owner
//            reads first on its card, push and Desk line. accept, wait
//            and promise take `headline` and `need` too
//   list     what is still open
// It talks to the daemon's /requests endpoints. Dropping a request is the
// owner's alone; there is no action for it here.

export interface RequestToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

/** A done on a loop with a check waits for it: the slowest is an issue
 *  check, three forge calls of up to 10 s each. */
export const DONE_TIMEOUT_MS = 45_000

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
    const words = String(r.headline || r.text).replace(/\s+/g, " ").trim()
    const loop = [
      r.promise && r.owedTo ? ` Promised to ${r.owedTo}.` : "",
      r.dueAt ? ` Due ${new Date(r.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "",
      r.closeWhen ? ` Closes on its check (${r.closeWhen.kind})${r.verifyState ? `: ${r.verifyState}` : ""}.` : "",
    ].join("")
    return `- ${r.id} [${STATE_WORDS[r.state] ?? r.state}] ${when} UTC, ${r.channel}, ${r.agentId}: ${words.length > 160 ? `${words.slice(0, 159)}…` : words}.${extra}${loop}`
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
        steps: args.steps, work: args.work, estimateMinutes: args.estimateMinutes, step: args.step, status: args.status, note: args.note, home: args.home,
        owedTo: args.owedTo, text: args.text, due: args.due, closeWhen: args.closeWhen,
        headline: args.headline, need: args.need,
      }),
      signal: AbortSignal.timeout(action === "done" ? DONE_TIMEOUT_MS : 10_000),
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
    if (action === "describe") return `Request ${r.id} now reads: ${r.headline ?? "(no headline)"}. Needed from the owner: ${r.need ?? "(not said)"}.`
    if (action === "step") return [`Step reported. Plan of ${r.id}:`, ...describeSteps(data.steps)].join("\n")
    if (action === "accept") return `Request ${r.id} is open and in progress. Close it with done (and a link to the evidence) or decline (and the reason); it stays on the owner's list until then.`
    if (action === "wait") return `Request ${r.id} is waiting on the owner with your question. Ask them the question now, once.`
    if (action === "promise") {
      return `Promise ${r.id} is open, owed to ${r.owedTo}${r.dueAt ? `, due ${new Date(r.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}. ` +
        (r.closeWhen ? "The daemon checks its evidence and closes it once the check is met." : `Close it with {action:"done", id:"${r.id}", evidence:"<link>"} when it is kept.`)
    }
    if (action === "done" && data.verify === "unverified") {
      return `Request ${r.id} stays open: its check could not say whether it is finished (${data.detail}). It is marked unverified; the daemon checks again, and the owner can close it by hand.`
    }
    if (action === "done") return `Request ${r.id} is closed as done${data.verified ? " (its check was met)" : ""}. Evidence: ${r.evidence}`
    return `Request ${r.id} is closed as declined. Reason: ${r.closeReason}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
