// --- Per-agent voices, and when an agent should introduce itself ---
//
// One global voice made every agent sound like the same person, so a
// voice conversation could not tell you who was answering. Each agent may
// now carry a `voice` block in agentx.json; anything it leaves out falls
// back to the global default, so an unconfigured fleet sounds exactly as
// it did before.

import type { DaemonConfig } from "@/daemon/config"
import type { TalkSpeaker } from "./talk"

type AgentConfig = DaemonConfig["agents"][string]

/** ElevenLabs "Rachel" — the voice every agent used before this existed. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

export interface AgentVoice {
  agentId: string
  name: string
  /** Null when the agent has none: the client applies its own default. */
  elevenlabsVoiceId: string | null
  gender: "female" | "male" | "neutral" | null
  style: string | null
  intro: string
}

export function resolveAgentVoice(agentId: string, agent?: Partial<AgentConfig>): AgentVoice {
  const name = agent?.name || agentId
  const v = agent?.voice
  return {
    agentId,
    name,
    elevenlabsVoiceId: v?.elevenlabsVoiceId || null,
    gender: v?.gender ?? null,
    style: v?.style || null,
    intro: v?.intro || deriveIntro(name, agent?.systemPrompt),
  }
}

/** The voice id to synthesise with: explicit, then agent, then env, then Rachel. */
export function pickVoiceId(explicit?: string | null, agentVoiceId?: string | null): string {
  return explicit || agentVoiceId || process.env.AGENTX_VOICE_ID || DEFAULT_VOICE_ID
}

/**
 * "Hello, this is Nadia, the marketing agent for Noqta." from a system
 * prompt that opens "You are Nadia, the marketing agent for Noqta (…).".
 *
 * Only the first sentence is used, because that is where every persona
 * says who it is; the rest is instructions, which make terrible speech.
 */
export function deriveIntro(name: string, systemPrompt?: string): string {
  const first = (systemPrompt ?? "").split(/(?<=\.)\s/)[0] ?? ""
  const m = /^You are (.+?)\.?$/i.exec(first.trim())
  if (!m) return `Hello, this is ${name}.`
  // Parentheticals ("(noqta.tn)") read badly aloud.
  const who = m[1].replace(/\s*\([^)]*\)/g, "").trim()
  const [lead, ...rest] = who.split(/,\s*/)
  const role = rest.join(", ")
  // "You are Nadia, the marketing agent" — lead is the name.
  if (role && lead.toLowerCase() === name.toLowerCase()) return `Hello, this is ${name}, ${role}.`
  // "You are the Accountant agent for Noqta" — the name is already in it.
  // Not for "a taxonomy/graph agent": a generic kind still needs the name.
  if (!/^an? /i.test(who) && who.toLowerCase().includes(name.toLowerCase())) return `Hello, this is ${who}.`
  return `Hello, this is ${name}, ${who}.`
}

// --- Introductions ---

/** Silence longer than this makes the next reply a fresh introduction. */
export const INTRO_GAP_MS = 8 * 60 * 60 * 1000
const MAX_TRACKED = 500

/**
 * Remembers who has already spoken in which voice session.
 *
 * In memory on purpose: a daemon restart re-introducing everyone once is
 * harmless, and persisting "who said hello" is not worth a file.
 */
export class VoiceIntroTracker {
  private lastSpoke = new Map<string, number>()

  constructor(private gapMs = INTRO_GAP_MS) {}

  needsIntro(session: string, agentId: string, now = Date.now()): boolean {
    const last = this.lastSpoke.get(key(session, agentId))
    return last === undefined || now - last > this.gapMs
  }

  /** Call only after the agent actually answered, or a failed turn would
   *  swallow the introduction. */
  spoke(session: string, agentId: string, now = Date.now()): void {
    const k = key(session, agentId)
    // Re-insert so Map order stays oldest-first for eviction.
    this.lastSpoke.delete(k)
    this.lastSpoke.set(k, now)
    if (this.lastSpoke.size > MAX_TRACKED) {
      this.lastSpoke.delete(this.lastSpoke.keys().next().value as string)
    }
  }
}

const key = (session: string, agentId: string) => `${session}\u0000${agentId}`

/** The system-prompt line that makes the agent introduce itself, or not. */
export function introInstruction(voice: AgentVoice, introduce: boolean): string {
  const style = voice.style ? ` Your speaking manner: ${voice.style}.` : ""
  if (introduce) {
    return (
      "[VOICE INTRO] This is your first spoken exchange with this person in a while. " +
      `Open with one short sentence introducing yourself in your own manner, along the lines of "${voice.intro}", ` +
      `then answer.${style}`
    )
  }
  return (
    "[VOICE CASUAL] You have already introduced yourself in this voice conversation. " +
    "Do not introduce yourself or greet again; talk casually, like a colleague in the same office." +
    style
  )
}

/** An agent as a talk participant: who it is, how it sounds, whether it
 *  still owes the listener an introduction. */
export function talkSpeaker(agentId: string, agents: DaemonConfig["agents"], introduce: boolean): TalkSpeaker {
  const agent = agents[agentId]
  const voice = resolveAgentVoice(agentId, agent)
  // The first paragraph is where a persona says who it is; the rest is
  // task instructions, which do not belong in small talk.
  const persona = (agent?.systemPrompt ?? "").split(/\n\s*\n/)[0].slice(0, 600).trim()
  return {
    agentId,
    name: voice.name,
    voiceId: pickVoiceId(null, voice.elevenlabsVoiceId),
    persona: persona || `You are ${voice.name}.`,
    introLine: introInstruction(voice, introduce),
  }
}
