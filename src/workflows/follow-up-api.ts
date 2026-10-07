import { matchWorkflow } from "./matcher"
import { buildWorkflow, cleanTags, currentStep, progressGroups, waitingOn, workflowIdFor } from "./follow-up"
import type { WorkflowDispatcher } from "./dispatcher"
import type { RunStore } from "./run-store"
import type { WorkflowStore } from "./store"
import type { Workflow, WorkflowRun } from "./types"

// --- The daemon's /follow-up endpoints: what agentx_workflow calls (#788) ---
//
// Gated like /requests: loopback, or a mesh token (mesh-auth.ts).
//   GET  /follow-up              running follow-ups, grouped by tag
//   GET  /follow-up/match?q=     saved workflows that fit a request, best first
//   GET  /follow-up/:runId       one run: the step it is on and what it waits on
//   POST /follow-up              an agent's action, from a running turn of its own:
//     start    a saved workflow (workflowId) or one built from `steps`
//     done     the agent step it owns is finished (evidence)
//     blocked  the agent step cannot go on without the owner (reason)
//     propose  save a workflow (from `steps`, or from a run it built) for
//              the owner to approve as a reusable template
//
// Starting is the agent's; approving a template, cancelling a run and
// changing settings are the owner's (CLI, dashboard).

export interface FollowUpSettings {
  enabled: boolean
  agents: Record<string, boolean>
  stallMinutes: number
  maxNudges: number
  approval: "start" | "step"
}

export interface FollowUpApiDeps {
  dispatcher: Pick<WorkflowDispatcher, "startRun" | "stepDone">
  store: Pick<WorkflowStore, "get" | "list" | "save">
  runs: Pick<RunStore, "get" | "list">
  settings: FollowUpSettings
  hasAgent: (agentId: string) => boolean
  /** The channel and chat of the running turn of `agentId` the call
   *  proves (requests/daemon-api CallerProof), or null. */
  runningTurn: (agentId: string, proof: { taskId?: string; channel?: string; chatId?: string }) => { channel: string; chatId: string; restricted?: boolean } | null
  /** The open request of that turn, when there is one. */
  liveRequest?: (agentId: string, channel: string, chatId: string) => string | null
  /** Is this open request one of this agent's? A run closes the request
   *  it serves, so an agent may only name its own. */
  ownsRequest?: (requestId: string, agentId: string) => boolean
  /** Link a run to the request it serves. */
  linkRequest?: (requestId: string, runId: string) => void
  /** Tell the owner which workflow an agent started. */
  notifyOwner?: (text: string, from: string) => Promise<void>
  /** Raise the card that asks the owner to keep a proposed workflow. */
  proposeCard?: (wf: Workflow, agentId: string) => Promise<{ cardId: string }>
}

export interface ApiReply {
  status: number
  body: unknown
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function agentAllowed(settings: FollowUpSettings, agentId: string): boolean {
  return settings.enabled && (settings.agents[agentId] ?? true)
}

/** One run as the tool and the CLI show it. */
export function describeRun(run: WorkflowRun, wf: Workflow | null) {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    title: run.meta?.title ?? wf?.title ?? run.workflowId,
    status: run.status,
    step: currentStep(run),
    waitingOn: waitingOn(run),
    tags: run.meta?.tags ?? [],
    startedBy: run.meta?.startedBy ?? null,
    requestId: run.meta?.requestId ?? null,
    blocked: run.meta?.blocked ?? null,
    since: run.updatedAt,
    steps: run.history.filter((h) => h.status !== "skipped").slice(-20).map((h) => ({ at: h.at, step: h.nodeId, status: h.status, note: h.note ?? null })),
  }
}

export async function handleFollowUpApi(
  method: string,
  url: string,
  body: Record<string, unknown> | undefined,
  deps: FollowUpApiDeps,
  proof: { taskId?: string; channel?: string; chatId?: string } = {},
): Promise<ApiReply> {
  const m = method.toUpperCase()
  const [path, query = ""] = url.split("?")
  const params = new URLSearchParams(query)

  if (path === "/follow-up" && m === "GET") {
    const titles = new Map(deps.store.list().map((w) => [w.id, w.title] as const))
    return { status: 200, body: { enabled: deps.settings.enabled, groups: progressGroups(deps.runs.list({ limit: 500 }), (id) => titles.get(id)) } }
  }

  if (path === "/follow-up/match" && m === "GET") {
    const q = str(params.get("q"))
    if (!q) return { status: 400, body: { error: "match needs ?q=<the request>" } }
    const agentId = str(params.get("agentId"))
    const scored = deps.store.list()
      .map((wf) => matchWorkflow({ agentId, message: q }, [wf]))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)
      .map((x) => ({ workflowId: x.workflow.id, title: x.workflow.title, description: x.workflow.description ?? null, confidence: Number(x.confidence.toFixed(2)), autoStart: x.workflow.autoStart, steps: stepList(x.workflow) }))
    return { status: 200, body: { matches: scored } }
  }

  const one = path.match(/^\/follow-up\/([^/]+)$/)
  if (one && m === "GET") {
    const run = deps.runs.get(decodeURIComponent(one[1]))
    if (!run) return { status: 404, body: { error: `no run "${decodeURIComponent(one[1])}"` } }
    return { status: 200, body: { run: describeRun(run, deps.store.get(run.workflowId)) } }
  }

  if (path !== "/follow-up") return { status: 404, body: { error: "Not found" } }
  if (m !== "POST") return { status: 405, body: { error: "Method not allowed" } }

  const input = body ?? {}
  const action = str(input.action).toLowerCase()
  if (!["start", "done", "blocked", "propose"].includes(action)) {
    return { status: 400, body: { error: `unknown action "${action}": use start, done, blocked or propose (list, match and status are reads)` } }
  }
  const agentId = str(input.agentId)
  if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }
  if (!agentAllowed(deps.settings, agentId)) {
    return { status: 409, body: { error: `Follow-up workflows are off ${deps.settings.enabled ? `for ${agentId}` : "on this node"} (workflows.followUp).` } }
  }
  const turn = deps.runningTurn(agentId, proof)
  if (!turn) return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: use the agentx_workflow tool from inside your run` } }
  // A report- or propose-only turn may not set work going at full power.
  if (turn.restricted && (action === "start" || action === "propose")) {
    return { status: 403, body: { error: "this turn runs with restricted autonomy (report or propose): it cannot start or propose a workflow" } }
  }

  if (action === "done" || action === "blocked") {
    const runId = str(input.runId)
    if (!runId) return { status: 400, body: { error: `${action} needs runId` } }
    const reason = str(input.reason)
    if (action === "blocked" && !reason) return { status: 400, body: { error: "blocked needs `reason`: what the owner must do" } }
    const output: Record<string, unknown> = {}
    for (const k of ["evidence", "note", "result"] as const) if (str(input[k])) output[k] = str(input[k]).slice(0, 2000)
    const r = await deps.dispatcher.stepDone({ runId, nodeId: str(input.step) || undefined, agentId, ...(action === "blocked" ? { blocked: reason } : { output }) })
    if (!r.ok) return { status: 409, body: { error: r.error } }
    const run = deps.runs.get(runId)
    return { status: 200, body: { run: run ? describeRun(run, deps.store.get(run.workflowId)) : null } }
  }

  if (action === "propose") {
    let wf: Workflow
    const fromRun = str(input.fromRun)
    if (fromRun) {
      const run = deps.runs.get(fromRun)
      const built = run ? deps.store.get(run.workflowId) : null
      if (!run || !built) return { status: 404, body: { error: `no run "${fromRun}"` } }
      const title = str(input.title) || built.title
      wf = { ...built, id: workflowIdFor(title), title, tags: built.tags.filter((t) => t !== "built-on-demand") }
    } else {
      const title = str(input.title)
      if (!title) return { status: 400, body: { error: "propose needs a title (and steps, or fromRun)" } }
      const built = buildWorkflow({ id: workflowIdFor(title), title, description: str(input.description) || undefined, steps: input.steps, edges: input.edges, approval: input.approval, autoStart: input.autoStart, ownerAgent: agentId })
      if (!built.ok) return { status: 400, body: { error: built.error } }
      wf = built.workflow
    }
    if (!deps.proposeCard) return { status: 503, body: { error: "no way to ask the owner on this node" } }
    // Saved switched off: it never runs until the owner says yes.
    const saved = deps.store.save({ ...wf, status: "review", state: "disabled", ownerAgent: wf.ownerAgent ?? agentId, generatedFrom: `proposed by ${agentId}` })
    try {
      const { cardId } = await deps.proposeCard(saved, agentId)
      return { status: 200, body: { workflowId: saved.id, cardId } }
    } catch (e: any) {
      return { status: 502, body: { error: `saved ${saved.id} but could not ask the owner: ${e?.message ?? e}` } }
    }
  }

  // start
  const title = str(input.title)
  const tags = cleanTags(input.tags)
  let wf: Workflow | null
  let built = false
  const workflowId = str(input.workflowId)
  if (workflowId) {
    wf = deps.store.get(workflowId)
    if (!wf) return { status: 404, body: { error: `no workflow "${workflowId}"` } }
    if (wf.state !== "active" || (wf.status ?? "active") !== "active") {
      return { status: 409, body: { error: `workflow "${workflowId}" is not active (state ${wf.state}, status ${wf.status}); the owner turns it on` } }
    }
  } else {
    if (!title) return { status: 400, body: { error: "start needs workflowId, or a title and steps to build one" } }
    const res = buildWorkflow({ id: workflowIdFor(title, "adhoc"), title, steps: input.steps, edges: input.edges, approval: input.approval, ownerAgent: agentId, tags: ["built-on-demand"] })
    if (!res.ok) return { status: 400, body: { error: res.error } }
    // Kept switched off: it runs this once; propose saves it for reuse.
    wf = deps.store.save({ ...res.workflow, status: "draft", state: "disabled", generatedFrom: `built by ${agentId}` })
    built = true
  }
  const inputs = input.inputs && typeof input.inputs === "object" && !Array.isArray(input.inputs) ? input.inputs as Record<string, unknown> : {}
  const named = str(input.requestId)
  if (named && !deps.ownsRequest?.(named, agentId)) return { status: 403, body: { error: `request "${named}" is not an open request of ${agentId}` } }
  const requestId = (named || deps.liveRequest?.(agentId, turn.channel, turn.chatId)) ?? undefined
  const res = await deps.dispatcher.startRun({
    workflowId: wf.id,
    inputs: { ...inputs, requestedBy: agentId, channel: turn.channel, chatId: turn.chatId },
    meta: { title: title || wf.title, tags, startedBy: agentId, ...(requestId ? { requestId } : {}) },
  })
  if (!res.run) return { status: 400, body: { error: res.error ?? "could not start" } }
  if (requestId) deps.linkRequest?.(requestId, res.run.id)
  if (!wf.autoStart && deps.notifyOwner) {
    const steps = stepList(wf).map((s) => `${s.id} (${s.type})`).join(" → ")
    const what = built ? `built a workflow from your description` : `chose the saved workflow "${wf.title}"`
    await deps.notifyOwner(
      `${agentId} ${what} for "${title || wf.title}"${tags.length ? ` [${tags.join(", ")}]` : ""}: ${steps}. ${res.awaitingApproval ? "It waits for your approval before the first step." : "It has started."} Stop it with: agentx workflow cancel ${res.run.id}`,
      agentId,
    ).catch(() => { /* the run goes on; the notice is a courtesy */ })
  }
  return { status: 200, body: { run: describeRun(res.run, wf), built, awaitingApproval: !!res.awaitingApproval, ...(res.error ? { warning: res.error } : {}) } }
}

function stepList(wf: Workflow): Array<{ id: string; type: string }> {
  return wf.nodes.filter((n) => !n.type.startsWith("trigger.") && n.type !== "end").map((n) => ({ id: n.id, type: n.type }))
}
