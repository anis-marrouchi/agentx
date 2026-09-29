// --- Configured voices that are not installed, and telling the owner ---
//
// macOS can take voices away: it purges the downloaded Siri and Premium
// voices when the disk runs low. An agent whose voice is gone still
// speaks, with a stand-in (agent-voice.ts), and only a log line said so.
// Here the daemon checks every configured voice, tells the owner ONCE per
// missing voice (at startup, or as soon as a line finds it gone), and says
// when it is back. The state lives in a small file, so a restart does not
// repeat the notice, and so the dashboard and `agentx voice list` can show
// it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"
import type { DaemonConfig } from "@/daemon/config"
import { OS_DEFAULT, label, localSystemVoices, type VoiceSettings } from "./agent-voice"
import { findVoice, forgetWarnings, type SystemVoice } from "./system-voices"
import { parseSiriId, SIRI_PREFIX } from "./siri"

/** Where to get a voice back, as System Settings words it. */
export const REINSTALL_HINT = "System Settings › Accessibility › Spoken Content › System voice › Manage Voices"

export interface MissingVoice {
  /** The name as configured, e.g. "siri:nora" or a voice id. */
  voice: string
  /** Who names it: agent ids, or "voice.system" for the global default. */
  agents: string[]
  /** What each of those agents speaks with instead. */
  speaksWith: Record<string, string>
  /** When it was first found missing (ISO). */
  since: string
  /** When the owner was told (ISO); absent until a notice went out. */
  notifiedAt?: string
}

export interface VoiceHealthState {
  checkedAt: string
  missing: MissingVoice[]
}

export const voiceHealthPath = (home = homedir()) => join(home, ".agentx", "voice", "health.json")

/** Whether a configured name is installed as itself: a Siri voice counts
 *  only when that Siri voice is there, not a system voice of its name. */
export function isInstalled(name: string, installed: SystemVoice[], locale: string): boolean {
  const q = name.trim()
  if (!q || q.toLowerCase() === OS_DEFAULT) return true
  if (q.toLowerCase().startsWith(SIRI_PREFIX)) {
    const base = q.slice(SIRI_PREFIX.length).trim().toLowerCase()
    return installed.some((v) => v.siri && v.name.toLowerCase() === base)
  }
  return findVoice(q, installed, locale) !== null
}

type Config = Pick<DaemonConfig, "agents"> & { voice?: VoiceSettings }

/** Every configured voice name, with who names it and in which language. */
function configuredNames(config: Config): Array<{ owner: string; name: string; locale: string; perLanguage: boolean }> {
  const locale = config.voice?.locale ?? "en"
  const out: Array<{ owner: string; name: string; locale: string; perLanguage: boolean }> = []
  const add = (owner: string, choice: string | Record<string, string> | undefined) => {
    if (typeof choice === "string") out.push({ owner, name: choice, locale, perLanguage: false })
    else for (const [lang, name] of Object.entries(choice ?? {})) out.push({ owner, name, locale: lang, perLanguage: true })
  }
  add("voice.system", config.voice?.system)
  for (const [id, a] of Object.entries(config.agents)) {
    if ((a.voice?.provider ?? config.voice?.provider ?? "system") !== "system" && config.voice?.fallback === "none") continue
    add(id, a.voice?.system)
  }
  return out
}

/**
 * The configured voices that are not installed, one entry per voice. An
 * empty `installed` means the list could not be read (or not macOS): no
 * verdict, so nothing is reported missing.
 */
export function findMissingVoices(config: Config, installed: SystemVoice[]): Array<Omit<MissingVoice, "since" | "notifiedAt">> {
  if (!installed.length) return []
  const byVoice = new Map<string, Omit<MissingVoice, "since" | "notifiedAt">>()
  let cast: Map<string, SystemVoice | null> | undefined
  for (const { owner, name, locale, perLanguage } of configuredNames(config)) {
    if (isInstalled(name, installed, locale)) continue
    cast ??= localSystemVoices(config.agents, config.voice, installed)
    const entry = byVoice.get(name) ?? { voice: name, agents: [], speaksWith: {} }
    if (!entry.agents.includes(owner)) entry.agents.push(owner)
    const now = cast.get(owner)
    // A per-language voice's stand-in is not the agent's default voice.
    if (owner !== "voice.system" && !perLanguage) entry.speaksWith[owner] = now ? label(now) : "the OS default voice"
    byVoice.set(name, entry)
  }
  return [...byVoice.values()]
}

/** "Siri Nora (en-US)" for a Siri id, "Siri Nora" for siri:nora, else as is. */
export function voiceDisplayName(name: string): string {
  const siri = parseSiriId(name)
  if (siri) return `Siri ${siri.name[0].toUpperCase()}${siri.name.slice(1)} (${siri.locale})`
  if (name.toLowerCase().startsWith(SIRI_PREFIX)) {
    const base = name.slice(SIRI_PREFIX.length).trim()
    return `Siri ${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`
  }
  return name
}

/** The notice: which voices are gone, who they belong to, what speaks
 *  now, and how to get them back. */
export function missingNotice(missing: MissingVoice[]): { title: string; message: string } {
  const lines = missing.map((m) => {
    const who = m.agents.map((a) => (m.speaksWith[a] ? `${a} (now ${m.speaksWith[a]})` : a)).join(", ")
    return `• ${voiceDisplayName(m.voice)}: ${who}`
  })
  return {
    title: missing.length === 1 ? "AgentX: a voice is not installed" : `AgentX: ${missing.length} voices are not installed`,
    message: `${lines.join("\n")}\nReinstall in ${REINSTALL_HINT}. Agents switch back on their own once it is installed.`,
  }
}

export function readVoiceHealth(file = voiceHealthPath()): VoiceHealthState | null {
  if (!existsSync(file)) return null
  try {
    const s = JSON.parse(readFileSync(file, "utf8"))
    return s && Array.isArray(s.missing) ? s : null
  } catch {
    return null // a torn or hand-edited file is rebuilt by the next check
  }
}

function writeVoiceHealth(file: string, state: VoiceHealthState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n")
  renameSync(`${file}.tmp`, file)
}

export interface VoiceHealthDeps {
  /** Tell the owner; resolves once sent (or held for Focus). */
  notify: (title: string, message: string) => Promise<void>
  log: (msg: string) => void
  file?: string
}

/** Checks configured voices, notifies once per missing voice, and logs
 *  when one comes back. One check at a time; calls meanwhile are dropped. */
export class VoiceHealth {
  private running = false
  private missingNow = false

  constructor(private deps: VoiceHealthDeps) {}

  /** Whether the last check found a voice missing. */
  hasMissing(): boolean { return this.missingNow }

  async check(config: Config, installed: SystemVoice[], now = new Date()): Promise<VoiceHealthState | null> {
    if (this.running || !installed.length) return null
    this.running = true
    try {
      const file = this.deps.file ?? voiceHealthPath()
      const before = new Map((readVoiceHealth(file)?.missing ?? []).map((m) => [m.voice, m]))
      const found = findMissingVoices(config, installed)
      const missing: MissingVoice[] = found.map((m) => ({ ...m, since: before.get(m.voice)?.since ?? now.toISOString(), ...(before.get(m.voice)?.notifiedAt ? { notifiedAt: before.get(m.voice)!.notifiedAt } : {}) }))
      const back = [...before.keys()].filter((v) => !found.some((m) => m.voice === v))
      for (const v of back) this.deps.log(`[voice] ${voiceDisplayName(v)} is installed again; its agents speak with it again`)
      // Keys are "<owner>:<name>", and findVoice's Siri stand-in warns as the name itself.
      if (back.length) forgetWarnings((k) => back.some((v) => k === v || k.endsWith(`:${v}`)))
      const untold = missing.filter((m) => !m.notifiedAt)
      if (untold.length) {
        const { title, message } = missingNotice(untold)
        try {
          await this.deps.notify(title, message)
          for (const m of untold) m.notifiedAt = now.toISOString()
          this.deps.log(`[voice] told the owner: ${untold.map((m) => voiceDisplayName(m.voice)).join(", ")} not installed`)
        } catch (e: any) {
          // Left untold, so the next check tries again.
          this.deps.log(`[voice] could not send the missing-voice notice: ${e?.message ?? e}`)
        }
      }
      this.missingNow = missing.length > 0
      const state = { checkedAt: now.toISOString(), missing }
      // Only on a change: this runs every minute, often on a nearly full disk.
      if (!existsSync(file) || JSON.stringify(missing) !== JSON.stringify([...before.values()])) writeVoiceHealth(file, state)
      return state
    } finally {
      this.running = false
    }
  }
}
