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
//
// It also warns BEFORE that happens (#791): when free space on the Data
// volume drops under `voice.lowDiskGB` while a Siri or Premium voice is in
// use, the owner is told once, until space recovers and drops again.

import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "fs"
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

/** Free space is low while voices macOS may purge are in use. */
export interface LowDisk {
  /** Free bytes on the Data volume when first found low. */
  freeBytes: number
  /** The threshold then, in bytes. */
  thresholdBytes: number
  /** The configured Siri and Premium voices at risk. */
  voices: string[]
  /** When free space was first found low (ISO). */
  since: string
  /** When the owner was told (ISO); absent until a notice went out. */
  notifiedAt?: string
}

export interface VoiceHealthState {
  checkedAt: string
  missing: MissingVoice[]
  /** Present while the disk is low and a purgeable voice is in use. */
  lowDisk?: LowDisk
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

/** Default `voice.lowDiskGB`. macOS purged four Siri voices at 5.4 GB free. */
export const LOW_DISK_GB = 10
/** Space must climb this far above the threshold before a low-disk state
 *  clears, so hovering around it does not repeat the notice. */
export const LOW_DISK_RECOVER_BYTES = 1e9
/** The APFS volume that holds user data on macOS 10.15 and later. */
const DATA_VOLUME = "/System/Volumes/Data"

/** Whether macOS may purge a voice: Siri voices, and Premium ones. */
const purgeable = (v: SystemVoice | null | undefined) => !!v && (v.siri || v.quality === "premium")

/**
 * The configured voices macOS may purge when the disk runs low: Siri and
 * Premium names, whether installed or already gone, plus any Siri or
 * Premium voice an agent is assigned without naming one.
 */
export function purgeableVoices(config: Config, installed: SystemVoice[]): string[] {
  const out = new Map<string, string>() // name → its locale
  for (const { name, locale } of configuredNames(config)) {
    const q = name.trim()
    if (q.toLowerCase().startsWith(SIRI_PREFIX) || parseSiriId(q) || /\(premium\)$/i.test(q) || purgeable(findVoice(q, installed, locale))) out.set(q, locale)
  }
  if (installed.length) {
    for (const v of localSystemVoices(config.agents, config.voice, installed).values()) {
      // Skip a voice already listed by the name that chose it ("siri:nora").
      if (purgeable(v) && ![...out].some(([q, l]) => isInstalled(q, [v!], l))) out.set(v!.id, v!.locale)
    }
  }
  return [...out.keys()]
}

/** Free bytes on the Data volume; null off macOS or when unreadable. */
export function dataVolumeFreeBytes(): number | null {
  if (process.platform !== "darwin") return null
  for (const path of [DATA_VOLUME, "/"]) {
    try {
      const s = statfsSync(path)
      return Number(s.bavail) * Number(s.bsize)
    } catch { /* older macOS: no Data volume, try the root */ }
  }
  return null
}

/**
 * The next low-disk state. Low (under the threshold) with a purgeable
 * voice in use starts or keeps it; it clears once space is back above the
 * threshold by LOW_DISK_RECOVER_BYTES, or when no such voice is in use or
 * the warning is off. Unknown free space keeps whatever was there.
 */
export function nextLowDisk(prev: LowDisk | undefined, freeBytes: number | null, thresholdGB: number, voices: string[], now: Date): LowDisk | undefined {
  const thresholdBytes = thresholdGB * 1e9
  if (thresholdBytes <= 0 || !voices.length) return undefined
  if (freeBytes === null) return prev
  const low = freeBytes < thresholdBytes || (prev !== undefined && freeBytes < thresholdBytes + LOW_DISK_RECOVER_BYTES)
  if (!low) return undefined
  return prev
    ? { ...prev, thresholdBytes, voices }
    : { freeBytes, thresholdBytes, voices, since: now.toISOString() }
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/** The low-disk notice: how much is free, and which voices are at risk. */
export function lowDiskNotice(freeBytes: number, low: LowDisk): { title: string; message: string } {
  return {
    title: "AgentX: disk almost full, voices at risk",
    message: `Only ${gb(freeBytes)} is free on this Mac (warning below ${gb(low.thresholdBytes)}). ` +
      `macOS may soon remove these downloaded voices: ${low.voices.map(voiceDisplayName).join(", ")}.\n` +
      "Free up space to keep them. If one goes, agents speak with a stand-in until you reinstall it.",
  }
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
  /** Free bytes on the Data volume; dataVolumeFreeBytes by default. */
  freeBytes?: () => number | null
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
      const prev = readVoiceHealth(file)
      const before = new Map((prev?.missing ?? []).map((m) => [m.voice, m]))
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
      const lowDisk = await this.checkDisk(config, installed, prev?.lowDisk, now)
      const state: VoiceHealthState = { checkedAt: now.toISOString(), missing, ...(lowDisk ? { lowDisk } : {}) }
      // Only on a change: this runs every minute, often on a nearly full disk.
      const changed = JSON.stringify(missing) !== JSON.stringify([...before.values()]) || JSON.stringify(lowDisk) !== JSON.stringify(prev?.lowDisk)
      if (!existsSync(file) || changed) writeVoiceHealth(file, state)
      return state
    } finally {
      this.running = false
    }
  }

  /** Warns once while free space is low and a purgeable voice is in use. */
  private async checkDisk(config: Config, installed: SystemVoice[], prev: LowDisk | undefined, now: Date): Promise<LowDisk | undefined> {
    const free = (this.deps.freeBytes ?? dataVolumeFreeBytes)()
    const threshold = config.voice?.lowDiskGB ?? LOW_DISK_GB
    // No reading, no verdict: skip working out the voices every minute.
    const voices = free === null && !prev ? [] : purgeableVoices(config, installed)
    const low = nextLowDisk(prev, free, threshold, voices, now)
    if (prev && !low) this.deps.log("[voice] the low-disk warning is cleared (space recovered, or no Siri or Premium voice in use)")
    if (!low || low.notifiedAt || free === null) return low
    const { title, message } = lowDiskNotice(free, low)
    try {
      await this.deps.notify(title, message)
      this.deps.log(`[voice] told the owner: ${gb(free)} free, ${low.voices.length} purgeable voice(s) at risk`)
      return { ...low, notifiedAt: now.toISOString() }
    } catch (e: any) {
      // Left untold, so the next check tries again.
      this.deps.log(`[voice] could not send the low-disk notice: ${e?.message ?? e}`)
      return low
    }
  }
}
