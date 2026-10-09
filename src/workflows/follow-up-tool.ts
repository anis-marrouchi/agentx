import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { callerHeaders } from "@/calls/service"

// --- Agent-facing `agentx_workflow` tool (#788) ---
//
// A request with several steps is run as a workflow, not by hand:
//   match    saved workflows that fit the request in front of you
//   start    start one (workflowId), or build one from the owner's words
//            (title + steps) and run it; tags say what it concerns
//   status   one run: the step it is on and what it waits on
//   list     every follow-up still going, grouped by tag
//   done     the step you own is finished (evidence)
//   blocked  your step cannot go on without the owner (reason)
//   propose  ask the owner to keep a workflow as a reusable template
//   plan     write or change the plan of the run your task is wrapped in
//   step     report a step of that plan (started, done, failed)
// It talks to the daemon's /follow-up endpoints.

export interface WorkflowToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

function describe(run: any): string {
  const lines = [
    `Run ${run.runId} "${run.title}" [${run.status}] on step ${run.step}: waiting on ${run.waitingOn}.`,
    run.tags?.length ? `Tags: ${run.tags.join(", ")}` : "",
    ...(run.steps ?? []).slice(-8).map((s: any) => `- ${String(s.at).slice(0, 16).replace("T", " ")} ${s.step} ${s.status}${s.note ? `: ${s.note}` : ""}`),
  ]
  return lines.filter(Boolean).join("\n")
}

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runWorkflowTool(args: Record<string, unknown>, deps: WorkflowToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "list").toLowerCase()
  const env = deps.env ?? process.env
  const read = async (path: string) => {
    const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) })
    const data = await res.json().catch(() => ({})) as any
    return { ok: res.ok, status: res.status, data }
  }

  try {
    if (action === "list") {
      const r = await read("/follow-up")
      if (!r.ok) return `Error: ${r.data?.error || `HTTP ${r.status}`}`
      const groups = r.data.groups ?? []
      if (!groups.length) return "No follow-up workflows are running."
      return groups.map((g: any) => [`${g.tag}:`, ...g.rows.map((row: any) => `- ${row.runId} "${row.title}" on ${row.step}: waiting on ${row.waitingOn} (since ${String(row.since).slice(0, 16).replace("T", " ")} UTC)`)].join("\n")).join("\n")
    }
    if (action === "match") {
      const q = str(args.request) || str(args.title)
      if (!q) return "Error: match needs `request`: the owner's request in their words."
      const caller = resolveScheduleCaller(args, env)
      const r = await read(`/follow-up/match?q=${encodeURIComponent(q)}${caller ? `&agentId=${encodeURIComponent(caller.agentId)}` : ""}`)
      if (!r.ok) return `Error: ${r.data?.error || `HTTP ${r.status}`}`
      const matches = r.data.matches ?? []
      if (!matches.length) return "No saved workflow fits. If the request has several steps, build one: start with title and steps."
      return [
        "Saved workflows, best fit first (confidence 0-1):",
        ...matches.map((x: any) => `- ${x.workflowId} "${x.title}" (${x.confidence}${x.autoStart ? ", starts without asking" : ""}): ${x.steps.map((s: any) => s.id).join(" → ")}`),
        `Start one with {action:"start", workflowId:"<id>", title:"…", tags:["client:<name>"]}. Run its steps through the workflow, not by hand.`,
      ].join("\n")
    }
    if (action === "status") {
      const runId = str(args.runId)
      if (!runId) return "Error: status needs runId."
      const r = await read(`/follow-up/${encodeURIComponent(runId)}`)
      if (!r.ok) return `Error: ${r.data?.error || `HTTP ${r.status}`}`
      return describe(r.data.run)
    }

    const caller = resolveScheduleCaller(args, env)
    if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
    const res = await doFetch(`${base}/follow-up`, {
      method: "POST",
      // The headers name this run: the daemon refuses a write that does
      // not come from a running turn of the agent.
      headers: { "Content-Type": "application/json", ...callerHeaders(env) },
      body: JSON.stringify({
        action, agentId: caller.agentId,
        workflowId: args.workflowId, title: args.title, description: args.description, tags: args.tags, inputs: args.inputs,
        steps: args.steps, edges: args.edges, approval: args.approval, autoStart: args.autoStart, requestId: args.requestId,
        runId: args.runId, step: args.step, evidence: args.evidence, note: args.note, reason: args.reason, fromRun: args.fromRun, status: args.status,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    if (action === "start") {
      const run = data.run
      return [
        `Started run ${run.runId} "${run.title}"${data.built ? " (built from the steps you gave; propose it with fromRun to keep it)" : ""}.`,
        data.awaitingApproval ? "It waits for the owner's approval before the first step." : `It is on step ${run.step}: ${run.waitingOn}.`,
        "AgentX follows it from here: it starts each step, reminds whoever is slow, and tells the owner when it ends. Do not run its steps by hand.",
        ...(data.warning ? [`Note: ${data.warning}`] : []),
      ].join(" ")
    }
    if (action === "plan") {
      return [
        `Plan recorded on run ${data.run?.runId ?? args.runId}:`,
        ...(data.plan ?? []).map((s: any) => `- ${s.id} ${s.title}`),
        `Report each step with {action:"step", runId, step:"<id>", status:"started"|"done"|"failed"}.`,
      ].join("\n")
    }
    if (action === "step") return `Step recorded. ${data.run ? describe(data.run) : ""}`.trim()
    if (action === "done") return `Step recorded as done. ${data.run ? describe(data.run) : ""}`.trim()
    if (action === "blocked") return "The step is marked blocked and the owner is told. Nothing more happens on it until it is sorted."
    return `Saved ${data.workflowId} switched off, and asked the owner (card ${data.cardId}) whether to keep it as a reusable workflow.`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
