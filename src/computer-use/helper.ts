import { join, win32 } from "path"

// --- Which desktop helper this machine runs (#1594) ---
//
// Computer use talks to one native CLI by subcommand, JSON on stdout (the
// verbs are listed in ./contract.ts). macOS has the Swift helper in
// apps/mac-helper. Windows gets its own binary that answers the same verbs,
// so point, teach and act stay the same code on both. This file only picks
// the binary; it never runs it.

export type HelperOs = "macos" | "windows"

/** The helper family for this platform, or null where AgentX has none yet. */
export function helperOs(platform: NodeJS.Platform): HelperOs | null {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return null
}

/** Where the Windows helper is installed for one user. */
export const WINDOWS_HELPER_EXE = "agentx-helper.exe"
export function installedWindowsHelper(localAppData: string): string {
  return win32.join(localAppData, "Programs", "AgentX", WINDOWS_HELPER_EXE)
}

export const MAC_HELPER_APP = "AgentX Helper.app"
export function installedMacHelper(home: string): string {
  return join(home, "Applications", MAC_HELPER_APP, "Contents/MacOS/agentx-mac-helper")
}

/** An explicit helper path from the environment. AGENTX_DESKTOP_HELPER
 *  works on every OS; AGENTX_MAC_HELPER is the older name, still read on
 *  a Mac so existing login items keep working. */
export function helperOverride(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const any = env.AGENTX_DESKTOP_HELPER?.trim()
  if (any) return any
  const mac = env.AGENTX_MAC_HELPER?.trim()
  return mac && helperOs(platform) === "macos" ? mac : undefined
}

export interface HelperLookup {
  platform: NodeJS.Platform
  /** The AgentX package folder, or null when it can't be found. */
  root: string | null
  home: string
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
}

/** The helper to run: an explicit path, else the installed one, else one
 *  built inside the package. On a platform without a helper the answer is
 *  null, and callers say so with helperMissingMessage. */
export function resolveDesktopHelper(l: HelperLookup): string | null {
  const override = helperOverride(l.platform, l.env)
  if (override) return override
  const os = helperOs(l.platform)
  if (os === "macos") {
    const installed = installedMacHelper(l.home)
    if (l.exists(installed) || !l.root) return installed
    return join(l.root, "apps/mac-helper/build", MAC_HELPER_APP, "Contents/MacOS/agentx-mac-helper")
  }
  if (os === "windows") {
    const localAppData = l.env.LOCALAPPDATA || win32.join(l.home, "AppData", "Local")
    const installed = installedWindowsHelper(localAppData)
    if (l.exists(installed) || !l.root) return installed
    return win32.join(l.root, "apps", "win-helper", "build", WINDOWS_HELPER_EXE)
  }
  return null
}

/** What to tell someone whose helper is not there, in plain words. */
export function helperMissingMessage(platform: NodeJS.Platform): string {
  const os = helperOs(platform)
  if (os === "macos") return "helper not built — run apps/mac-helper/build.sh (or agentx desktop install)"
  if (os === "windows") {
    return `Windows helper not found — put ${WINDOWS_HELPER_EXE} in %LOCALAPPDATA%\\Programs\\AgentX, or set AGENTX_DESKTOP_HELPER to its path`
  }
  return `computer use (point, teach, act) is not available on ${platform} yet — macOS now, Windows in progress (#1594)`
}
