import type { LearnedRow, LearnedTemplateStore } from "./learned"

// --- The owner's view of learned templates (#1892 phase 8) ---
//
//   GET  /situations/learned          the drafts and their verdicts
//   POST /situations/learned/retire   take one back ({"id": "learned.x"})
//   POST /situations/learned/approver name the approver ({"agent": "x"})
//   POST /situations/learned/reset    start over when the sealed state
//                                     cannot be trusted
//
// All answer callers on this machine only. The POSTs also need the
// operator key (the CLI sends it), and no agent turn's headers. There is
// no route that approves: only the approver's review, made by the daemon,
// does (learn.ts).

interface Reply { status: number; body: Record<string, unknown> }

export function learnedRowView(r: LearnedRow, inUse: boolean): Record<string, unknown> {
  return {
    id: r.id, base: r.base, title: r.title, when: r.when, rules: r.rules, noteGuidance: r.noteGuidance || null,
    status: r.status, inUse, evidence: r.evidence.length, why: r.why,
    createdAt: new Date(r.createdAt).toISOString(),
    reviewer: r.reviewer, verdictWhy: r.verdictWhy, decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    reviewAttempts: r.reviewAttempts, retiredAt: r.retiredAt ? new Date(r.retiredAt).toISOString() : null, retiredBy: r.retiredBy,
    sealed: r.sealed,
  }
}

export function learnedView(store: LearnedTemplateStore | undefined, ctx: { thisMachine: boolean; enabled: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const rows = store.list()
  return {
    status: 200,
    body: { enabled: ctx.enabled, approver: store.approver(), problem: store.problem(), templates: rows.map((r) => learnedRowView(r, ctx.enabled && !!store.template(r.id))) },
  }
}

/** The owner names the approver ({"agent": "<id>"}, or {"clear": true}).
 *  Same caller rules as retire. Sealed with the operator key: an agent
 *  that edits the database or agentx.json cannot name itself. */
export function learnedSetApprover(store: LearnedTemplateStore | undefined, body: Record<string, unknown>, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean; isAgent: (id: string) => boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner names the approver" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned approver <agent>` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  if (body.clear === true) { store.setApprover(null); return { status: 200, body: { ok: true, approver: null } } }
  const agent = typeof body.agent === "string" ? body.agent.trim() : ""
  if (!agent || !ctx.isAgent(agent)) return { status: 400, body: { error: `not an agent of this node: ${agent.slice(0, 60) || "(none)"}` } }
  if (!store.setApprover(agent)) return { status: 409, body: { error: store.problem() ?? "the approver could not be saved" } }
  return { status: 200, body: { ok: true, approver: agent } }
}

export function learnedRetire(store: LearnedTemplateStore | undefined, body: Record<string, unknown>, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner retires a learned template" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned retire <id>` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const row = id ? store.get(id) : null
  if (!row) return { status: 404, body: { error: `no learned template ${id.slice(0, 60) || "(no id)"}` } }
  if (!store.retire(id, "owner")) {
    const problem = store.problem()
    return { status: 409, body: { error: problem ? `${problem}; see \`agentx situation learned reset\`` : `${id} is ${row.status}; only a draft or an approved template can be retired` } }
  }
  return { status: 200, body: { ok: true, id } }
}

/** The owner starts over when the sealed state cannot be trusted (it was
 *  changed outside AgentX, or an older copy was put back). Same caller
 *  rules as retire. Refused while the state is sound. */
export function learnedReset(store: LearnedTemplateStore | undefined, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner resets learned templates" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned reset` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const problem = store.problem()
  if (!problem) return { status: 409, body: { error: "the sealed state is sound: nothing to reset (retire a template instead)" } }
  if (!store.reset()) return { status: 409, body: { error: "no operator key on this node (.agentx/operator.key)" } }
  return { status: 200, body: { ok: true, was: problem } }
}
