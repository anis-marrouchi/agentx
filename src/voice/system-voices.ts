// --- The free voices that ship with macOS ---
//
// Every Mac has a few dozen voices installed and can download Premium and
// Enhanced ones for nothing (System Settings → Accessibility → Spoken
// Content → Manage Voices). They are the default, so voice works with no
// account and no key; ElevenLabs is an opt-in upgrade.
//
// `say -v '?'` lists names but neither quality nor gender, so the list
// comes from AVSpeechSynthesisVoice through JXA instead. Two traps shape
// what is offered:
//   - `say -v <unknown>` exits 0 and quietly uses the default voice, so a
//     configured name is always checked against this list first.
//   - Siri voices appear in the list but third-party apps cannot use them
//     (`say` falls back or fails), and the novelty voices (Bells, Zarvox…)
//     are jokes, not voices for an assistant. Both are left out.

import { execFile, execFileSync } from "child_process"

export type Gender = "female" | "male" | "neutral" | null

export interface SystemVoice {
  /** What `say -v` takes; unambiguous across languages. */
  id: string
  name: string
  /** BCP 47, e.g. "en-GB". */
  locale: string
  quality: "premium" | "enhanced" | "standard"
  gender: Gender
}

const JXA = `ObjC.import("AVFoundation")
const vs = $.AVSpeechSynthesisVoice.speechVoices, out = []
for (let i = 0; i < vs.count; i++) {
  const v = vs.objectAtIndex(i)
  out.push([v.identifier.js, v.name.js, v.language.js, Number(v.quality), Number(v.gender)].join("\\t"))
}
out.join("\\n")`

/** The classic voices worth keeping; the rest of that family are novelties. */
const CLASSIC = new Set(["Fred", "Kathy", "Ralph", "Junior"])
/** AVSpeech reports no gender for these families. */
const GENDER: Record<string, Gender> = {
  Flo: "female", Sandy: "female", Shelley: "female", Grandma: "female", Kathy: "female",
  Eddy: "male", Reed: "male", Rocko: "male", Grandpa: "male", Fred: "male", Ralph: "male", Junior: "male",
}

/** Parse the JXA output: id, name, language, quality (1–3), gender (0–2). */
export function parseVoiceList(out: string): SystemVoice[] {
  const voices: SystemVoice[] = []
  for (const line of out.split("\n")) {
    const [id, name, locale, q, g] = line.split("\t")
    if (!id || !name || !locale) continue
    if (id.includes(".siri_")) continue
    if (id.startsWith("com.apple.speech.synthesis.voice.") && !CLASSIC.has(name)) continue
    voices.push({
      id, name, locale,
      quality: q === "3" ? "premium" : q === "2" ? "enhanced" : "standard",
      gender: g === "1" ? "male" : g === "2" ? "female" : GENDER[name] ?? null,
    })
  }
  return voices
}

// --- Installed voices, cached ---
//
// Listing takes a few hundred milliseconds, so it runs once and is then
// refreshed in the background: a Premium voice downloaded while the daemon
// runs is picked up within REFRESH_MS without stalling a spoken turn.

const REFRESH_MS = 10 * 60 * 1000
let cached: { at: number; voices: SystemVoice[] } | null = null
let refreshing = false

export function listSystemVoices(now = Date.now()): SystemVoice[] {
  if (process.platform !== "darwin") return []
  if (!cached) {
    try {
      cached = { at: now, voices: parseVoiceList(execFileSync("osascript", ["-l", "JavaScript", "-e", JXA], { encoding: "utf8", timeout: 10_000 })) }
    } catch (e: any) {
      voiceLog(`[voice] could not list system voices: ${String(e?.message ?? e).split("\n")[0]}`)
      cached = { at: now, voices: [] }
    }
  } else if (now - cached.at > REFRESH_MS && !refreshing) {
    refreshing = true
    execFile("osascript", ["-l", "JavaScript", "-e", JXA], { timeout: 10_000 }, (err, out) => {
      refreshing = false
      if (!err) cached = { at: Date.now(), voices: parseVoiceList(String(out)) }
    })
  }
  return cached.voices
}

// --- Logging, once per problem ---

let voiceLog: (msg: string) => void = (m) => process.stderr.write(m + "\n")
const warned = new Set<string>()

/** The daemon routes voice warnings into its own log. */
export function setVoiceLog(fn: (msg: string) => void): void { voiceLog = fn }

export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  voiceLog(msg)
}

// --- Choosing voices ---

const QUALITY = { premium: 3, enhanced: 2, standard: 1 } as const

/** Character voices: fine for fun, last choice for an assistant. */
const CHARACTER = new Set(["Grandma", "Grandpa"])

/** Better first: quality tier, then modern over the older families. */
export function rank(v: SystemVoice): number {
  const family = v.id.startsWith("com.apple.voice.") ? 2
    : v.id.startsWith("com.apple.eloquence.") && !CHARACTER.has(v.name) ? 1 : 0
  return QUALITY[v.quality] * 10 + family
}

const language = (locale: string) => locale.toLowerCase().split(/[-_]/)[0]

/** Voices in the configured language (e.g. "en", "fr-FR"), best first; all
 *  of them if none match, so a mislabelled locale still speaks. */
export function candidates(installed: SystemVoice[], locale = "en"): SystemVoice[] {
  const exact = locale.toLowerCase().replace("_", "-")
  const lang = language(locale)
  const pool = installed.filter((v) => language(v.locale) === lang)
  return (pool.length ? pool : installed).slice().sort((a, b) =>
    rank(b) - rank(a)
    || Number(b.locale.toLowerCase() === exact) - Number(a.locale.toLowerCase() === exact)
    || a.name.localeCompare(b.name) || a.locale.localeCompare(b.locale))
}

/**
 * The installed voice a configured name means, or null.
 *
 * Accepts an identifier, a plain name ("Daniel"), a tier suffix as System
 * Settings shows it ("Ava (Premium)"), or `say`'s language suffix
 * ("Eddy (English (US))"). A name several locales share resolves to the
 * best one in the configured language.
 */
export function findVoice(name: string, installed: SystemVoice[], locale = "en"): SystemVoice | null {
  const q = name.trim()
  if (!q) return null
  const byId = installed.find((v) => v.id === q)
  if (byId) return byId
  const tier = /^(.+?)\s*\((premium|enhanced)\)$/i.exec(q)
  const base = (tier ? tier[1] : q.replace(/\s*\(.*\)\s*$/, "")).trim().toLowerCase()
  const named = candidates(installed.filter((v) => v.name.toLowerCase() === base), locale)
  const wanted = tier ? named.find((v) => v.quality === tier[2].toLowerCase()) : undefined
  return wanted ?? named[0] ?? null
}

export interface CastEntry {
  id: string
  gender?: Gender
}

/**
 * A distinct voice for each entry, in order: the best remaining voice of
 * the entry's gender, or alternating female and male when it has none, so
 * two agents in a row never sound alike. Distinct means a different NAME:
 * Eddy in en-GB and Eddy in en-US are the same speaker. Names in `taken`
 * (pinned by other agents) are used only once every other voice is; with
 * more agents than voices, voices repeat.
 */
export function castVoices(entries: CastEntry[], pool: SystemVoice[], taken: Set<string> = new Set()): Map<string, SystemVoice> {
  const cast = new Map<string, SystemVoice>()
  if (!pool.length) return cast
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  let turn: "female" | "male" = "female"
  for (const e of entries) {
    const want = e.gender === "female" || e.gender === "male" ? e.gender : turn
    const free = pool.filter((v) => !used.has(v.name.toLowerCase()))
    const pick = free.find((v) => v.gender === want) ?? free[0] ?? pool[cast.size % pool.length]
    cast.set(e.id, pick)
    used.add(pick.name.toLowerCase())
    if (!e.gender || e.gender === "neutral") turn = turn === "female" ? "male" : "female"
  }
  return cast
}
