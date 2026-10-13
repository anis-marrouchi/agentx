import { listCards } from "@/approvals/cards"
import { listInbox, planStoreFor, requestStoreFor, type InboxContext } from "@/approvals/inbox"
import { readInboxState } from "@/approvals/state"
import { summarize } from "@/requests/card-view"
import type { RequestRecord, RequestStore } from "@/requests/store"
import type { PlanStore } from "@/requests/plan-store"
import { clip, DONE_DAYS, DONE_MAX, type DeskClosedCard, type DeskRequest, type DeskSource } from "./card"

// --- What one machine holds for the desk ---
//
// Read on the machine the sources live on (the dashboard beside the
// daemon), in bounded summary form, and joined into cards by buildDesk.
// Reads only: every write goes through act.ts and the source's own
// function.

/** One request, trimmed: the start of the owner's words, never the whole. */
export function deskRequest(r: RequestRecord, store: Pick<RequestStore, "links" | "lastAnswer">, plans?: Pick<PlanStore, "get" | "steps"> | null): DeskRequest {
  const links = store.links(r.id)
  const answer = store.lastAnswer(r.id)
  const plan = plans?.get(r.id) ? plans.steps(r.id) : null
  return {
    id: r.id,
    state: r.state,
    agentId: r.agentId,
    summary: summarize(r.text),
    question: r.question,
    attentionReason: r.attentionReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
    evidence: r.evidence,
    closeReason: r.closeReason,
    runs: links.filter((l) => l.kind === "run").map((l) => l.ref),
    cards: links.filter((l) => l.kind === "card").map((l) => l.ref),
    lastAnswer: answer ? { text: clip(answer.text) ?? "", at: answer.at } : null,
    plan: plan && plan.length ? { done: plan.filter((s) => s.state === "done" || s.state === "skipped").length, total: plan.length } : null,
  }
}

export function readDeskSource(ctx: InboxContext): DeskSource {
  const now = ctx.now ?? Date.now()
  const since = now - DONE_DAYS * 86_400_000
  const errors: string[] = []
  const listing = listInbox(ctx, { includeSnoozed: true })
  for (const e of listing.errors) errors.push(`${e.kind}: ${e.error}`)

  let requests: DeskRequest[] = []
  try {
    const store = requestStoreFor(ctx)
    const plans = planStoreFor(ctx)
    if (store) requests = [...store.listOpen(), ...store.listClosedSince(since, DONE_MAX)].map((r) => deskRequest(r, store, plans))
  } catch (e: any) {
    errors.push(`requests: ${String(e?.message ?? e).slice(0, 200)}`)
  }

  let closedCards: DeskClosedCard[] = []
  try {
    closedCards = listCards(ctx.root)
      .filter((c) => c.status !== "pending")
      .map((c): DeskClosedCard => ({
        id: c.id,
        title: c.title,
        raisedBy: c.raised_by,
        status: c.status as DeskClosedCard["status"],
        ...(c.verdict ? { verdict: c.verdict } : {}),
        ...(c.choice ? { choice: c.choice } : {}),
        ...(c.outcome ? { outcome: c.outcome } : {}),
        createdAt: c.created_at,
        closedAt: c.decided_at ?? c.created_at,
      }))
      .filter((c) => Date.parse(c.closedAt) >= since)
      .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
      .slice(0, DONE_MAX)
  } catch (e: any) {
    errors.push(`cards: ${String(e?.message ?? e).slice(0, 200)}`)
  }

  const deferred: Record<string, string> = {}
  for (const [k, v] of Object.entries(readInboxState(ctx.root).snoozed)) if (Date.parse(v) > now) deferred[k] = v

  return { items: listing.items, requests, closedCards, deferred, ...(errors.length ? { errors } : {}) }
}
