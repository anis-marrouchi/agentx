import { execFile } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { isAbsolute } from "path"
import { resolveHelper } from "@/desktop/install"

// What happens on THIS machine when a notification is delivered: a banner
// on screen and a short sound. The push goes to the phone; these are for
// the person sitting at the Mac that raised the event.
//
// Both are awaited rather than fired and forgotten. A caller that exits
// straight after notifying — a `launchctl submit` job that removes itself,
// a cron one-liner — used to take the sound down with it before it
// played. Waiting costs about a second and makes the step reliable.
//
// The banner is posted by the AgentX Helper app when it is installed, so
// it carries the helper's icon (the AgentX logo by default). Without the
// helper, or before macOS has allowed it to notify, osascript posts it,
// and macOS shows it as coming from Script Editor.
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
  /** Image for the helper's app icon, which macOS puts on its banners.
   *  Unset: the AgentX logo. Applied when `agentx desktop install` builds
   *  the helper, since macOS reads the icon from the app, not the banner. */
  icon?: string
}

/** Glass is the gentlest system sound that is still audible over a
 *  keyboard — Basso and Sosumi are alerts, Funk and Frog are jokes, and
 *  Ping is the one every other app already uses. */
export const DEFAULT_LOCAL: LocalSettings = { banner: true, sound: true, soundName: "Glass", volume: 0.4 }

/** Shows the banner and plays the sound for one delivered notification. */
export type LocalAlert = (title: string, message: string) => Promise<void>

/** Runs a command; resolves true when it exited 0. */
type Run = (file: string, args: string[]) => Promise<boolean>

/** Neither step may hold a caller hostage: afplay on a long custom sound,
 *  or osascript stuck on a permission prompt, is cut off here. */
const STEP_TIMEOUT_MS = 5_000

const run: Run = (file, args) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: STEP_TIMEOUT_MS }, (err) => done(!err))
    } catch {
      done(false) // no osascript / afplay on this machine — not worth reporting
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

/** The AgentX Helper binary when one is built or installed, else null. */
export function findHelper(): string | null {
  const path = resolveHelper(process.cwd(), homedir())
  return existsSync(path) ? path : null
}

export function localAlert(
  settings: LocalSettings,
  deps: { run?: Run; platform?: NodeJS.Platform; helper?: string | null } = {},
): LocalAlert {
  const exec = deps.run ?? run
  const platform = deps.platform ?? process.platform
  const banner = async (title: string, message: string): Promise<void> => {
    const helper = deps.helper === undefined ? findHelper() : deps.helper
    // A non-zero exit is usually "not allowed to notify yet" — the first
    // banner asks — so this one goes through osascript instead.
    if (helper && await exec(helper, ["notify", "--title", title, "--message", message])) return
    // Title and message travel as argv, never spliced into the script,
    // so a quote in either cannot turn into AppleScript.
    await exec("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      title, message,
    ])
  }
  return async (title, message) => {
    if (platform !== "darwin") return
    const steps: Promise<unknown>[] = []
    if (settings.banner) steps.push(banner(title, message))
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
  if ("icon" in patch) {
    const icon = String(patch.icon ?? "").trim().replace(/^~(?=\/)/, homedir())
    if (!icon) delete next.icon
    else {
      if (!isAbsolute(icon) || !/\.(png|jpe?g|icns)$/i.test(icon)) throw new Error("icon must be the full path to a .png, .jpg or .icns file")
      if (platform === "darwin" && !existsSync(icon)) throw new Error(`no icon file at ${icon}`)
      next.icon = icon
    }
  }
  if ("volume" in patch) {
    const v = Number(patch.volume)
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("volume must be between 0 and 1")
    next.volume = v
  }
  return next
}
