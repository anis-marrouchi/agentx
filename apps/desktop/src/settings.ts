// The person's choices from the tray menu, kept in a JSON file in the app's
// userData folder so they survive a restart. Kept free of Electron so the
// rules can be tested with plain Node (test/settings.test.mjs).

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

export type CloseAction = "hide" | "quit"

export interface AppSettings {
  /** Start the app when the person logs in (macOS and Windows). */
  openAtLogin: boolean
  /** Show the Hub window when the app starts; off starts in the tray only. */
  showOnLaunch: boolean
  /** What closing the window does: hide it to the tray, or quit the app. */
  closeAction: CloseAction
}

export const DEFAULT_SETTINGS: AppSettings = { openAtLogin: false, showOnLaunch: true, closeAction: "hide" }

export const SETTINGS_FILE = "settings.json"

export function settingsPath(userData: string): string {
  return join(userData, SETTINGS_FILE)
}

/** Known keys with the right type win; anything else falls back to the default. */
export function parseSettings(raw: unknown): AppSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    openAtLogin: typeof o.openAtLogin === "boolean" ? o.openAtLogin : DEFAULT_SETTINGS.openAtLogin,
    showOnLaunch: typeof o.showOnLaunch === "boolean" ? o.showOnLaunch : DEFAULT_SETTINGS.showOnLaunch,
    closeAction: o.closeAction === "hide" || o.closeAction === "quit" ? o.closeAction : DEFAULT_SETTINGS.closeAction,
  }
}

/** Reads the file; a missing or broken file gives the defaults. */
export function loadSettings(userData: string, onError?: (err: unknown) => void): AppSettings {
  const file = settingsPath(userData)
  try {
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
    return parseSettings(JSON.parse(readFileSync(file, "utf8")))
  } catch (err) {
    onError?.(err)
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(userData: string, settings: AppSettings): void {
  writeFileSync(settingsPath(userData), JSON.stringify(settings, null, 2) + "\n")
}
