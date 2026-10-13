import { decide, listInbox, parseKey, requestStoreFor, type InboxContext, type InboxItem } from "@/approvals/inbox"
import { snooze } from "@/approvals/state"
import { handleRequestsPanel, REQUESTS_PANEL_PREFIX } from "@/daemon/requests-panel"
import { DESK_ACTIONS, type DeskAction } from "./card"

// --- The four things the owner can do on a desk card ---
//
//   answer  pick one of the card's options; it goes through the source's
//           own function (inbox decide, which records who and when)
//   write   words to the agent that has a request; it goes on with them
//           (the requests reply: a hand-off to the same agent)
//   defer   hide the card until a time; the card still expires on time
//           (the inbox's "later" state)
//   call    the agent that owns the card rings the owner about it (a call
//           row, with the calls allow list, Focus and hourly limit)
//
// Each action has one effect and one record, kept by the source. An action
// on a card that is no longer waiting is refused. Owner surfaces only: the
// phone app, the dashboard's admin routes and the CLI.

export interface DeskActInput {
  key: string
  action: DeskAction
  /** answer: the option id ("yes", "no", or a choice's number). */
  option?: string
  text?: string
  /** call on a running turn (`task:` keys): the agent running it. */
  agent?: string
}

export type DeskActResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string }

export interface DeskActDeps {
  /** Who acted, for the source's record: "operator (phone: …)". */
  by: string
  /** defer: how long. The approvals `laterHours` setting. */
  laterHours: number
  /** Ring the owner from this agent (the daemon's /calls/owner). */
  callAgent?: (agentId: string, reason: string) => Promise<DeskActResult>
}

export const CALL_REASON_MAX = 200
const TEXT_MAX = 4000

const fail = (status: number, error: string): DeskActResult => ({ ok: false, status, error })

export function parseDeskAct(body: Record<string, unknown>): DeskActInput | string {
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const action = body.action as DeskAction
  if (!key || !DESK_ACTIONS.includes(action)) return "send { key, action: answer | write | defer | call }"
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const text = typeof body.text === "string" && body.text.trim() ? body.text.trim().slice(0, TEXT_MAX) : undefined
  const option = typeof body.option === "number" ? String(body.option) : str(body.option)
  return {
    key, action,
    ...(option ? { option } : {}),
    ...(text ? { text } : {}),
    ...(str(body.agent) ? { agent: str(body.agent) } : {}),
  }
}

/** The waiting inbox item for this key, snoozed or not. */
function waiting(ctx: InboxContext, key: string): InboxItem | undefined {
  return listInbox(ctx, { includeSnoozed: true }).items.find((i) => i.key === key)
}

export async function deskAct(ctx: InboxContext, input: DeskActInput, deps: DeskActDeps): Promise<DeskActResult> {
  const now = ctx.now ?? Date.now()
  const task = input.key.startsWith("task:") ? input.key.slice(5) : null
  const parsed = task ? null : parseKey(input.key)
  if (!task && !parsed) return fail(400, `unknown card "${input.key}"`)
  const store = parsed?.kind === "request" ? requestStoreFor(ctx) : null
  const request = parsed?.kind === "request" ? store?.get(parsed.ref) ?? null : null
  const item = parsed ? waiting(ctx, input.key) : undefined
  const gone = fail(409, `not waiting any more: ${input.key}`)

  switch (input.action) {
    case "answer": {
      if (!input.option) return fail(400, "pick an option")
      if (parsed?.kind === "request") {
        if (!request || request.state !== "needs_attention") return gone
        // Hand it back with the owner's words: the reply route says them to the agent.
        if (input.option === "yes" && input.text) return reply(ctx, request.id, input.text)
      } else if (!item) {
        return parsed ? gone : fail(400, "a running turn has no question to answer")
      }
      const verdict = input.option === "no" ? "no" : "yes"
      const choice = /^\d+$/.test(input.option) ? Number(input.option) : undefined
      if (verdict === "yes" && input.option !== "yes" && choice === undefined) return fail(400, `no option "${input.option}" on ${input.key}`)
      const r = await decide(ctx, input.key, verdict, {
        by: deps.by,
        ...(choice !== undefined ? { choice } : {}),
        // A card's suggested message, as edited, is the text; any other words are a note.
        ...(input.text && item?.draft && verdict === "yes" ? { text: input.text } : input.text ? { note: input.text } : {}),
      })
      return r.ok ? { ok: true, message: r.message } : fail(409, r.error)
    }

    case "write": {
      if (!input.text) return fail(400, "write something first")
      if (parsed?.kind !== "request") return fail(400, "this card's question has options: answer it, and add your words there")
      if (!request || !["in_progress", "waiting_owner", "waiting_other", "needs_attention"].includes(request.state)) return gone
      return reply(ctx, request.id, input.text)
    }

    case "defer": {
      if (!parsed) return fail(400, "only a card waiting for you can be put off")
      const until = new Date(now + Math.max(1, deps.laterHours || 24) * 3_600_000)
      if (item) {
        const r = await decide(ctx, input.key, "later", { laterHours: deps.laterHours, by: deps.by })
        return r.ok ? { ok: true, message: `Put off until ${until.toISOString()}` } : fail(409, r.error)
      }
      // A question an agent asked without a decision card: the same "later" state.
      if (request && request.state === "waiting_owner") {
        snooze(ctx.root, input.key, until, now)
        return { ok: true, message: `Put off until ${until.toISOString()}` }
      }
      return gone
    }

    case "call": {
      if (!deps.callAgent) return fail(501, "calls are not reachable from here")
      const agent = task ? input.agent : request?.agentId ?? item?.raised_by
      if (!agent) return task ? fail(400, "send the agent running this turn") : gone
      const about = request ? request.text : item?.title ?? input.key
      const reason = `The owner asks about ${input.key}: ${about.replace(/\s+/g, " ").trim()}`
      return deps.callAgent(agent, reason.length > CALL_REASON_MAX ? `${reason.slice(0, CALL_REASON_MAX - 1)}…` : reason)
    }
  }
}

async function reply(ctx: InboxContext, id: string, text: string): Promise<DeskActResult> {
  const r = await handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/reply`, { id, text }, ctx)
  const body = r.body as { message?: string; error?: string }
  return r.status === 200 ? { ok: true, message: body.message ?? "Sent" } : fail(r.status, body.error ?? `HTTP ${r.status}`)
}
