// --- Address by name: "Writer, what's the status" goes to Writer ---
//
// The voice widget talks to one target agent. Starting a sentence with
// another agent's name sends that one utterance to that agent and leaves
// the target alone. Names come from config: the agent's id, its `name`,
// and every `mentions` entry with the `@` dropped — the names it already
// answers to in chats. No new alias setting.
//
// Agents on healthy mesh peers count too (#266). Their names come from the
// peer's agent card: the skill's id and name, and its tags after the first
// (the tier), which carry the agent's `mentions`. /ask reaches them by
// their plain id, through VoiceMeshProxy.
//
// Only the first one or two words are looked at, so a name later in the
// sentence ("ask Writer later") never reroutes. No match, or more than one
// agent matching, keeps the target: a wrong guess is worse than none. The
// same name on two nodes is more than one agent.
//
// Speech to text mishears names (#509): "Nadia, …" comes back as "Radia,
// …". With no exact match, a first word set off by a comma or a pause
// that is one letter away from exactly one agent's name goes to that
// agent. A name that is often misheard in other ways goes in the agent's
// `mentions`, which is matched exactly.

import { presenceLook } from "./presence"
import { agentPalette } from "./orb-palettes"

export interface Addressable {
  id: string
  name?: string
  mentions?: string[]
  /** The mesh peer hosting it; unset for an agent on this node. */
  node?: string
  /** "#RRGGBB" the agent's own node gave it, when it sent one. */
  color?: string
}

const norm = (s: string) =>
  s.toLowerCase().replace(/^@/, "").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim()

/** One edit apart: a letter changed, added or dropped. */
export function oneLetterApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** Shortest name a near match is tried on: below this, one letter is
 *  too much of the word ("Ava" and "Eva" are two people). */
const NEAR_MIN = 4

/** First words that are never taken for a misheard name. */
const COMMON = new Set(("okay well yeah yes sure right really maybe hello hey please thanks thank sorry also then "
  + "alors bien merci voila voilà donc ouais salut").split(" "))

/** The first word, when a comma or a pause sets it off from the rest. */
function leadingWord(text: string): string | null {
  const m = /^\s*@?([\p{L}\p{N}-]+)\s*[,،:;.!?…—–]/u.exec(text)
  return m ? norm(m[1]) : null
}

/** The one agent whose single-word name is one letter from the utterance's
 *  set-off first word; null when none is, or more than one. */
function nearAddressed<A extends Addressable>(text: string, agents: A[]): A | null {
  const word = leadingWord(text)
  if (!word || word.length < NEAR_MIN || COMMON.has(word)) return null
  const matched = new Map<string, A>()
  for (const agent of agents) {
    const names = [agent.id, agent.name ?? "", ...(agent.mentions ?? [])].map(norm)
    if (names.some((n) => n.length >= NEAR_MIN && !n.includes(" ") && oneLetterApart(word, n))) {
      matched.set(`${agent.node ?? ""}\u0000${agent.id}`, agent)
    }
  }
  return matched.size === 1 ? [...matched.values()][0] : null
}

/** The one agent the utterance starts by naming, or null when it names
 *  none or more than one. A name one letter off counts only when no name
 *  matches exactly; see nearAddressed. */
export function findAddressed<A extends Addressable>(text: string, agents: A[]): A | null {
  return exactAddressed(text, agents) ?? (anyExact(text, agents) ? null : nearAddressed(text, agents))
}

/** True when the first one or two words name any agent exactly, even
 *  several: an ambiguous exact name is not then guessed at. */
function anyExact(text: string, agents: Addressable[]): boolean {
  const words = norm(text).split(" ").filter(Boolean)
  const leads = [words.slice(0, 2).join(" "), words[0] ?? ""].filter(Boolean)
  return agents.some((a) => [a.id, a.name ?? "", ...(a.mentions ?? [])].map(norm).some((n) => leads.includes(n)))
}

function exactAddressed<A extends Addressable>(text: string, agents: A[]): A | null {
  const words = norm(text).split(" ").filter(Boolean)
  // Two words first, so "Dev Session, …" is not read as "Dev".
  for (const lead of [words.length > 1 ? words.slice(0, 2).join(" ") : "", words[0] ?? ""]) {
    if (!lead) continue
    const matched = new Map<string, A>()
    for (const agent of agents) {
      const names = [agent.id, agent.name ?? "", ...(agent.mentions ?? [])].map(norm)
      // Keyed by node too: the same id on two peers is two agents.
      if (names.includes(lead)) matched.set(`${agent.node ?? ""}\u0000${agent.id}`, agent)
    }
    if (matched.size === 1) return [...matched.values()][0]
    if (matched.size > 1) return null
  }
  return null
}

/** The agent the utterance is addressed to, or `target` when none is. */
export function addressedAgent(text: string, agents: Addressable[], target: string): string {
  return findAddressed(text, agents)?.id ?? target
}

/** The part of A2AMesh.directory() addressing needs. */
export type AddressDirectory = Array<{
  peer: string
  healthy: boolean
  skills: Array<{ id: string; name?: string; tags?: string[]; color?: string }>
}>

/**
 * Agents on healthy peers, as names to match. An id that is also local is
 * left out: /ask answers it here, so the local agent is the one named.
 */
export function meshAddressables(directory: AddressDirectory, isLocal: (id: string) => boolean): Addressable[] {
  const out: Addressable[] = []
  for (const peer of directory) {
    if (!peer.healthy) continue
    for (const s of peer.skills) {
      if (!s.id || isLocal(s.id)) continue
      out.push({
        id: s.id,
        name: s.name || s.id,
        // tags[0] is the tier ("claude-code"); the rest are mentions.
        mentions: (s.tags ?? []).slice(1),
        node: peer.peer,
        color: s.color,
      })
    }
  }
  return out
}

/** What POST /voice/address answers: who, and how to show them. */
export interface AddressReply {
  agentId: string
  name: string
  /** "#RRGGBB": the agent's own, else derived from its id. */
  color: string
  palette: { id: string; colors: string[] }
  /** This node's id for a local agent, else the peer's name. */
  node: string
  /** On a mesh peer: /ask reaches it through VoiceMeshProxy. */
  remote: boolean
  /** True when the words named another agent; false keeps the target. */
  addressed: boolean
}

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * The agent the words go to, local or on a peer, with its name, colour and
 * node, so the widget can show a remote agent it has no /agents row for.
 * With nobody named, the target is described the same way.
 */
export function resolveAddress(opts: {
  text: string
  target: string
  local: Addressable[]
  remote: Addressable[]
  localNode: string
  /** A local agent's look (presence.color / presence.palette).
   *  `colorSet` false: the colour is the one derived from its id. */
  localLook?: (id: string) => { color?: string; palette?: string; colorSet?: boolean } | undefined
  /** voice.palette: for an agent that chose neither palette nor colour. */
  defaultPalette?: string
}): AddressReply {
  const found = findAddressed(opts.text, [...opts.local, ...opts.remote])
  const agent = found
    ?? opts.local.find((a) => a.id === opts.target)
    ?? opts.remote.find((a) => a.id === opts.target)
    ?? { id: opts.target }
  const look = agent.node ? undefined : opts.localLook?.(agent.id)
  const given = look?.color ?? agent.color
  // The same hash fallback as GET /agents and the app (OrbMath.colorHex).
  const color = given && HEX.test(given) ? given : presenceLook(agent.id).color
  const palette = agentPalette({ palette: look?.palette, color: look?.colorSet === false ? undefined : given }, opts.defaultPalette)
  return {
    agentId: agent.id,
    name: agent.name || agent.id,
    color,
    palette: { id: palette.id, colors: [...palette.colors] },
    node: agent.node ?? opts.localNode,
    remote: !!agent.node,
    addressed: !!found && found.id !== opts.target,
  }
}
