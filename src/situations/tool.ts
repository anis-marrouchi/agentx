import { callerHeaders } from "@/calls/service"
import { SITUATION_TEMPLATES } from "./templates"

// --- agentx_situation: the agent names its own talk (#1892, phase 6) ---
//
// The MCP tool the chat's agent calls in its turn: "this chat is a meeting
// with an outside party about X". It sends only the template, the purpose
// and an optional closing message, with the turn's proof headers
// (AGENTX_TASK_ID, or AGENTX_CHANNEL and AGENTX_CHAT_ID). The daemon finds
// the chat from that proof (POST /situations/fill); a chat named in the
// arguments is never sent.

export interface SituationToolDeps {
  daemonUrl: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  env?: NodeJS.ProcessEnv
}

export const SITUATION_TOOL_DESCRIPTION =
  "Name the situation of the chat you are answering in, once, in your turn: a meeting with an outside party (an interview, a client meeting), a hand-off, or a change on a live system. " +
  "It adds that situation's rules to your context and, when the talk ends, its closing steps: a note to the owner, each follow-up an open promise, one message to the owner. " +
  "Give `template` and `purpose` (a few words). `message` is an optional closing message to the other side; the owner is always asked before it is sent. " +
  "You cannot pick where the note is posted or who else owns follow-ups, and you cannot change what a person set. `list: true` shows the templates."

export const SITUATION_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    template: { type: "string", enum: SITUATION_TEMPLATES.filter((t) => t.agentMay).map((t) => t.id), description: "The kind of talk." },
    purpose: { type: "string", description: "What the talk is, in a few words, e.g. \"job interview for the support role\"." },
    message: { type: "string", description: "Optional closing message to the other side once the talk ends. Always asked of the owner first." },
    list: { type: "boolean", description: "Only list the templates." },
  },
}

export async function runSituationTool(args: Record<string, unknown>, deps: SituationToolDeps): Promise<string> {
  if (args.list === true) {
    return SITUATION_TEMPLATES.filter((t) => t.agentMay)
      .map((t) => `${t.id}: ${t.title}.${t.rules.during ? ` ${t.rules.during}` : ""}`)
      .join("\n")
  }
  const env = deps.env ?? process.env
  const body: Record<string, unknown> = {
    agentId: env.AGENTX_AGENT_ID ?? "",
    template: String(args.template ?? ""),
    purpose: String(args.purpose ?? ""),
    ...(typeof args.message === "string" && args.message.trim() ? { message: args.message } : {}),
  }
  const res = await deps.fetch(`${deps.daemonUrl}/situations/fill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...callerHeaders(env) },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; closingSteps?: boolean; messageKept?: boolean; row?: { template?: string } }
  if (!res.ok || data.error) return `Error: ${data.error ?? res.statusText}`
  const steps = data.closingSteps ? " Its closing steps run when it ends." : " No closing steps on this node (situations.closing is off)."
  const lost = data.messageKept === false ? " Your closing message was not kept: this chat cannot be sent to from here; tell the owner instead." : ""
  return `This talk is now "${data.row?.template ?? body.template}".${steps}${lost}`
}
