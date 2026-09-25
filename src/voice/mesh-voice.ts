// --- Voices for agents that live on other mesh nodes ---
//
// A remote agent has no `voice` block here and its node needs no
// ElevenLabs key: the Mac speaks for it. Its voice comes from
// `meshVoices` in agentx.json when set; otherwise it is derived from the
// peer's agent card, and it gets voices of its own, a system voice and
// one from the ElevenLabs library, that no local agent and no other remote
// already uses.

import type { DaemonConfig } from "@/daemon/config"
import { castSystemVoices, deriveIntro, introInstruction, label, languageVoices, localSystemVoices, pickVoiceId, voiceRef, type AgentVoice, type VoiceSettings } from "./agent-voice"
import { listSystemVoices, type SystemVoice } from "./system-voices"
import type { TalkSpeaker } from "./talk"

type Gender = AgentVoice["gender"]

export interface MeshAgent {
  id: string
  name: string
  description: string
  tags: string[]
  peer: string
  healthy: boolean
}

/** The part of A2AMesh.directory() this needs. */
export type MeshDirectory = Array<{
  peer: string
  healthy: boolean
  skills: Array<{ id: string; name: string; description?: string; tags?: string[] }>
}>

export interface PoolVoice { id: string; gender: Gender; premade: boolean }

/** ElevenLabs premade voices, used when the account's list cannot be
 *  fetched. Every account has these. */
export const PREMADE_VOICES: PoolVoice[] = [
  ["CwhRBWXzGAHq8TQ4Fs17", "male"], ["EXAVITQu4vr4xnSDxMaL", "female"], ["FGY2WhTYpPnrIDTdsKH5", "female"],
  ["IKne3meq5aSn9XLyUdCD", "male"], ["JBFqnCBsd6RMkjVDRZzb", "male"], ["N2lVS1w4EtoT3dr4eOWO", "male"],
  ["SAz9YHcvj6GT2YYXdXww", "neutral"], ["SOYHLrjzK2X1ezoPC6cr", "male"], ["TX3LPaxmHKxFdv7VOQHJ", "male"],
  ["Xb7hH8MSUJpSbSDYk0k2", "female"], ["XrExE9yKIg1WjnnlVkGX", "female"], ["bIHbv24MWmeRgasZH58o", "male"],
  ["cgSgspJ2msm6clMCkdW9", "female"], ["cjVigY5qzO86Huf0OWal", "male"], ["hpp4J3VqNfWAUOO0d1Us", "female"],
  ["iP95p4xoKVk53GoZ742B", "male"], ["nPczCjzI2devNBz1zQrb", "male"], ["onwK4e9ZLuTAKqWW03F9", "male"],
  ["pFZP5JQG7iQjIQuC4Bku", "female"], ["pNInz6obpgDQGcFmaJgB", "male"], ["pqHfZKP75CvOlQylNhV4", "male"],
].map(([id, gender]) => ({ id, gender: gender as Gender, premade: true }))

/**
 * The account's usable voices: premade and library voices. Cloned and
 * generated voices are left out; a clone may be someone's own voice.
 * Falls back to PREMADE_VOICES on any failure.
 */
export async function loadVoicePool(key: string | null, fetchImpl: typeof fetch = fetch): Promise<PoolVoice[]> {
  if (!key) return PREMADE_VOICES
  try {
    const res = await fetchImpl("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return PREMADE_VOICES
    const data = await res.json() as { voices?: Array<{ voice_id: string; category?: string; labels?: { gender?: string } }> }
    const pool = (data.voices ?? [])
      .filter((v) => v.category !== "cloned" && v.category !== "generated")
      .map((v) => ({ id: v.voice_id, gender: asGender(v.labels?.gender), premade: v.category === "premade" }))
    return pool.length ? pool : PREMADE_VOICES
  } catch {
    return PREMADE_VOICES
  }
}

const asGender = (g?: string): Gender =>
  g === "female" || g === "male" || g === "neutral" ? g : null

/** "she"/"he" in the card's description; agent cards rarely say. */
export function genderFromCard(description: string): Gender {
  if (/\b(she|her)\b/i.test(description)) return "female"
  if (/\b(he|him|his)\b/i.test(description)) return "male"
  return null
}

/**
 * Give each agent its own voice, stably: an agent starts looking at a
 * spot fixed by its id, so adding a remote rarely moves anyone else's.
 * Premade voices go first, then the account's library voices; the same
 * gender first when it is known. Voices in `reserved` are never handed
 * out. Only once the pool runs dry are voices repeated.
 */
export function assignVoices(
  agents: Array<{ id: string; gender: Gender }>,
  pool: PoolVoice[],
  reserved: Set<string>,
): Map<string, string> {
  const byId = (a: PoolVoice, b: PoolVoice) => a.id.localeCompare(b.id)
  const tiers = [pool.filter((v) => v.premade).sort(byId), pool.filter((v) => !v.premade).sort(byId)]
  const used = new Set(reserved)
  const out = new Map<string, string>()
  for (const a of [...agents].sort((x, y) => x.id.localeCompare(y.id))) {
    const h = hash(a.id)
    const pick = (ok: (v: PoolVoice) => boolean) => {
      for (const tier of tiers) {
        for (let i = 0; i < tier.length; i++) {
          const v = tier[(h + i) % tier.length]
          if (!used.has(v.id) && ok(v)) return v.id
        }
      }
      return undefined
    }
    const id = (a.gender ? pick((v) => v.gender === a.gender) : undefined)
      ?? pick(() => true)
      ?? (pool.length ? pool[h % pool.length].id : undefined)
    if (!id) continue
    used.add(id)
    out.set(a.id, id)
  }
  return out
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A remote reply can be as long as a chat answer when its node predates
 *  the voice instruction: speak the first few sentences, show the rest. */
export function clipSpeech(text: string, max = 3): string {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text]
  return sentences.slice(0, max).join("").trim()
}

const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[-_\s]+agent$|\s+agent$/, "").replace(/[-_]+/g, " ").trim()

/** Remote agents as seen by the local daemon, and how each one sounds. */
export class MeshVoices {
  private pool: PoolVoice[] = PREMADE_VOICES

  constructor(
    private config: () => Pick<DaemonConfig, "agents" | "meshVoices"> & { voice?: VoiceSettings },
    private directory: () => MeshDirectory,
    private installed: () => SystemVoice[] = () => listSystemVoices(),
  ) {}

  /** Swap in the account's voice list once it has loaded. */
  usePool(pool: PoolVoice[]): void { this.pool = pool }

  /** Agents on mesh peers, minus any id that is also local (local wins). */
  list(): MeshAgent[] {
    const local = this.config().agents
    const seen = new Map<string, MeshAgent>()
    for (const p of this.directory()) {
      for (const s of p.skills) {
        if (local[s.id]) continue
        const prev = seen.get(s.id)
        if (prev && (prev.healthy || !p.healthy)) continue
        seen.set(s.id, { id: s.id, name: s.name || s.id, description: s.description ?? "", tags: s.tags ?? [], peer: p.peer, healthy: p.healthy })
      }
    }
    return [...seen.values()]
  }

  get(id: string): MeshAgent | undefined {
    return this.list().find((a) => a.id === id)
  }

  voice(id: string): AgentVoice {
    const agent = this.get(id)
    const cfg = this.config().meshVoices?.[id]
    const name = cfg?.name || agent?.name || id
    const settings = this.config().voice ?? {}
    const sys = this.systemCast().get(id) ?? null
    return {
      agentId: id,
      name,
      provider: cfg?.provider ?? settings.provider ?? "system",
      elevenlabsVoiceId: cfg?.elevenlabsVoiceId || this.assigned().get(id) || null,
      systemVoice: sys?.id ?? null,
      systemVoiceName: sys ? label(sys) : null,
      systemByLanguage: languageVoices(id, cfg?.system, cfg?.gender ?? genderFromCard(agent?.description ?? ""), settings, this.installed()),
      fallback: (settings.fallback ?? "system") === "system",
      gender: cfg?.gender ?? genderFromCard(agent?.description ?? "") ?? null,
      style: cfg?.style || null,
      intro: cfg?.intro || deriveIntro(name, agent?.description),
    }
  }

  /** As a talk participant: the persona is the agent card's description. */
  speaker(id: string, introduce: boolean): TalkSpeaker | undefined {
    const agent = this.get(id)
    if (!agent) return undefined
    const voice = this.voice(id)
    return {
      agentId: id,
      name: voice.name,
      voice: voiceRef(voice),
      persona: agent.description || `You are ${voice.name}.`,
      introLine: introInstruction(voice, introduce),
    }
  }

  /** System voices for remotes, distinct from every local agent's. */
  private systemCast(): Map<string, SystemVoice | null> {
    const { agents, meshVoices = {}, voice: settings = {} } = this.config()
    const installed = this.installed()
    const taken = new Set([...localSystemVoices(agents, settings, installed).values()].flatMap((v) => (v ? [v.name] : [])))
    const wishes = this.list().sort((a, b) => a.id.localeCompare(b.id)).map((a) => ({
      id: a.id, system: meshVoices[a.id]?.system, gender: meshVoices[a.id]?.gender ?? genderFromCard(a.description),
    }))
    return castSystemVoices(wishes, settings, installed, taken)
  }

  /** Default voices for every remote not pinned in meshVoices. */
  private assigned(): Map<string, string> {
    const { agents, meshVoices = {} } = this.config()
    const reserved = new Set<string>([pickVoiceId(null, null)])
    for (const a of Object.values(agents)) if (a.voice?.elevenlabsVoiceId) reserved.add(a.voice.elevenlabsVoiceId)
    for (const v of Object.values(meshVoices)) if (v.elevenlabsVoiceId) reserved.add(v.elevenlabsVoiceId)
    const open = this.list()
      .filter((a) => !meshVoices[a.id]?.elevenlabsVoiceId)
      .map((a) => ({ id: a.id, gender: meshVoices[a.id]?.gender ?? genderFromCard(a.description) }))
    return assignVoices(open, this.pool, reserved)
  }

  /**
   * Which agent "Atlas" or "the secretary" means: local agents by id or
   * name, remote ones by id, name, meshVoices name or card tag.
   */
  resolve(spoken: string): string | undefined {
    const q = norm(spoken)
    if (!q) return undefined
    const { agents, meshVoices = {} } = this.config()
    for (const [id, a] of Object.entries(agents)) {
      if (norm(id) === q || (a.name && norm(a.name) === q)) return id
    }
    for (const a of this.list()) {
      const names = [a.id, a.name, meshVoices[a.id]?.name ?? "", ...a.tags]
      if (names.some((n) => n && norm(n.replace(/^@/, "")) === q)) return a.id
    }
    return undefined
  }
}

const SWITCH = /^(?:(?:ok(?:ay)?|hey|please|so)[,\s]+)?(?:(?:can i|could i|let me|i want to|i'd like to)\s+)?(?:talk|speak) (?:to|with)\s+(.+?)[\s.!?]*$|^(?:(?:ok(?:ay)?|please)[,\s]+)?(?:switch to|put me through to|connect me (?:to|with)|(?:go |switch )?back to)\s+(.+?)[\s.!?]*$/i

/** "talk to Atlas", "back to secretary": the named agent, or null. */
export function parseVoiceSwitch(message: string): string | null {
  const m = SWITCH.exec(message.trim())
  return m ? (m[1] ?? m[2]).trim() : null
}
