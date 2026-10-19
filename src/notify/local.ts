import { existsSync } from "fs"
import { homedir } from "os"
import { isAbsolute } from "path"
import { loadNativeAdapter, type NativeIo } from "@/native"

export { findHelper } from "@/desktop/install"

// What happens on THIS machine when a notification is delivered: a banner
// on screen and a short sound. The push goes to the phone; these are for
// the person sitting at the computer that raised the event. Both go
// through the native adapter (src/native); a machine without one skips
// them.
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
  /** A system sound, by name (on a Mac, one of the sounds in System Settings › Sound). */
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

/** Fill gaps in a partial `notifications.local` block with the defaults. */
export function localSettings(cfg: Partial<LocalSettings> | undefined): LocalSettings {
  return { ...DEFAULT_LOCAL, ...(cfg ?? {}) }
}

export function localAlert(
  settings: LocalSettings,
  deps: { run?: NativeIo["run"]; platform?: NodeJS.Platform; helper?: string | null } = {},
): LocalAlert {
  const native = loadNativeAdapter({}, { platform: deps.platform, io: { run: deps.run, helper: deps.helper } })
  return async (title, message) => {
    const steps: Promise<unknown>[] = []
    if (settings.banner && native.banner) steps.push(native.banner.post({ title, message }))
    if (settings.sound && native.sound) steps.push(native.sound.play(settings.soundName, settings.volume))
    await Promise.all(steps)
  }
}

/**
 * Apply a change to a stored `notifications.local` block, the one rule
 * both the CLI and the dashboard write through. Returns the new block;
 * throws on a value that would not load. Only a machine with a native
 * adapter has sounds to check a name against; elsewhere the setting is
 * inert, so it need only be well-formed.
 */
export function patchLocal(
  current: Partial<LocalSettings> | undefined,
  patch: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): Partial<LocalSettings> {
  const next = { ...(current ?? {}) }
  const native = loadNativeAdapter({}, { platform })
  if ("banner" in patch) next.banner = Boolean(patch.banner)
  if ("sound" in patch) next.sound = Boolean(patch.sound)
  if ("soundName" in patch) {
    const name = String(patch.soundName).trim()
    const ok = native.sound ? native.sound.has(name) : /^[\w -]+$/.test(name)
    if (!ok) throw new Error(`no system sound named "${name}"`)
    next.soundName = name
  }
  if ("icon" in patch) {
    const icon = String(patch.icon ?? "").trim().replace(/^~(?=\/)/, homedir())
    if (!icon) delete next.icon
    else {
      if (!isAbsolute(icon) || !/\.(png|jpe?g|icns)$/i.test(icon)) throw new Error("icon must be the full path to a .png, .jpg or .icns file")
      if (native.banner && !existsSync(icon)) throw new Error(`no icon file at ${icon}`)
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
