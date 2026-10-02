// Who or what started a piece of work: the Activity map's first column,
// "Initiator" (#432). Three kinds:
//
//   person    a listed person (people, #384), the owner, or an unknown sender
//   agentx    work the system starts itself: a schedule, a workflow step,
//             an agent acting on its own
//   external  an outside service that is not a person: a webhook, an API
//             caller, a bot account on a forge, a guest mesh
//
// A person is named only on what the people rules prove (people.ts): a
// platform id or login for a channel, the daemon's own mark for this
// machine's surfaces, the root a delegated hop carries. A sender that
// matches nobody is "Unknown", never guessed.

import { classifyInitiator, HUMAN_CHANNELS, isAgentSender, propagatedRootOf } from "@/a2a/initiator"
import { personName, personOfTurn, resolvePerson, type Person } from "@/people/people"

export type StarterKind = "person" | "agentx" | "external"

export interface DispatchStarter {
  kind: StarterKind
  /** "person:<id>", "unknown", "agentx" or "ext:<channel>". */
  id: string
  name: string
}

export const AGENTX_STARTER: DispatchStarter = { kind: "agentx", id: "agentx", name: "AgentX" }
export const UNKNOWN_STARTER: DispatchStarter = { kind: "person", id: "unknown", name: "Unknown" }

/** Channels only AgentX itself writes on. */
const INTERNAL_CHANNELS: ReadonlySet<string> = new Set([
  "cron", "workflow", "a2a", "mcp", "mesh", "events", "reminder", "heartbeat", "system", "internal", "business",
])

/** A forge account that is software: a GitHub app, a GitLab access-token bot. */
const isBot = (login: unknown) => typeof login === "string" && /\[bot\]$|^(project|group)_\d+_bot/i.test(login)

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined

/** The sender of an event stored as its channel's own payload (a chat
 *  message, a forge webhook, either one wrapped by a workflow trigger). */
function senderOf(source: string, channel: string, raw: any): { id?: string; username?: string; name?: string } | null {
  const payload = source === "workflow" ? raw?.event?.payload : raw
  const hook = payload?.issueEvent || payload?.webhookEvent
  const s = payload?.sender ?? hook?.sender ?? payload?.message?.from ?? payload?.user ?? hook?.user
  const id = str(s?.id) ?? (channel === "whatsapp" ? str(payload?.from) : undefined)
  const username = str(s?.username) ?? str(s?.login)
  return id || username ? { id, username, name: str(s?.name) } : null
}

export interface StarterInput {
  /** Where the event was stored from (mesh, cron, workflow, telegram, …). */
  source: string
  /** The channel the map shows for it. */
  channel: string
  raw: any
  people: Person[]
  channelLabel: (channel: string) => string
}

export function starterOf(i: StarterInput): DispatchStarter {
  const person = (id: string): DispatchStarter => ({
    kind: "person", id: `person:${id}`, name: personName(i.people, id),
  })
  const software = (channel: string, fromAgent: boolean): DispatchStarter =>
    fromAgent || INTERNAL_CHANNELS.has(channel) ? AGENTX_STARTER : { kind: "external", id: `ext:${channel}`, name: i.channelLabel(channel) }
  const raw = i.raw && typeof i.raw === "object" ? i.raw : {}

  // An inbound task: the daemon stored the context it arrived with, and
  // (since #432) the person it resolved while the proof was at hand. With
  // none stored, the context is read again: a person listed since then is
  // named, and an unproven turn on this machine's surfaces stays unknown.
  if (i.source === "mesh") {
    const ctx = raw.context && typeof raw.context === "object" ? raw.context : undefined
    const id = str(raw.person) ?? personOfTurn(i.people, ctx)?.id
    if (id) return person(id)
    const root = propagatedRootOf(ctx)
    const channel = root?.channel ?? i.channel
    if (classifyInitiator(ctx) === "human") return isBot(ctx?.senderUsername) ? software(channel, false) : UNKNOWN_STARTER
    const fromAgent = !!str(raw.senderAgentId) || isAgentSender(root ? root.sender : ctx?.sender)
    // The desktop assistant is one of this machine's own surfaces: with no
    // person recorded it is unknown, like voice.
    if (channel === "desktop" && !fromAgent) return UNKNOWN_STARTER
    return software(channel, fromAgent)
  }

  const sender = senderOf(i.source, i.channel, raw)
  if (!sender) return software(i.channel, false)
  const listed = resolvePerson(i.people, i.channel, sender)
  if (listed) return person(listed.id)
  // An agent's own post made with a person's account (forgeSender).
  if (isAgentSender(sender.name)) return AGENTX_STARTER
  return HUMAN_CHANNELS.has(i.channel) && !isBot(sender.username) ? UNKNOWN_STARTER : software(i.channel, false)
}
