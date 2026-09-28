// --- Voice settings for the AgentX Voice settings window ---
//
//   GET  /voice/settings   what the window shows: general settings, each
//                          agent's voice, and the installed system voices
//   POST /voice/settings   save a change: {general?, agents?: {<id>: {...}}}
//                          null or "" puts a field back to its default.
//                          400 {error, errors: [{path, message}]} when a
//                          value is refused; nothing is written then.
//   POST /voice/preview    {agentId, voice?, text?}: say a sample in that
//                          agent's voice with the unsaved changes applied
//
// agentx.json is the only copy: the app keeps none. A save is checked in
// full first (our own rules, then the config schema), then written in
// place through applyConfigMutation, never by renaming a new file over
// the old one, which macOS's file watcher would lose track of. After the
// write the file is read back; if it is not exactly what was meant, the
// previous text is put back.

import { readFileSync, writeFileSync } from "fs"
import type { DaemonConfig } from "@/daemon/config"
import { applyConfigMutation, findConfigPath } from "@/daemon/config-mutator"
import { presenceLook } from "@/voice/presence"
import { ORB_PALETTES, agentPalette, paletteForColor } from "@/voice/orb-palettes"
import { resolveAgentVoice, voiceRef, label } from "@/voice/agent-voice"
import type { SystemVoice } from "@/voice/system-voices"
import type { VoiceRef } from "@/voice/speaker"
import { DEFAULT_HOTKEYS, describeHotkey, parseHotkey } from "@/voice/hotkey"

type Provider = "system" | "elevenlabs"
type Narrate = "off" | "on" | "all"
type Priority = "high" | "normal" | "low"

/** The shortcut that opens the menu. Fixed, so no setting may take it. */
export const MENU_HOTKEY = "cmd+opt+a"

export interface AgentVoicePatch {
  provider?: Provider | null
  system?: string | null
  elevenlabsVoiceId?: string | null
  rate?: number | null
  narrate?: Narrate | null
  priority?: Priority | null
  hotkey?: string | null
  /** The orb's (and pointer's) colour: agents[].presence.color. */
  color?: string | null
  /** The orb's gradient: agents[].presence.palette. */
  palette?: string | null
}

export interface VoiceSettingsPatch {
  general?: {
    provider?: Provider
    stt?: "auto" | "elevenlabs" | "local"
    localStt?: LocalStt
    endOfTurn?: EndOfTurn
    hotkeys?: { talk?: string; stop?: string; paste?: string }
    card?: { timeout?: number; maxHeight?: number }
  }
  agents?: Record<string, AgentVoicePatch>
}

type LocalStt = "mlx-whisper" | "parakeet"
type EndOfTurn = "vad" | "volume"

export interface SettingsError { path: string; message: string }

export interface VoiceSettingsView {
  general: {
    provider: Provider
    fallback: "system" | "none"
    stt: "auto" | "elevenlabs" | "local"
    localStt: LocalStt
    endOfTurn: EndOfTurn
    hotkeys: { talk: string; stop: string; paste: string }
    /** The answer shown in the pill: seconds open once spoken (0: until
     *  closed) and its tallest height in points. */
    card: { timeout: number; maxHeight: number }
  }
  agents: Array<{
    id: string
    name: string
    /** Resolved: presence.color, else derived from the id. */
    color: string
    /** True when presence.color is set, false when derived. */
    colorSet: boolean
    /** presence.palette; absent when the orb follows the colour. */
    palette?: string
    /** The palette the orb uses without one: nearest the colour. */
    paletteDefault: string
    voice: {
      provider?: Provider
      /** The configured system voice; absent when unset or per language. */
      system?: string
      /** A per-language list is set; the window leaves it alone. */
      systemPerLanguage: boolean
      elevenlabsVoiceId?: string
      rate?: number
      narrate?: Narrate
      priority?: Priority
      hotkey?: string
    }
    /** What actually speaks now, for the window to show. */
    speaks: { provider: Provider; systemVoice: string | null }
  }>
  systemVoices: Array<{ id: string; label: string; locale: string }>
  /** Every orb palette, for the window's picker. */
  palettes: Array<{ id: string; label: string; colors: string[] }>
  menuHotkey: string
}

export function voiceSettingsView(config: DaemonConfig, installed: SystemVoice[]): VoiceSettingsView {
  const v = config.voice
  return {
    general: {
      provider: v.provider,
      fallback: v.fallback,
      stt: v.stt ?? "auto",
      localStt: v.localStt ?? "mlx-whisper",
      endOfTurn: v.endOfTurn ?? "vad",
      hotkeys: { ...DEFAULT_HOTKEYS, ...(v.hotkeys ?? {}) },
      card: { timeout: v.card.timeout, maxHeight: v.card.maxHeight },
    },
    agents: Object.entries(config.agents).map(([id, a]) => {
      const av = a.voice ?? {}
      const resolved = resolveAgentVoice(id, config.agents, v, installed)
      const color = presenceLook(id, a).color
      const palette = agentPalette(a.presence?.palette, color)
      return {
        id,
        name: a.name || id,
        color,
        colorSet: !!a.presence?.color,
        ...(palette.set ? { palette: palette.id } : {}),
        paletteDefault: paletteForColor(color).id,
        voice: {
          ...(av.provider ? { provider: av.provider } : {}),
          ...(typeof av.system === "string" ? { system: av.system } : {}),
          systemPerLanguage: !!av.system && typeof av.system !== "string",
          ...(av.elevenlabsVoiceId ? { elevenlabsVoiceId: av.elevenlabsVoiceId } : {}),
          ...(av.rate ? { rate: av.rate } : {}),
          ...(av.narrate ? { narrate: av.narrate } : {}),
          ...(av.priority ? { priority: av.priority } : {}),
          ...(av.hotkey ? { hotkey: av.hotkey } : {}),
        },
        speaks: { provider: resolved.provider, systemVoice: resolved.systemVoiceName },
      }
    }),
    systemVoices: installed.map((s) => ({ id: s.id, label: label(s), locale: s.locale })),
    palettes: ORB_PALETTES.map(({ id, label, colors }) => ({ id, label, colors })),
    menuHotkey: MENU_HOTKEY,
  }
}

const AGENT_FIELDS = new Set(["provider", "system", "elevenlabsVoiceId", "rate", "narrate", "priority", "hotkey", "color", "palette"])
const PRESENCE_FIELDS = new Set(["color", "palette"])
/** The answer card's limits, as the config schema has them. */
export const CARD_LIMITS = { timeout: [0, 600], maxHeight: [120, 800] } as const
const clear = (x: unknown) => x === null || x === ""

/** Our own checks, with messages a person can act on. The config schema
 *  still runs afterwards, on the whole file. */
export function checkVoiceSettings(patch: VoiceSettingsPatch, config: DaemonConfig): SettingsError[] {
  const errors: SettingsError[] = []
  const err = (path: string, message: string) => errors.push({ path, message })
  if (!patch || typeof patch !== "object") return [{ path: "", message: "Send an object with general and/or agents" }]
  for (const k of Object.keys(patch)) if (k !== "general" && k !== "agents") err(k, `"${k}" is not a voice setting`)

  const g = patch.general ?? {}
  for (const k of Object.keys(g)) if (!["provider", "stt", "localStt", "endOfTurn", "hotkeys", "card"].includes(k)) err(`general.${k}`, `"${k}" is not a general voice setting`)
  if (g.provider !== undefined && !["system", "elevenlabs"].includes(g.provider)) err("general.provider", "Voice provider must be system or elevenlabs")
  if (g.stt !== undefined && !["auto", "elevenlabs", "local"].includes(g.stt)) err("general.stt", "Speech to text must be auto, elevenlabs or local")
  if (g.localStt !== undefined && !["mlx-whisper", "parakeet"].includes(g.localStt)) err("general.localStt", "The engine on this Mac must be mlx-whisper or parakeet")
  if (g.endOfTurn !== undefined && !["vad", "volume"].includes(g.endOfTurn)) err("general.endOfTurn", "The end of a turn must be vad or volume")
  for (const [k, value] of Object.entries(g.hotkeys ?? {})) {
    if (!["talk", "stop", "paste"].includes(k)) { err(`general.hotkeys.${k}`, `"${k}" is not a shortcut the window sets`); continue }
    const r = parseHotkey(String(value ?? ""))
    if (!r.ok) err(`general.hotkeys.${k}`, `The ${k} shortcut ${r.error}`)
  }
  for (const [k, value] of Object.entries(g.card ?? {})) {
    const limits = CARD_LIMITS[k as keyof typeof CARD_LIMITS]
    if (!limits) { err(`general.card.${k}`, `"${k}" is not an answer card setting`); continue }
    const what = k === "timeout" ? "The answer's time on screen" : "The answer's tallest height"
    if (typeof value !== "number" || !(value >= limits[0] && value <= limits[1])) err(`general.card.${k}`, `${what} must be between ${limits[0]} and ${limits[1]}`)
  }

  for (const [id, a] of Object.entries(patch.agents ?? {})) {
    if (!config.agents[id]) { err(`agents.${id}`, `There is no agent "${id}"`); continue }
    const name = config.agents[id].name || id
    for (const k of Object.keys(a ?? {})) if (!AGENT_FIELDS.has(k)) err(`agents.${id}.${k}`, `"${k}" is not a voice setting`)
    if (a.provider != null && !["system", "elevenlabs"].includes(a.provider)) err(`agents.${id}.provider`, `${name}: voice provider must be system or elevenlabs`)
    if (a.rate != null && (typeof a.rate !== "number" || !(a.rate >= 0.75 && a.rate <= 1.5))) err(`agents.${id}.rate`, `${name}: speaking speed must be between 0.75 and 1.5`)
    if (a.narrate != null && !["off", "on", "all"].includes(a.narrate)) err(`agents.${id}.narrate`, `${name}: narration must be off, on or all`)
    if (a.priority != null && !["high", "normal", "low"].includes(a.priority)) err(`agents.${id}.priority`, `${name}: queue priority must be high, normal or low`)
    if (a.color != null && a.color !== "" && !/^#[0-9a-fA-F]{6}$/.test(a.color)) err(`agents.${id}.color`, `${name}: colour must look like #1E90FF`)
    if (a.palette != null && a.palette !== "" && !ORB_PALETTES.some((p) => p.id === a.palette)) err(`agents.${id}.palette`, `${name}: palette must be one of ${ORB_PALETTES.map((p) => p.id).join(", ")}`)
    if (a.system != null && typeof a.system !== "string") err(`agents.${id}.system`, `${name}: system voice must be a voice name or id`)
    if (a.elevenlabsVoiceId != null && typeof a.elevenlabsVoiceId !== "string") err(`agents.${id}.elevenlabsVoiceId`, `${name}: ElevenLabs voice must be a voice id`)
    if (a.hotkey != null && a.hotkey !== "") {
      const r = parseHotkey(a.hotkey)
      if (!r.ok) err(`agents.${id}.hotkey`, `${name}: the shortcut ${r.error}`)
    }
  }
  if (errors.length) return errors

  // No two actions on one shortcut, counting the ones not being changed.
  const owners = new Map<string, string[]>()
  const own = (key: string | undefined, who: string) => {
    if (!key) return
    const r = parseHotkey(key)
    if (!r.ok) return
    owners.set(r.value, [...(owners.get(r.value) ?? []), who])
  }
  own(MENU_HOTKEY, "open the menu")
  const hk = { ...DEFAULT_HOTKEYS, ...(config.voice.hotkeys ?? {}), ...(g.hotkeys ?? {}) }
  own(hk.talk, "talk"); own(hk.stop, "stop"); own(hk.paste, "smart paste")
  for (const [id, a] of Object.entries(config.agents)) {
    const p = patch.agents?.[id]
    const key = p && "hotkey" in p ? (clear(p.hotkey) ? undefined : p.hotkey!) : a.voice?.hotkey
    own(key, `ask ${a.name || id}`)
  }
  for (const [key, who] of owners) {
    if (who.length > 1) err("hotkeys", `${describeHotkey(key)} is used for both ${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}; give each its own shortcut`)
  }
  return errors
}

/** Apply a checked patch to the raw agentx.json object, in place. */
export function applyVoiceSettings(raw: any, patch: VoiceSettingsPatch): void {
  const g = patch.general
  if (g) {
    raw.voice ??= {}
    if (g.provider !== undefined) raw.voice.provider = g.provider
    if (g.stt !== undefined) raw.voice.stt = g.stt
    if (g.localStt !== undefined) raw.voice.localStt = g.localStt
    if (g.endOfTurn !== undefined) raw.voice.endOfTurn = g.endOfTurn
    for (const [k, value] of Object.entries(g.hotkeys ?? {})) {
      const r = parseHotkey(String(value))
      if (!r.ok) continue
      raw.voice.hotkeys ??= {}
      raw.voice.hotkeys[k] = r.value
    }
    for (const [k, value] of Object.entries(g.card ?? {})) {
      raw.voice.card ??= {}
      raw.voice.card[k] = value
    }
  }
  for (const [id, a] of Object.entries(patch.agents ?? {})) {
    const agent = raw.agents?.[id]
    if (!agent) continue
    for (const [k, value] of Object.entries(a)) {
      if (PRESENCE_FIELDS.has(k)) {
        if (clear(value)) {
          if (agent.presence) {
            delete agent.presence[k]
            if (!Object.keys(agent.presence).length) delete agent.presence
          }
        } else {
          agent.presence ??= {}
          agent.presence[k] = k === "color" ? String(value).toUpperCase() : value
        }
        continue
      }
      if (clear(value)) {
        if (agent.voice) delete agent.voice[k]
      } else {
        agent.voice ??= {}
        agent.voice[k] = k === "hotkey" ? (parseHotkey(String(value)) as { value: string }).value : value
      }
    }
    if (agent.voice && !Object.keys(agent.voice).length) delete agent.voice
  }
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; status: number; error: string; errors: SettingsError[] }

let saving: Promise<unknown> = Promise.resolve()

/** Check, write agentx.json in place, and read it back. One save at a time. */
export function saveVoiceSettings(patch: VoiceSettingsPatch, config: DaemonConfig, configPath?: string): Promise<SaveResult> {
  const run = saving.then(() => save(patch, config, configPath))
  saving = run.catch(() => {})
  return run
}

async function save(patch: VoiceSettingsPatch, config: DaemonConfig, configPath?: string): Promise<SaveResult> {
  const errors = checkVoiceSettings(patch, config)
  if (errors.length) return { ok: false, status: 400, error: errors.map((e) => e.message).join("\n"), errors }

  const path = findConfigPath(configPath)
  let before: string
  try { before = readFileSync(path, "utf8") } catch (e: any) {
    return { ok: false, status: 500, error: `Cannot read ${path}: ${e.message}`, errors: [] }
  }
  const result = await applyConfigMutation((raw) => applyVoiceSettings(raw, patch), { configPath: path, reload: false })
  if (!result.success) {
    const schema = (result.error ?? "").startsWith("Validation failed")
    const issues = schema
      ? (result.error ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
        .map((l) => { const i = l.indexOf(": "); return { path: l.slice(0, i), message: l.slice(i + 2) } })
      : []
    // A failed write may have cut the file short: put the old text back.
    if (!schema) restore(path, before)
    return {
      ok: false, status: schema ? 400 : 500,
      error: schema ? `agentx.json would not be valid:\n${issues.map((i) => `${i.path}: ${i.message}`).join("\n")}` : result.error ?? "Save failed",
      errors: issues,
    }
  }
  const meant = JSON.stringify(result.after, null, 2) + "\n"
  let now = ""
  try { now = readFileSync(path, "utf8") } catch { /* compared below */ }
  if (now !== meant) {
    restore(path, before)
    return { ok: false, status: 500, error: "agentx.json did not save as expected; the previous version was put back", errors: [] }
  }
  return { ok: true, path }
}

function restore(path: string, text: string): void {
  try { writeFileSync(path, text) } catch { /* nothing more to do */ }
}

export interface PreviewRequest {
  agentId?: string
  voice?: Pick<AgentVoicePatch, "provider" | "system" | "elevenlabsVoiceId" | "rate">
  text?: string
}

/** The voice and line a preview speaks: the agent's voice with the unsaved
 *  changes on top. An error message when the request cannot be spoken. */
export function previewLine(body: PreviewRequest, config: DaemonConfig, installed: SystemVoice[]): { voice: VoiceRef; text: string; agentId: string } | { error: string } {
  const id = String(body?.agentId ?? "")
  const agent = config.agents[id]
  if (!agent) return { error: `There is no agent "${id}"` }
  const draft = body.voice ?? {}
  const errors = checkVoiceSettings({ agents: { [id]: draft } }, config).filter((e) => e.path !== "hotkeys")
  if (errors.length) return { error: errors.map((e) => e.message).join("\n") }
  const voice: Record<string, unknown> = { ...(agent.voice ?? {}) }
  for (const [k, value] of Object.entries(draft)) {
    if (clear(value)) delete voice[k]
    else voice[k] = value
  }
  const agents = { ...config.agents, [id]: { ...agent, voice } } as DaemonConfig["agents"]
  const name = agent.name || id
  const text = String(body.text ?? "").trim().slice(0, 300) || `Hello, this is ${name}. This is how I sound.`
  return { voice: voiceRef(resolveAgentVoice(id, agents, config.voice, installed)), text, agentId: id }
}
