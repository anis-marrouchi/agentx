import type { LearnedRow, LearnedTemplateStore } from "./learned"

// --- The owner's view of learned templates (#1892 phase 8) ---
//
//   GET  /situations/learned          the drafts and their verdicts
//   POST /situations/learned/retire   take one back ({"id": "learned.x"})
//
// Both answer callers on this machine only. Retiring also needs the
// operator key (`agentx situation learned retire` sends it), and no agent
// turn's headers: an agent cannot take back what the approver approved.
// There is no route that approves: only the approver's own review run,
// started by the daemon, does (learn.ts).

/** The channel name of the approver's review runs (traces, process list). */
export const LEARN_REVIEW_CHANNEL = "situation-learn"

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
    body: { enabled: ctx.enabled, templates: rows.map((r) => learnedRowView(r, ctx.enabled && !!store.template(r.id))) },
  }
}

export function learnedRetire(store: LearnedTemplateStore | undefined, body: Record<string, unknown>, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner retires a learned template" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned retire <id>` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const row = id ? store.get(id) : null
  if (!row) return { status: 404, body: { error: `no learned template ${id.slice(0, 60) || "(no id)"}` } }
  if (!store.retire(id, "owner")) return { status: 409, body: { error: `${id} is ${row.status}; only a draft or an approved template can be retired` } }
  return { status: 200, body: { ok: true, id } }
}
