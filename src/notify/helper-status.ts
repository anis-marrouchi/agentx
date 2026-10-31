import { helperInstallHint } from "@/computer-use/helper"
import { findHelper } from "@/desktop/install"
import { loadNativeAdapter, type NativeIo } from "@/native"

// Why a banner shows the Script Editor icon instead of the AgentX logo,
// in words a person can act on. `agentx notify` falls back to Script
// Editor silently — it must never fail to notify — so this is where the
// reason surfaces: `agentx notifications show` and `agentx doctor` print it.
//
// Reading the status never posts a banner and never shows the macOS
// "allow notifications" prompt. The words follow the native adapter's OS:
// on Windows the fallback is Windows PowerShell, not Script Editor (#1594).

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

/** The OS-specific words, picked by the native adapter's os. */
interface Words {
  fallback: string
  settings: string
  missingFix: string
  updateFix: string
  osName: string
}

const TEST = 'run agentx notify "Hello" --title "Test"'

function wordsFor(os: string, platform: NodeJS.Platform): Words {
  if (os === "windows") {
    return {
      fallback: "Windows PowerShell, and show its name",
      settings: "Open Settings › System › Notifications, turn notifications on, then turn on AgentX Helper and its banners.",
      missingFix: `${helperInstallHint(platform)} Then ${TEST}.`,
      updateFix: `${helperInstallHint(platform).replace(/^Put /, "Put a newer ")}`,
      osName: "Windows",
    }
  }
  return {
    fallback: "Script Editor and show its icon",
    settings: "Open System Settings › Notifications › AgentX Helper, turn on Allow notifications and choose Banners.",
    missingFix: `Run agentx desktop install, then ${TEST} and click Allow.`,
    updateFix: "Run agentx desktop install to update it.",
    osName: "macOS",
  }
}

export async function helperStatus(
  deps: { platform?: NodeJS.Platform; helper?: string | null; run?: NativeIo["capture"] } = {},
): Promise<HelperStatus> {
  const platform = deps.platform ?? process.platform
  const path = deps.helper === undefined ? findHelper() : deps.helper
  const adapter = loadNativeAdapter({}, { platform, io: { capture: deps.run, helper: path } })
  const banner = adapter.banner
  if (!banner) {
    return { state: "unsupported", message: "Desktop banners are only shown on macOS and Windows." }
  }
  const w = wordsFor(adapter.os, platform)
  const state = await banner.status()
  if (state === "missing") {
    return {
      state: "missing",
      message: `AgentX Helper is not installed, so banners come from ${w.fallback}.`,
      fix: w.missingFix,
    }
  }
  if (state === "outdated") {
    return {
      state: "outdated",
      path: path!,
      message: "AgentX Helper is too old to report whether it may notify.",
      fix: w.updateFix,
    }
  }
  if (state === "not-asked") {
    return {
      state: "not-asked",
      path: path!,
      message: `${w.osName} has not asked yet whether AgentX Helper may notify; banners come from ${w.fallback} until it does.`,
      fix: `${TEST[0].toUpperCase()}${TEST.slice(1)} and click Allow when ${w.osName} asks.`,
    }
  }
  if (state === "not-allowed") {
    return { state: "not-allowed", path: path!, message: `${w.osName} does not allow AgentX Helper to notify, so banners come from ${w.fallback}.`, fix: w.settings }
  }
  if (state === "hidden") {
    return { state: "hidden", path: path!, message: "AgentX Helper may notify, but its banner style is None, so nothing appears on screen.", fix: w.settings }
  }
  return { state: "ready", path: path!, message: "AgentX Helper posts banners with the AgentX icon." }
}
