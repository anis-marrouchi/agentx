// --- Siri voices, spoken by switching the OS default voice ---
//
// `say -v` cannot use the Siri neural voices, but `say` with no -v reads
// the Spoken Content default (com.apple.Accessibility
// SpokenContentDefaultVoiceSelectionsByLanguage) afresh on every run. So a
// Siri line is: take the lock, save the user's selection, write the Siri
// voice under the system language (the only key `say` reads, whatever
// language the text is in), run `say`, put the saved selection back.
//
// The pref is global, so every `say` that follows it goes through the one
// script below, from the daemon and from the Mac voice app alike: they
// share the lock and never race. A run killed mid-line leaves its saved
// selection behind; the next run restores it before anything else.

import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { SystemVoice } from "./system-voices"

/** How a config names a Siri voice: "siri:aaron". */
export const SIRI_PREFIX = "siri:"
const ID_PREFIX = "com.apple.ttsbundle.gryphon-neural_"

export const isSiriVoice = (id: string | null | undefined): id is string => !!id && id.startsWith(ID_PREFIX)

// --- Can this host switch voices at all? ---
//
// Only on macOS, and only when the pieces are really there, not because
// of a version number: `say`, `defaults` and `plutil`, and the Spoken
// Content pref domain. Anywhere else (Linux, an older macOS) Siri voices
// are simply not offered, a configured siri:<name> falls back like any
// voice that is not installed, and no pref is ever written.

export interface SiriHost {
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  /** True when the com.apple.Accessibility pref domain can be read. */
  prefDomain?: () => boolean
}

const TOOLS = ["/usr/bin/say", "/usr/bin/defaults", "/usr/bin/plutil"]

const readPrefDomain = () => {
  try {
    execFileSync("/usr/bin/defaults", ["read", "com.apple.Accessibility"], { stdio: "ignore", timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

let supported: boolean | undefined

/** Whether Siri voices can be spoken here; checked once per process. */
export function siriSupported(host: SiriHost = {}): boolean {
  const probe = host.platform !== undefined || host.exists !== undefined || host.prefDomain !== undefined
  if (!probe && supported !== undefined) return supported
  const { platform = process.platform, exists = existsSync, prefDomain = readPrefDomain } = host
  const ok = platform === "darwin" && TOOLS.every((t) => exists(t)) && prefDomain()
  if (!probe) supported = ok
  return ok
}

/** Where MobileAsset keeps the downloaded Siri voices. */
const ASSET_DIRS = [
  "/System/Library/AssetsV2/com_apple_MobileAsset_Trial_Siri_SiriTextToSpeech/purpose_auto",
  "/System/Library/AssetsV2/com_apple_MobileAsset_UAF_Siri_TextToSpeech/purpose_auto",
]

/** The assets name no gender; these are the voices System Settings offers. */
const GENDER: Record<string, SystemVoice["gender"]> = {
  aaron: "male", damon: "male", daniel: "male", pierre: "male", samer: "male", arthur: "male", gordon: "male", martin: "male",
  nora: "female", simone: "female", marie: "female", soha: "female", martha: "female", catherine: "female", helena: "female", nicky: "female",
}

/** A voice asset's specifier, e.g. "com.apple.siri.tts.voice.en_US.aaron.neural.premium-en_US-iPhone".
 *  Codenames ("fr-FR-D") are not voices System Settings offers, so they are skipped. */
const SPECIFIER = /com\.apple\.siri\.tts\.voice\.([a-z]{2})_([A-Z]{2})\.([a-z]+)\.neural\.premium/g

/** The Siri voices named in asset Info.plists, one per name and locale. */
export function parseSiriAssets(plists: string[]): SystemVoice[] {
  const seen = new Map<string, SystemVoice>()
  for (const text of plists) {
    for (const [, lang, region, name] of text.matchAll(SPECIFIER)) {
      const locale = `${lang}-${region}`
      const id = `${ID_PREFIX}${name}_${locale}_premium`
      if (seen.has(id)) continue
      seen.set(id, {
        id, name: name[0].toUpperCase() + name.slice(1), locale,
        quality: "premium", gender: GENDER[name] ?? null, siri: true,
      })
    }
  }
  return [...seen.values()]
}

/** Installed Siri voices. Binary plists keep strings as plain ASCII, so the
 *  specifier is found without converting each file. */
export function listSiriVoices(dirs = ASSET_DIRS, host: SiriHost = {}): SystemVoice[] {
  if (!siriSupported(host)) return []
  const plists: string[] = []
  for (const dir of dirs) {
    let assets: string[]
    try { assets = readdirSync(dir) } catch { continue }
    for (const a of assets) {
      try { plists.push(readFileSync(join(dir, a, "Info.plist"), "latin1")) } catch { /* not an asset */ }
    }
  }
  return parseSiriAssets(plists)
}

// --- Speaking ---

/** Text on stdin; $1 is a Siri voice id, or nothing for the OS default as
 *  it stands (still locked, so no switch is in effect while it speaks). */
export const SIRI_SAY = `#!/bin/sh
# Written by agentx; shared by the daemon and AgentX Voice. Do not edit.
D=com.apple.Accessibility K=SpokenContentDefaultVoiceSelectionsByLanguage
dir="$HOME/.agentx/voice" lock="$HOME/.agentx/voice/siri.lock" saved="$HOME/.agentx/voice/siri-saved.plist"
case "$1" in *[!A-Za-z0-9._-]*) echo "bad voice id" >&2; exit 2;; esac
# Not macOS, or no pref tools: speak as is and never touch a pref.
if [ "$(uname)" != Darwin ] || ! command -v defaults >/dev/null || ! command -v plutil >/dev/null; then exec say; fi
mkdir -p "$dir" || exit 1
say_pid=
restore() {
  [ -f "$saved" ] || return 0
  if [ -s "$saved" ]; then defaults write $D $K "$(cat "$saved")"; else defaults delete $D $K 2>/dev/null; fi
  rm -f "$saved"
}
finish() {
  [ -n "$say_pid" ] && kill "$say_pid" 2>/dev/null
  restore; rm -rf "$lock"; exit "$1"
}
# One speaker at a time. A lock whose owner died is taken over.
while ! mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$lock"
  elif [ -z "$owner" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rm -rf "$lock"
  else sleep 0.1; fi
done
echo $$ > "$lock/pid"
trap 'finish 143' TERM INT HUP
restore
if [ -n "$1" ]; then
  lang=$(defaults read -g AppleLanguages 2>/dev/null | sed -n '2s/^[^A-Za-z]*\\([A-Za-z]*\\).*/\\1/p')
  defaults export $D - 2>/dev/null | plutil -extract $K xml1 -o "$saved.tmp" - 2>/dev/null || : > "$saved.tmp"
  mv "$saved.tmp" "$saved"
  defaults write $D $K -array "\${lang:-en}" "{ _type = \\"Speech.VoiceSelection\\"; _version = 0; voiceId = \\"$1\\"; }"
fi
exec 3<&0
say <&3 & say_pid=$!
wait $say_pid
status=$?
say_pid=
finish $status
`

/** Where the script lives; AgentX Voice runs the same file. */
export const siriSayPath = (home = homedir()) => join(home, ".agentx", "voice", "siri-say.sh")

/** Write the script if it is missing or out of date; returns its path. */
export function ensureSiriSay(home = homedir()): string {
  const path = siriSayPath(home)
  if (existsSync(path) && readFileSync(path, "utf8") === SIRI_SAY) return path
  mkdirSync(join(home, ".agentx", "voice"), { recursive: true })
  writeFileSync(`${path}.tmp`, SIRI_SAY, { mode: 0o755 })
  renameSync(`${path}.tmp`, path)
  return path
}
