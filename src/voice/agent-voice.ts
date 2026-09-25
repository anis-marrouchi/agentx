// --- Per-agent voices, and when an agent should introduce itself ---
//
// One global voice made every agent sound like the same person, so a
// voice conversation could not tell you who was answering. Each agent may
// carry a `voice` block in agentx.json; anything it leaves out falls back
// to the global `voice` settings. Out of the box every agent speaks with
// a free macOS voice of its own; ElevenLabs is opt-in (voice.provider).

import type { DaemonConfig } from "@/daemon/config"
import type { TalkSpeaker } from "./talk"
import type { VoiceRef } from "./speaker"
import { castVoices, candidates, findVoice, listSystemVoices, warnOnce, type CastEntry, type SystemVoice } from "./system-voices"
import { detectLanguage } from "./language"

type AgentConfig = DaemonConfig["agents"][string]
type Agents = DaemonConfig["agents"]
export type VoiceSettings = Partial<DaemonConfig["voice"]>
export type VoiceProvider = DaemonConfig["voice"]["provider"]
/** A configured system voice: one name, or one per language. */
export type SystemChoice = NonNullable<DaemonConfig["voice"]["system"]>

/** The name that means the OS default voice: `say` with no -v follows
 *  System Settings → Spoken Content, the only way apps get a Siri voice. */
export const OS_DEFAULT = "system"
const isOsDefault = (name: string) => name.trim().toLowerCase() === OS_DEFAULT

/** ElevenLabs "Rachel" — the voice every agent used before this existed. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

export interface AgentVoice {
  agentId: string
  name: string
  /** Which engine speaks: the free system voices, or ElevenLabs. */
  provider: VoiceProvider
  /** Null when the agent has none: the client applies its own default. */
  elevenlabsVoiceId: string | null
  /** The macOS voice identifier for `say -v`; null for the OS default. */
  systemVoice: string | null
  /** Its readable name, e.g. "Daniel (en-GB)". */
  systemVoiceName: string | null
  /** A voice per language ("fr", "ar"; null for the OS default), used for
   *  lines in that language. Empty when one voice speaks every language. */
  systemByLanguage: Record<string, SystemVoice | null>
  /** When ElevenLabs cannot speak, use the system voice instead. */
  fallback: boolean
  gender: "female" | "male" | "neutral" | null
  style: string | null
  intro: string
}

/**
 * How an agent sounds. The provider is the agent's, else the global one
 * (system by default). The system voice is the agent's, else the global
 * default, else one assigned to it alone; a name that is not installed
 * is skipped with one warning.
 */
export function resolveAgentVoice(
  agentId: string,
  agents: Agents,
  settings: VoiceSettings = {},
  installed: SystemVoice[] = listSystemVoices(),
): AgentVoice {
  const agent: Partial<AgentConfig> | undefined = agents[agentId]
  const name = agent?.name || agentId
  const v = agent?.voice
  const sys = localSystemVoices(agents, settings, installed).get(agentId) ?? null
  const systemByLanguage = languageVoices(agentId, v?.system, v?.gender, settings, installed)
  return {
    agentId,
    name,
    provider: v?.provider ?? settings.provider ?? "system",
    elevenlabsVoiceId: v?.elevenlabsVoiceId || null,
    systemVoice: sys?.id ?? null,
    systemVoiceName: sys ? label(sys) : null,
    systemByLanguage,
    fallback: (settings.fallback ?? "system") === "system",
    gender: v?.gender ?? null,
    style: v?.style || null,
    intro: v?.intro || deriveIntro(name, agent?.systemPrompt),
  }
}

export const label = (v: SystemVoice) =>
  `${v.name}${v.siri ? " (Siri)" : v.quality === "standard" ? "" : ` (${v.quality[0].toUpperCase()}${v.quality.slice(1)})`} ${v.locale}`

/** A configured name, checked: the installed voice, or null and a warning. */
export function checkedVoice(owner: string, name: string | undefined, installed: SystemVoice[], locale: string): SystemVoice | null {
  if (!name || !installed.length) return null
  const v = findVoice(name, installed, locale)
  if (!v) warnOnce(`${owner}:${name}`, `[voice] ${owner}: system voice "${name}" is not installed; using the next choice. Run \`agentx voice list\` to see installed voices.`)
  return v
}

/** Someone to cast: their configured voice and gender, if any. */
export interface VoiceWish { id: string; system?: SystemChoice; gender?: SystemVoice["gender"] }

const language = (locale: string) => locale.toLowerCase().split(/[-_]/)[0]

/** The configured name for one language: a plain name serves them all. */
const nameFor = (choice: SystemChoice | undefined, lang: string) =>
  typeof choice === "string" ? choice : choice?.[language(lang)]

/** A configured name: the installed voice, null for the OS default, or
 *  undefined when unset or not installed (with a warning). */
function configured(owner: string, name: string | undefined, installed: SystemVoice[], locale: string): SystemVoice | null | undefined {
  if (name === undefined) return undefined
  if (isOsDefault(name)) return null
  return checkedVoice(owner, name, installed, locale) ?? undefined
}

/** The global default suits an agent unless both genders are known and differ. */
const fitsGender = (v: SystemVoice | null, gender: SystemVoice["gender"] | undefined) =>
  !v || !v.gender || v.gender === "neutral" || !gender || gender === "neutral" || v.gender === gender

/**
 * A system voice for each wish, in order: its own if installed, else the
 * global default if it is of the wish's gender, else a distinct one of its
 * own. Null means the OS default voice. Names in `taken` are already
 * spoken for (e.g. by local agents, when casting mesh agents).
 */
export function castSystemVoices(wishes: VoiceWish[], settings: VoiceSettings, installed: SystemVoice[], taken: Set<string> = new Set()): Map<string, SystemVoice | null> {
  const locale = settings.locale ?? "en"
  const out = new Map<string, SystemVoice | null>()
  const open: CastEntry[] = []
  const fallback = configured("voice.system", nameFor(settings.system, locale), installed, locale)
  for (const w of wishes) {
    const own = configured(w.id, nameFor(w.system, locale), installed, locale)
    const pick = own !== undefined ? own : fallback !== undefined && fitsGender(fallback, w.gender) ? fallback : undefined
    if (pick !== undefined) out.set(w.id, pick)
    else open.push({ id: w.id, gender: w.gender ?? null })
  }
  const names = new Set([...taken, ...[...out.values()].flatMap((v) => (v ? [v.name] : []))])
  // Siri voices switch a pref the user owns, so only an agent that names one gets one.
  for (const [id, v] of castVoices(open, candidates(installed.filter((v) => !v.siri), locale), names)) out.set(id, v)
  return out
}

/**
 * The voice per language for lines not in the default one: the agent's
 * own list over the global one. A plain name on the agent speaks every
 * language, so there is nothing to switch to.
 */
export function languageVoices(
  owner: string, own: SystemChoice | undefined, gender: SystemVoice["gender"] | undefined,
  settings: VoiceSettings, installed: SystemVoice[],
): Record<string, SystemVoice | null> {
  if (typeof own === "string") return {}
  const out: Record<string, SystemVoice | null> = {}
  const add = (who: string, list: SystemChoice | undefined, suits: (v: SystemVoice | null) => boolean) => {
    if (!list || typeof list === "string") return
    for (const [lang, name] of Object.entries(list)) {
      const v = configured(`${who}.${lang}`, name, installed, lang)
      if (v !== undefined && suits(v)) out[language(lang)] = v
    }
  }
  add("voice.system", settings.system, (v) => fitsGender(v, gender))
  add(owner, own, () => true)
  return out
}

/** The voice for one line: the voice of its language when the agent has
 *  one, else its default voice. */
export function voiceForText(v: AgentVoice, text?: string | null): AgentVoice {
  const lang = text ? detectLanguage(text) : null
  if (!lang || !(lang in v.systemByLanguage)) return v
  const sys = v.systemByLanguage[lang]
  return { ...v, systemVoice: sys?.id ?? null, systemVoiceName: sys ? label(sys) : null }
}

/** Every local agent's system voice, assigned in config order, so adding
 *  an agent at the end never changes anyone else's voice. */
export function localSystemVoices(agents: Agents, settings: VoiceSettings = {}, installed: SystemVoice[] = listSystemVoices()): Map<string, SystemVoice | null> {
  const wishes = Object.entries(agents).map(([id, a]) => ({ id, system: a.voice?.system, gender: a.voice?.gender }))
  return castSystemVoices(wishes, settings, installed)
}

/** What the speech engine needs; `explicit` is a one-off ElevenLabs id. */
export function voiceRef(v: AgentVoice, explicit?: string | null): VoiceRef {
  const ref: VoiceRef = { provider: v.provider, elevenlabs: pickVoiceId(explicit, v.elevenlabsVoiceId), system: v.systemVoice, fallback: v.fallback }
  const langs = Object.entries(v.systemByLanguage ?? {})
  if (langs.length) ref.languages = Object.fromEntries(langs.map(([l, sys]) => [l, sys?.id ?? null]))
  return ref
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
export function talkSpeaker(agentId: string, agents: DaemonConfig["agents"], introduce: boolean, settings: VoiceSettings = {}): TalkSpeaker {
  const agent = agents[agentId]
  const voice = resolveAgentVoice(agentId, agents, settings)
  // The first paragraph is where a persona says who it is; the rest is
  // task instructions, which do not belong in small talk.
  const persona = (agent?.systemPrompt ?? "").split(/\n\s*\n/)[0].slice(0, 600).trim()
  return {
    agentId,
    name: voice.name,
    voice: voiceRef(voice),
    persona: persona || `You are ${voice.name}.`,
    introLine: introInstruction(voice, introduce),
  }
}

/** Rides in the system append of every voice turn, never in the message,
 *  or the session would record the scaffolding as the person's words. */
export const VOICE_MODE_INSTRUCTION =
  "[VOICE MODE] This question arrived by voice and your reply will be spoken aloud by a " +
  "TTS engine. Answer in two or three short sentences. Plain language, no markdown, no " +
  "code blocks, no bullet points, no URLs. Speak conversationally."

/** What a mesh peer sends in `context.voice` when a remote Mac speaks for
 *  one of this node's agents. Only these fields cross the mesh, never
 *  free-form system text. */
export interface RemoteVoiceTurn { introduce?: boolean; intro?: string; style?: string }

/** The system append for a voice turn that arrived over the mesh, or
 *  undefined when the task is not a voice turn. */
export function remoteVoiceAppend(context: unknown): string | undefined {
  const ctx = context as { channel?: unknown; voice?: RemoteVoiceTurn } | undefined
  if (ctx?.channel !== "voice" || !ctx.voice || typeof ctx.voice !== "object") return undefined
  const clip = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, 200) : "")
  const intro = clip(ctx.voice.intro)
  const voice: AgentVoice = {
    agentId: "", name: "", provider: "system", elevenlabsVoiceId: null,
    systemVoice: null, systemVoiceName: null, systemByLanguage: {}, fallback: true, gender: null,
    style: clip(ctx.voice.style) || null,
    intro: intro || "Hello.",
  }
  return `${VOICE_MODE_INSTRUCTION}\n${introInstruction(voice, ctx.voice.introduce === true && !!intro)}`
}
