import type { LearnedRow, LearnedTemplateStore } from "./learned"
import type { LearnedCards } from "./learned-card"

// --- The owner's view of learned templates (#1892 phase 8, #1990) ---
//
//   GET  /situations/learned          the drafts, the owner's answers, the
//                                     open card and whether learning paused
//   POST /situations/learned/answer   the owner's yes or no to a draft on
//                                     this week's card ({"id", "answer"})
//   POST /situations/learned/retire   take one back ({"id": "learned.x"})
//   POST /situations/learned/resume   start learning again after a pause
//   POST /situations/learned/reset    start over when the sealed state
//                                     cannot be trusted
//
// All answer callers on this machine only. The POSTs also need the
// operator key (the CLI sends it), and no agent turn's headers. Only the
// owner approves: here with the operator key, or in the daemon's own
// popup (learned-card.ts). No agent and no model does.

interface Reply { status: number; body: Record<string, unknown> }

export function learnedRowView(r: LearnedRow, inUse: boolean): Record<string, unknown> {
  return {
    id: r.id, base: r.base, title: r.title, when: r.when, rules: r.rules, noteGuidance: r.noteGuidance || null,
    status: r.status, inUse, evidence: r.evidence.length, why: r.why,
    createdAt: new Date(r.createdAt).toISOString(),
    decidedBy: r.reviewer, decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    retiredAt: r.retiredAt ? new Date(r.retiredAt).toISOString() : null, retiredBy: r.retiredBy,
    sealed: r.sealed,
  }
}

export function learnedView(store: LearnedTemplateStore | undefined, ctx: { thisMachine: boolean; enabled: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const rows = store.list()
  return {
    status: 200,
    body: {
      enabled: ctx.enabled, problem: store.problem(), card: store.openCard(), paused: store.paused() ? new Date(store.paused()!).toISOString() : null,
      unansweredCards: store.unansweredCards(), templates: rows.map((r) => learnedRowView(r, ctx.enabled && !!store.template(r.id))),
    },
  }
}

/** The owner's yes or no to one draft on this week's card ({"id":
 *  "learned.x", "answer": "yes" | "no"}). Same caller rules as retire:
 *  this machine, the operator key, no agent turn. Once every draft of the
 *  card is answered, the card closes. */
export function learnedAnswer(store: LearnedTemplateStore | undefined, body: Record<string, unknown>, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean; cards?: LearnedCards }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner answers learned drafts" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned answer <id> yes|no` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const answer = typeof body.answer === "string" ? body.answer.trim().toLowerCase() : ""
  if (answer !== "yes" && answer !== "no") return { status: 400, body: { error: "answer must be yes or no" } }
  const r = store.answer(id, answer === "yes")
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  if (r.cardDone) ctx.cards?.close(r.cardId, "answered")
  return { status: 200, body: { ok: true, id, answer, cardDone: r.cardDone } }
}

/** The owner starts learning again after it paused itself. Same caller
 *  rules as retire. */
export function learnedResume(store: LearnedTemplateStore | undefined, ctx: { thisMachine: boolean; keyShown: boolean; agentProof: boolean }): Reply {
  if (!ctx.thisMachine) return { status: 403, body: { error: "learned templates answer only on this machine" } }
  if (ctx.agentProof) return { status: 403, body: { error: "only the owner resumes learning" } }
  if (!ctx.keyShown) return { status: 403, body: { error: "run `agentx situation learned resume` from the AgentX folder (it sends the operator key in .agentx/operator.key)" } }
  if (!store) return { status: 503, body: { error: "learned templates are not available on this node" } }
  const was = store.paused()
  if (!store.resume()) return { status: 409, body: { error: store.problem() ?? "could not be saved" } }
  return { status: 200, body: { ok: true, wasPaused: was !== null } }
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
