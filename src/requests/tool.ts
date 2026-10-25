import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"
import { awaitingQa, describeQa } from "./qa"
import type { GoalSummary } from "./goals"

// --- Agent-facing `agentx_request` tool (#356) ---
//
// Lets an agent say what it is doing with the owner's request, so the
// request stays visible until it is closed:
//   accept   I am taking this on; keep it open after this turn. With
//            `steps` (two or more): a tracked plan the daemon follows (#788).
//            `work` and `estimateMinutes` say what it is: code work or a
//            long estimate is refused without steps (#1048). `goal`
//            names the goal it serves (#1168)
//   step     report on one step of a plan: progress, done, blocked
//   wait     the next step is the owner's answer to this question
//   done     finished, with a link to the evidence, or a typed proof
//            (link, test, output, check; #1138 D). On a loop with a
//            closeWhen the daemon runs its check first (#1039). A promise
//            closed with a proof leaves a dated wiki fact
//   decline  I will not do it, with the reason
//   promise  I owe someone something (owedTo, text, due, closeWhen):
//            an open loop of its own, listed with the open requests
//   describe what it is (headline) and what is needed from the owner
//            (need), for every card, push and Desk line (#1126). accept,
//            wait and promise take the two as well
//   qa       a QA verdict on a request (#1188): block, risk or pass, with
//            a note. accept, wait, promise and describe take needsQa to
//            ask for one
//   list     what is still open
//   goals    every goal requests name: progress and cost (#1168)
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
    const words = String(r.text).replace(/\s+/g, " ").trim()
    const loop = [
      r.promise && r.owedTo ? ` Promised to ${r.owedTo}.` : "",
      r.dueAt ? ` Due ${new Date(r.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "",
      r.closeWhen ? ` Closes on its check (${r.closeWhen.kind})${r.verifyState ? `: ${r.verifyState}` : ""}.` : "",
      awaitingQa(r) ? " Awaiting QA." : r.qa ? ` QA: ${describeQa(r.qa)}.` : "",
      r.goal ? ` Goal: ${r.goal.title} (${r.goal.id}).` : "",
    ].join("")
    return `- ${r.id} [${STATE_WORDS[r.state] ?? r.state}] ${when} UTC, ${r.channel}, ${r.agentId}: ${words.length > 160 ? `${words.slice(0, 159)}…` : words}.${extra}${loop}`
  }).join("\n")
}

/** Dollars, to the cent; under a cent, to the tenth of one. */
export function usd(n: number): string {
  return `$${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`
}

/** One line per goal, most recently active first (#1168). */
export function describeGoals(goals: GoalSummary[]): string {
  if (!goals.length) return "No request names a goal."
  return goals.map((g) => {
    const far = g.progress === null ? "nothing open or done" : `${Math.round(g.progress * 100)}% done`
    const unpriced = g.unpriced ? `, ${g.unpriced} of ${g.runs} runs without a cost` : ""
    return `- ${g.id} "${g.title}": ${g.open} open, ${g.done} done${g.dropped ? `, ${g.dropped} declined or dropped` : ""} (${far}). Cost ${usd(g.costUsd)}${unpriced}.`
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
    if (action === "goals") {
      const res = await doFetch(`${base}/requests/goals`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      return `${data.count} goal${data.count === 1 ? "" : "s"}, most recently active first.\n${describeGoals(data.goals ?? [])}`
    }

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
        id: args.id, question: args.question, evidence: args.evidence, proof: args.proof, reason: args.reason,
        steps: args.steps, work: args.work, estimateMinutes: args.estimateMinutes, step: args.step, status: args.status, note: args.note, home: args.home,
        owedTo: args.owedTo, text: args.text, due: args.due, closeWhen: args.closeWhen,
        headline: args.headline, need: args.need, needsQa: args.needsQa, verdict: args.verdict, goal: args.goal,
      }),
      signal: AbortSignal.timeout(action === "done" ? DONE_TIMEOUT_MS : 10_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    const r = data.request
    const serves = r.goal ? ` It serves the goal "${r.goal.title}" (${r.goal.id}).` : ""
    if (action === "accept" && data.plan) {
      return [
        `Request ${r.id} is open with a plan of ${data.steps.length} steps.${serves} The daemon hands each step to its agent in order, nudges a step that goes quiet, and tells the owner when it is finished or blocked.`,
        ...describeSteps(data.steps),
        `Steps the owner approves get a decision card now; an approved message is sent by the daemon itself. Report your own steps with {action:"step", id:"${r.id}", step:<n>, status:"progress"|"done"|"blocked"}.`,
      ].join("\n")
    }
    if (action === "step") return [`Step reported. Plan of ${r.id}:`, ...describeSteps(data.steps)].join("\n")
    if (action === "qa") return `Verdict recorded on ${r.id}: ${describeQa(r.qa)}. It shows on the request's card; nobody is told.`
    if (action === "describe") return `Request ${r.id} now reads "${r.headline ?? "(no headline)"}" on the owner's cards. Needed from them: ${r.need ?? "what follows from where it stands"}.`
    if (action === "accept") return `Request ${r.id} is open and in progress.${serves} Close it with done (and a link to the evidence) or decline (and the reason); it stays on the owner's list until then.`
    if (action === "wait") return `Request ${r.id} is waiting on the owner with your question. Ask them the question now, once.`
    if (action === "promise") {
      return `Promise ${r.id} is open, owed to ${r.owedTo}${r.dueAt ? `, due ${new Date(r.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}. ` +
        (r.closeWhen ? "The daemon checks its evidence and closes it once the check is met." : `Close it with {action:"done", id:"${r.id}", evidence:"<link>"} when it is kept.`)
    }
    if (action === "done" && data.verify === "unverified") {
      return `Request ${r.id} stays open: its check could not say whether it is finished (${data.detail}). It is marked unverified; the daemon checks again, and the owner can close it by hand.`
    }
    if (action === "done") {
      const fact = r.factId ? ` It left fact ${r.factId} in the wiki (agentx wiki facts show ${r.factId}).` : ""
      return `Request ${r.id} is closed as done${data.verified ? " (its check was met)" : ""}. Evidence: ${r.evidence}${fact}`
    }
    return `Request ${r.id} is closed as declined. Reason: ${r.closeReason}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
