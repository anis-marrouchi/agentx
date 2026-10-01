import { classifyInitiator, propagatedRootOf, type InitiatorContext } from "@/a2a/initiator"
import { OPERATOR_CHANNELS } from "@/requests/tracker"
import { isOperatorTurn } from "@/requests/operator"

// --- People: one identity per human, whatever channel they use (#384) ---
//
// `people` in agentx.json lists the humans who talk to the agents. Each has
// channel identities written "channel:id" ("gitlab:sara", "whatsapp:21620123456").
// A turn a person starts is stamped with that person's id; the id travels
// with the root initiator across agents and mesh peers.
//
// The rules:
//   - Only platform ids and logins are matched. Display names never are:
//     anyone can pick one.
//   - A sender that matches nobody is unknown (null). Never guessed.
//   - This machine's own surfaces (voice, app, dashboard) are the owner.
//     With no owner listed that is the built-in person "owner", so an
//     install with no `people` needs nothing configured.
//   - Turns software starts (cron, workflows, agent comments) have no person.

export type PersonRole = "owner" | "member" | "guest"

export interface Person {
  id: string
  name: string
  role: PersonRole
  /** "channel:id" entries: a login, a Telegram id, a WhatsApp number. */
  identities: string[]
}

/** The person a turn is stamped with. `role` is set only on a turn this
 *  node resolved itself; an id carried by a root has none. */
export interface PersonRef {
  id: string
  role?: PersonRole
}

/** The owner's id on an install that lists no owner. */
export const IMPLICIT_OWNER = "owner"

const base = (channel: string) => channel.toLowerCase().split("@")[0]

/** One comparable form per channel. WhatsApp numbers compare on digits, so
 *  "+216 20 123 456" and "21620123456@s.whatsapp.net" are the same. */
function normalize(channel: string, value: string): string {
  const v = value.trim().toLowerCase()
  return channel === "whatsapp" ? v.replace(/@.*$/, "").replace(/\D/g, "") : v.replace(/^@/, "")
}

export function splitIdentity(identity: string): { channel: string; value: string } | null {
  const i = identity.indexOf(":")
  if (i <= 0 || i === identity.length - 1) return null
  const channel = base(identity.slice(0, i).trim())
  const value = normalize(channel, identity.slice(i + 1))
  return value ? { channel, value } : null
}

/** What is wrong with a `people` list, or null. */
export function peopleProblem(people: Person[]): string | null {
  const ids = new Set<string>()
  const claimed = new Map<string, string>()
  for (const p of people) {
    if (ids.has(p.id)) return `person "${p.id}" is listed twice`
    ids.add(p.id)
    if (p.id === IMPLICIT_OWNER && p.role !== "owner") return `the id "${IMPLICIT_OWNER}" is kept for a person with the owner role`
    for (const identity of p.identities) {
      const parts = splitIdentity(identity)
      if (!parts) return `identity "${identity}" of "${p.id}" must be written channel:id`
      const key = `${parts.channel}:${parts.value}`
      const other = claimed.get(key)
      if (other && other !== p.id) return `identity "${identity}" belongs to both "${other}" and "${p.id}"`
      claimed.set(key, p.id)
    }
  }
  return null
}

/** The person behind a sender on a channel, or null when nobody matches. */
export function resolvePerson(
  people: Person[],
  channel: string,
  sender: { id?: string; username?: string } | undefined,
): Person | null {
  const ch = base(channel)
  // On WhatsApp `username` is the chat's number, which for a message the
  // account owner sends is the other person. Only `id` is the sender.
  const given = ch === "whatsapp" ? [sender?.id] : [sender?.id, sender?.username]
  const ids = given.filter((v): v is string => typeof v === "string" && !!v).map((v) => normalize(ch, v)).filter(Boolean)
  if (!ids.length) return null
  return people.find((p) => p.identities.some((identity) => {
    const parts = splitIdentity(identity)
    return !!parts && parts.channel === ch && ids.includes(parts.value)
  })) ?? null
}

/** Who is at this machine's own surfaces. Two listed owners cannot be told
 *  apart there, so the answer is nobody. */
export function operatorPerson(people: Person[]): PersonRef | null {
  const owners = people.filter((p) => p.role === "owner")
  if (owners.length === 0) return { id: IMPLICIT_OWNER, role: "owner" }
  return owners.length === 1 ? { id: owners[0].id, role: "owner" } : null
}

/** The person who started the chain this turn belongs to. A delegated hop
 *  takes the id from the root it carries, with no role: a root is not
 *  authenticated (a caller of the daemon's API or a mesh peer writes it), and
 *  ids are per machine. A root turn is resolved here from the channel's own
 *  sender fields. `context.person` is never read, for the same reason. */
export function personOfTurn(people: Person[], ctx: InitiatorContext | undefined | null): PersonRef | null {
  const root = propagatedRootOf(ctx)
  if (root) return root.person ? { id: root.person } : null
  if (!ctx || classifyInitiator(ctx) !== "human") return null
  const channel = String(ctx.channel ?? "")
  // This node's own surfaces name the operator only when the daemon marked
  // the turn as theirs (requests/operator, #393): a /task caller can name
  // the channel, not the person.
  if (OPERATOR_CHANNELS.has(base(channel))) return isOperatorTurn(ctx) ? operatorPerson(people) : null
  const str = (v: unknown) => (typeof v === "string" ? v : undefined)
  const person = resolvePerson(people, channel, { id: str(ctx.senderId), username: str(ctx.senderUsername) })
  return person ? { id: person.id, role: person.role } : null
}
