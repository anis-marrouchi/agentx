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
//
// Roles (#453): `owner` runs this install; `member` is a teammate; `client`
// is someone the owner does work for, who gets a page of their own
// (/member shows "Your project" instead of "My work"); `guest` is the
// operator of another organisation's mesh. Only `owner` changes what a
// turn may do; the other three are told apart on the pages they see.

export type PersonRole = "owner" | "member" | "client" | "guest"
export const PERSON_ROLES: readonly PersonRole[] = ["owner", "member", "client", "guest"]

export interface Person {
  id: string
  name: string
  /** How their name is said aloud (#433); see voice.pronunciations. */
  say?: string
  role: PersonRole
  /** "channel:id" entries: a login, a Telegram id, a WhatsApp number. */
  identities: string[]
  /** The agents this person may reach. Empty: every agent (#379). */
  agents?: string[]
  /** Tools and skills this person's turns may not use (#379). */
  deny?: PersonDeny
}

/** One list per level of control. A further level is a new key. */
export interface PersonDeny {
  tools?: string[]
  skills?: string[]
}

/** The person a turn is stamped with. `role` is set only on a turn this
 *  node resolved itself; an id carried by a root has none. */
export interface PersonRef {
  id: string
  role?: PersonRole
}

/** The owner's id on an install that lists no owner. */
export const IMPLICIT_OWNER = "owner"

/** The name shown for a stored person id: the listed name, "Owner" for the
 *  built-in owner, else the id (a person removed from the list since). */
export function personName(people: Person[], id: string): string {
  return people.find((p) => p.id === id)?.name ?? (id === IMPLICIT_OWNER ? "Owner" : id)
}

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

// ── Permissions, first slice: per agent (#379) ───────────────────────────
//
// A listed person may be limited to named agents. The default is open:
// a person with no list reaches every agent, and an unknown sender is
// not limited here (channels decide who they answer at all). The limit
// follows the person through a delegation too: work they started cannot
// reach an agent they may not talk to. An owner is never limited: their
// own surfaces (voice, app, dashboard) must keep reaching every agent.

/** May this person reach `agentId`? */
export function agentAllowed(person: Pick<Person, "agents" | "role">, agentId: string): boolean {
  const list = person.agents ?? []
  return person.role === "owner" || list.length === 0 || list.includes(agentId)
}

/** Who a refused turn belongs to and the note it is answered with, or null
 *  when the turn may run. The note names what the person can reach instead,
 *  so the refusal is not a dead end. */
export function refusedPerson(people: Person[], agentId: string, ctx: InitiatorContext | undefined | null): { person: Person; note: string } | null {
  const ref = personOfTurn(people, ctx)
  if (!ref) return null
  const person = people.find((p) => p.id === ref.id)
  if (!person || agentAllowed(person, agentId)) return null
  const list = (person.agents ?? []).join(", ")
  return { person, note: `${person.name}, you can reach ${list} here, not ${agentId}. Ask the owner if you need ${agentId}.` }
}

/** The note alone. */
export function personRefusal(people: Person[], agentId: string, ctx: InitiatorContext | undefined | null): string | null {
  return refusedPerson(people, agentId, ctx)?.note ?? null
}

// ── Permissions: per tool and per skill (#379) ───────────────────────────
//
// A listed person may be denied named tools and skills. Same rules as the
// per-agent limit: open by default, never an owner, and it follows the
// person through a delegation (the root's person id). Unlike a refused
// agent, the turn still runs: the limit is a hard one, enforced on every
// tool call by a per-run hook (guard/person-limits), not an instruction.

/** The limits one run carries to the hook. */
export interface PersonLimits {
  personId: string
  name: string
  tools: string[]
  skills: string[]
}

/** Case-insensitive name match; `*` stands for any run of characters. */
export function nameMatches(pattern: string, name: string): boolean {
  const re = pattern.trim().split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${re}$`, "i").test(name.trim())
}

/** The limits a turn runs under, or null when it has none. */
export function personLimitsOf(people: Person[], ctx: InitiatorContext | undefined | null): PersonLimits | null {
  const ref = personOfTurn(people, ctx)
  if (!ref) return null
  const person = people.find((p) => p.id === ref.id)
  if (!person || person.role === "owner") return null
  const tools = person.deny?.tools ?? []
  const skills = person.deny?.skills ?? []
  if (!tools.length && !skills.length) return null
  return { personId: person.id, name: person.name, tools: [...tools], skills: [...skills] }
}
