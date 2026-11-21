import { notify, type LocalAlert, type Sender } from "@/notify"
import { noticeRuleBreak, withTodo } from "@/approvals/screen-gate"

// --- A push to the owner, shared by `agentx notify` and the daemon ---
//
// `agentx notify` posts to the daemon's POST /send; the daemon itself (the
// battery sensor, #863) calls the same gated send in process. Both build
// the text, the told-the-owner fields (#1126) and the title line the same
// way, so a sensor's urgent push is the push `agentx notify --urgent` sends.

/** What the told-the-owner gate is told about a notice (#1126). */
export function noticeTold(opts: { key?: string; request?: string; digest?: boolean; urgent?: boolean; from: string }): Record<string, unknown> {
  return {
    ...(opts.key ? { key: String(opts.key) } : {}),
    ...(opts.request ? { requestId: String(opts.request) } : {}),
    ...(opts.digest ? { kind: "nag" } : {}),
    ...(opts.urgent ? { urgent: true } : {}),
    // A notice: the same words again within the window are a repeat.
    textKey: true,
    from: opts.from,
  }
}

/** The push and ntfy adapters take the title from the first line of the
 *  text, so the title is prepended rather than sent as its own field. */
export function titledText(title: string | undefined, message: string): string {
  return title && !message.startsWith(title) ? `${title}\n${message}` : message
}

/** What POST /send answers: sent, or kept back by the told gate. */
export interface GatedSendAnswer { sent: boolean; told?: string }

export interface OwnerPush {
  message: string
  todo?: string
  title: string
  from: string
  key?: string
  priority: number
  urgent: boolean
}

export type OwnerPushResult = { ok: true; reason: string } | { ok: false; why: string }

/**
 * Send one push the way `agentx notify` does: the To do line, the screen
 * rule (#394), the told fields, then notify() (Focus, local banner). A
 * notice the told gate keeps back counts as not sent, as the battery
 * script counts "not sent". Never throws.
 */
export async function pushToOwner(
  push: OwnerPush,
  deps: { post: (body: Record<string, unknown>) => Promise<GatedSendAnswer>; channel: string; chatId?: string; alert: LocalAlert | false },
): Promise<OwnerPushResult> {
  const text = withTodo(push.message.trim(), push.todo)
  const broken = noticeRuleBreak(push.title, text)
  if (broken) return { ok: false, why: `not sent: ${broken}` }
  const told = noticeTold({ key: push.key, urgent: push.urgent, from: push.from })
  let keptBack: string | null = null
  const send: Sender = async ({ title, message, channel, chatId }) => {
    const answer = await deps.post({ channel: channel ?? deps.channel, chatId: chatId ?? deps.chatId ?? "default", text: titledText(title, message), told })
    keptBack = answer.sent === false ? answer.told ?? "kept back" : null
  }
  const alert: LocalAlert | false = deps.alert === false ? false : async (t, m) => { if (!keptBack) await (deps.alert as LocalAlert)(t, m) }
  try {
    const result = await notify(
      { message: text, from: push.from, title: push.title, priority: push.priority, urgent: push.urgent, channel: deps.channel, chatId: deps.chatId ?? "default" },
      send,
      { alert },
    )
    if (keptBack) return { ok: false, why: `not sent (${keptBack})` }
    if (!result.delivered) return { ok: false, why: result.reason }
    return { ok: true, reason: result.reason }
  } catch (e: any) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 200) }
  }
}
