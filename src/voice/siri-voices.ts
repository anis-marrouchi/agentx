// --- Siri voices, one per agent, by switching the system voice ---
//
// Siri's neural voices cannot be named to `say -v`, and apps do not see
// them. But `say` with no -v speaks with the Spoken Content voice for the
// line's language (com.apple.Accessibility
// SpokenContentDefaultVoiceSelectionsByLanguage), and writing that
// preference takes effect for the next `say`. So a line in a Siri voice
// is: take the lock, save the preference, point it at the agent's voice,
// run `say`, and put the user's choice back when `say` exits.
//
// The lock is a directory, so it holds across processes (the daemon and
// `agentx teach`) and two agents never race on the preference. It also
// holds the saved preference: if a speaker dies mid-line, the next one
// puts the user's choice back before anything else.

import { execFile, spawn, type ChildProcess } from "child_process"
import { EventEmitter } from "events"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { SystemVoice } from "./system-voices"

/** How a Siri voice is named in agentx.json: `siri:aaron`. */
export const SIRI_PREFIX = "siri:"
const ID_PREFIX = "com.apple.ttsbundle.gryphon-neural_"

export const isSiriId = (id: string | null | undefined): id is string => !!id?.startsWith(ID_PREFIX)

// --- Which Siri voices are installed ---

const ASSET_DIRS = [
  "/System/Library/AssetsV2/com_apple_MobileAsset_Trial_Siri_SiriTextToSpeech/purpose_auto",
  "/System/Library/AssetsV2/com_apple_MobileAsset_UAF_Siri_TextToSpeech/purpose_auto",
]

/** A Siri voice asset's Info.plist, as a voice; null for the resource
 *  bundles and anything else that is not a named voice. */
export function parseSiriAsset(plist: string): SystemVoice | null {
  const m = /com\.apple\.siri\.tts\.voice\.([a-z]{2,3})_([A-Z]{2})\.([a-z]+)\.neural\.premium/.exec(plist)
  if (!m) return null
  const [, lang, region, name] = m
  const g = /<key>gender<\/key>\s*<string>(\w+)<\/string>/.exec(plist)?.[1]
  return {
    id: `${ID_PREFIX}${name}_${lang}-${region}_premium`,
    name: name[0].toUpperCase() + name.slice(1),
    locale: `${lang}-${region}`,
    quality: "premium",
    gender: g === "female" || g === "male" || g === "neutral" ? g : null,
  }
}

export function listSiriVoices(dirs = ASSET_DIRS): SystemVoice[] {
  if (process.platform !== "darwin") return []
  const out = new Map<string, SystemVoice>()
  for (const dir of dirs) {
    let assets: string[] = []
    try { assets = readdirSync(dir).filter((a) => a.endsWith(".asset")) } catch { continue }
    for (const a of assets) {
      try {
        const v = parseSiriAsset(readFileSync(join(dir, a, "Info.plist"), "utf8"))
        if (v) out.set(v.id, v)
      } catch { /* an asset being downloaded has no Info.plist yet */ }
    }
  }
  return [...out.values()]
}

// --- The Spoken Content preference ---

const DOMAIN = "com.apple.Accessibility"
const KEY = "SpokenContentDefaultVoiceSelectionsByLanguage"

const run = (cmd: string, args: string[], input?: string) => new Promise<string>((resolve, reject) => {
  const p = execFile(cmd, args, { timeout: 5_000 }, (err, out) => (err ? reject(err) : resolve(String(out))))
  if (input !== undefined) p.stdin?.end(input)
})

/** The preference: as `defaults read` prints it (what is written back to
 *  restore it), and parsed: language, selection, language, selection… */
export interface PrefValue { text: string; entries: unknown[] }

/** Reads and writes the preference; replaced in tests. */
export interface SpokenContentPref {
  /** Null when unset. */
  read(): Promise<PrefValue | null>
  /** Write a value in the text form `read` returns; null deletes it. */
  write(text: string | null): Promise<void>
}

export const defaultsPref: SpokenContentPref = {
  read: async () => {
    const text = await run("defaults", ["read", DOMAIN, KEY]).then((t) => t.trim(), () => null)
    if (text === null) return null
    const entries = JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", "-"], text))
    return { text, entries: Array.isArray(entries) ? entries : [] }
  },
  write: async (text) => {
    if (text === null) await run("defaults", ["delete", DOMAIN, KEY]).catch(() => {})
    else await run("defaults", ["write", DOMAIN, KEY, text])
  },
}

/** The language a selection is filed under: "en" for en-US. */
export const prefLanguage = (voiceId: string) => /_([a-z]{2,3})-[A-Z]{2}_premium$/.exec(voiceId)?.[1] ?? "en"

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
function oldStyle(v: unknown): string {
  if (Array.isArray(v)) return `(${v.map(oldStyle).join(", ")})`
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${quote(k)} = ${oldStyle(x)};`).join(" ")} }`
  return quote(String(v))
}

/** The preference with `voiceId` selected for its language, every other
 *  language left as the user set it. Null when it already is selected. */
export function selecting(voiceId: string, current: PrefValue | null): string | null {
  const entries = [...(current?.entries ?? [])]
  const lang = prefLanguage(voiceId)
  const selection = { _type: "Speech.VoiceSelection", _version: "0", voiceId }
  const at = entries.findIndex((e, i) => i % 2 === 0 && e === lang)
  if (at >= 0 && (entries[at + 1] as { voiceId?: string } | undefined)?.voiceId === voiceId) return null
  if (at >= 0) entries[at + 1] = selection
  else entries.push(lang, selection)
  return oldStyle(entries)
}

// --- The lock ---

const LOCK = join(homedir(), ".agentx", "voice", "siri.lock")

interface Held { pid: number; saved: PrefValue | null }

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === "EPERM" } }

/** Take the lock, waiting for another speaker to finish; false when it
 *  is still held after `waitMs` or the wait is `cancelled`. A dead
 *  holder's saved preference is put back before the lock is taken over. */
export async function acquireLock(pref: SpokenContentPref, lock = LOCK, waitMs = 30_000, cancelled = () => false): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(join(lock, ".."), { recursive: true })
      mkdirSync(lock)
      return true
    } catch (e: any) {
      if (e?.code !== "EEXIST") return false
    }
    let held: Held | null = null
    try { held = JSON.parse(readFileSync(join(lock, "held.json"), "utf8")) } catch { /* being written */ }
    if (held && !alive(held.pid)) {
      await pref.write(held.saved?.text ?? null).catch(() => {})
      rmSync(lock, { recursive: true, force: true })
      continue
    }
    if (Date.now() > deadline || cancelled()) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

function recordSaved(lock: string, saved: PrefValue | null): void {
  writeFileSync(join(lock, "held.json"), JSON.stringify({ pid: process.pid, saved } satisfies Held))
}

export const releaseLock = (lock = LOCK) => rmSync(lock, { recursive: true, force: true })

// --- Speaking a line ---

export interface SiriDeps {
  pref?: SpokenContentPref
  lock?: string
  spawnSay?: () => ChildProcess
  warn?: (msg: string) => void
}

/**
 * Speak `text` in the Siri voice `voiceId`. Behaves like the `say` process
 * it wraps: "close" with the exit code when done, kill() to cut it off.
 * The user's own selection is back in place before "close" is emitted.
 */
export function siriSay(voiceId: string, text: string, deps: SiriDeps = {}): ChildProcess {
  const pref = deps.pref ?? defaultsPref
  const lock = deps.lock ?? LOCK
  const warn = deps.warn ?? (() => {})
  const ev = new EventEmitter() as EventEmitter & { kill(): boolean }
  let killed = false
  let say: ChildProcess | null = null
  ev.kill = () => { killed = true; say?.kill(); return true }

  void (async () => {
    let locked = false
    let saved: PrefValue | null = null
    let changed = false
    let code: number | null = 1
    try {
      locked = await acquireLock(pref, lock, undefined, () => killed)
      if (killed) return
      if (!locked) warn("[voice] another speaker still holds the Siri voice lock; speaking in the current system voice")
      if (killed) return
      if (locked) {
        saved = await pref.read()
        recordSaved(lock, saved)
        const next = selecting(voiceId, saved)
        if (next !== null) { await pref.write(next); changed = true }
      }
      if (killed) return
      say = (deps.spawnSay ?? (() => spawn("say", [], { stdio: ["pipe", "ignore", "ignore"] })))()
      say.stdin?.on("error", () => {})
      say.stdin?.end(text)
      code = await new Promise<number | null>((resolve) => {
        say!.on("error", () => resolve(1))
        say!.on("close", (c) => resolve(c))
      })
    } catch (e: any) {
      warn(`[voice] could not switch to the Siri voice: ${String(e?.message ?? e).split("\n")[0]}`)
    } finally {
      if (changed) await pref.write(saved?.text ?? null).catch((e) => warn(`[voice] could not restore the system voice: ${e?.message ?? e}`))
      if (locked) releaseLock(lock)
      ev.emit("close", killed ? null : code)
    }
  })()
  return ev as unknown as ChildProcess
}
