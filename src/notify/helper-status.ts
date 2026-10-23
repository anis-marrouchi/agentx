import { findHelper } from "@/desktop/install"
import { loadNativeAdapter, type NativeIo } from "@/native"

// Why a banner shows the Script Editor icon instead of the AgentX logo,
// in words a person can act on. `agentx notify` falls back to Script
// Editor silently — it must never fail to notify — so this is where the
// reason surfaces: `agentx notifications show` and `agentx doctor` print it.
//
// Reading the status never posts a banner and never shows the macOS
// "allow notifications" prompt.

export type HelperState = "ready" | "unsupported" | "missing" | "outdated" | "not-asked" | "not-allowed" | "hidden"

export interface HelperStatus {
  state: HelperState
  /** One plain sentence on what the person will see. */
  message: string
  /** What to do about it; absent when nothing needs doing. */
  fix?: string
  /** The helper binary that was checked, when there is one. */
  path?: string
}

const SETTINGS = "Open System Settings › Notifications › AgentX Helper, turn on Allow notifications and choose Banners."

export async function helperStatus(
  deps: { platform?: NodeJS.Platform; helper?: string | null; run?: NativeIo["capture"] } = {},
): Promise<HelperStatus> {
  const path = deps.helper === undefined ? findHelper() : deps.helper
  const banner = loadNativeAdapter({}, { platform: deps.platform, io: { capture: deps.run, helper: path } }).banner
  if (!banner) {
    return { state: "unsupported", message: "Desktop banners are only shown on a Mac." }
  }
  const state = await banner.status()
  if (state === "missing") {
    return {
      state: "missing",
      message: "AgentX Helper is not installed, so banners come from Script Editor and show its icon.",
      fix: "Run agentx desktop install, then run agentx notify \"Hello\" --title \"Test\" and click Allow.",
    }
  }
  if (state === "outdated") {
    return {
      state: "outdated",
      path: path!,
      message: "AgentX Helper is too old to report whether it may notify.",
      fix: "Run agentx desktop install to update it.",
    }
  }
  if (state === "not-asked") {
    return {
      state: "not-asked",
      path: path!,
      message: "macOS has not asked yet whether AgentX Helper may notify; banners show the Script Editor icon until it does.",
      fix: "Run agentx notify \"Hello\" --title \"Test\" and click Allow when macOS asks.",
    }
  }
  if (state === "not-allowed") {
    return { state: "not-allowed", path: path!, message: "macOS does not allow AgentX Helper to notify, so banners show the Script Editor icon.", fix: SETTINGS }
  }
  if (state === "hidden") {
    return { state: "hidden", path: path!, message: "AgentX Helper may notify, but its banner style is None, so nothing appears on screen.", fix: SETTINGS }
  }
  return { state: "ready", path: path!, message: "AgentX Helper posts banners with the AgentX icon." }
}
