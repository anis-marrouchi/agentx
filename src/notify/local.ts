import { execFile } from "child_process"
import { existsSync } from "fs"

// What happens on THIS machine when a notification is delivered: a banner
// on screen and a short sound. The push goes to the phone; these are for
// the person sitting at the Mac that raised the event.
//
// Both are awaited rather than fired and forgotten. A caller that exits
// straight after notifying — a `launchctl submit` job that removes itself,
// a cron one-liner — used to take the sound down with it before it
// played. Waiting costs about a second and makes the step reliable.
//
// Never fatal: a notification whose banner failed still arrived, and no
// caller should have to handle an audio error to say a build finished.

export interface LocalSettings {
  /** Show a desktop banner (macOS only; other platforms skip it). */
  banner: boolean
  /** Play a sound (macOS only). */
  sound: boolean
  /** A macOS system sound, by name: /System/Library/Sounds/<name>.aiff. */
  soundName: string
  /** 0 (silent) … 1 (full). */
  volume: number
}

/** Glass is the gentlest system sound that is still audible over a
 *  keyboard — Basso and Sosumi are alerts, Funk and Frog are jokes, and
 *  Ping is the one every other app already uses. */
export const DEFAULT_LOCAL: LocalSettings = { banner: true, sound: true, soundName: "Glass", volume: 0.4 }

/** Shows the banner and plays the sound for one delivered notification. */
export type LocalAlert = (title: string, message: string) => Promise<void>

type Run = (file: string, args: string[]) => Promise<void>

/** Neither step may hold a caller hostage: afplay on a long custom sound,
 *  or osascript stuck on a permission prompt, is cut off here. */
const STEP_TIMEOUT_MS = 5_000

const run: Run = (file, args) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: STEP_TIMEOUT_MS }, () => done())
    } catch {
      done() // no osascript / afplay on this machine — not worth reporting
    }
  })

/** Fill gaps in a partial `notifications.local` block with the defaults. */
export function localSettings(cfg: Partial<LocalSettings> | undefined): LocalSettings {
  return { ...DEFAULT_LOCAL, ...(cfg ?? {}) }
}

/** The system sound file for a name, or null when there is none. Names
 *  only — a path in the config must not reach afplay. */
export function soundPath(name: string): string | null {
  if (!/^[\w -]+$/.test(name)) return null
  const path = `/System/Library/Sounds/${name}.aiff`
  return existsSync(path) ? path : null
}

export function localAlert(
  settings: LocalSettings,
  deps: { run?: Run; platform?: NodeJS.Platform } = {},
): LocalAlert {
  const exec = deps.run ?? run
  const platform = deps.platform ?? process.platform
  return async (title, message) => {
    if (platform !== "darwin") return
    const steps: Promise<void>[] = []
    if (settings.banner) {
      // Title and message travel as argv, never spliced into the script,
      // so a quote in either cannot turn into AppleScript.
      steps.push(exec("/usr/bin/osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title, message,
      ]))
    }
    const path = settings.sound ? soundPath(settings.soundName) : null
    if (path) {
      const volume = Math.min(1, Math.max(0, settings.volume))
      steps.push(exec("/usr/bin/afplay", ["-v", String(volume), path]))
    }
    await Promise.all(steps)
  }
}

/**
 * Apply a change to a stored `notifications.local` block, the one rule
 * both the CLI and the dashboard write through. Returns the new block;
 * throws on a value that would not load. Only a Mac has sounds to check a
 * name against — elsewhere the setting is inert, so it need only be
 * well-formed.
 */
export function patchLocal(
  current: Partial<LocalSettings> | undefined,
  patch: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): Partial<LocalSettings> {
  const next = { ...(current ?? {}) }
  if ("banner" in patch) next.banner = Boolean(patch.banner)
  if ("sound" in patch) next.sound = Boolean(patch.sound)
  if ("soundName" in patch) {
    const name = String(patch.soundName).trim()
    const ok = platform === "darwin" ? soundPath(name) !== null : /^[\w -]+$/.test(name)
    if (!ok) throw new Error(`no system sound named "${name}" in /System/Library/Sounds`)
    next.soundName = name
  }
  if ("volume" in patch) {
    const v = Number(patch.volume)
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("volume must be between 0 and 1")
    next.volume = v
  }
  return next
}
