import { execFile } from "child_process"
import { findHelper } from "./local"

// Why a banner shows the Script Editor icon instead of the AgentX logo,
// in words a person can act on. `agentx notify` falls back to osascript
// silently — it must never fail to notify — so this is where the reason
// surfaces: `agentx notifications show` and `agentx doctor` print it.
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

/** Runs a command and resolves its stdout, or null when it failed. */
type Capture = (file: string, args: string[]) => Promise<string | null>

const capture: Capture = (file, args) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: 5_000 }, (err, stdout) => done(err ? null : String(stdout)))
    } catch {
      done(null)
    }
  })

const SETTINGS = "Open System Settings › Notifications › AgentX Helper, turn on Allow notifications and choose Banners."

export async function helperStatus(
  deps: { platform?: NodeJS.Platform; helper?: string | null; run?: Capture } = {},
): Promise<HelperStatus> {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { state: "unsupported", message: "Desktop banners are only shown on a Mac." }
  }
  const path = deps.helper === undefined ? findHelper() : deps.helper
  if (!path) {
    return {
      state: "missing",
      message: "AgentX Helper is not installed, so banners come from Script Editor and show its icon.",
      fix: "Run agentx desktop install, then run agentx notify \"Hello\" --title \"Test\" and click Allow.",
    }
  }
  const out = await (deps.run ?? capture)(path, ["notify-status"])
  let status: { authorization?: string; alertStyle?: string } | null = null
  try { status = out ? JSON.parse(out) : null } catch { status = null }
  if (!status) {
    return {
      state: "outdated",
      path,
      message: "AgentX Helper is too old to report whether it may notify.",
      fix: "Run agentx desktop install to update it.",
    }
  }
  if (status.authorization === "notDetermined") {
    return {
      state: "not-asked",
      path,
      message: "macOS has not asked yet whether AgentX Helper may notify; banners show the Script Editor icon until it does.",
      fix: "Run agentx notify \"Hello\" --title \"Test\" and click Allow when macOS asks.",
    }
  }
  if (status.authorization === "denied") {
    return { state: "not-allowed", path, message: "macOS does not allow AgentX Helper to notify, so banners show the Script Editor icon.", fix: SETTINGS }
  }
  if (status.alertStyle === "none") {
    return { state: "hidden", path, message: "AgentX Helper may notify, but its banner style is None, so nothing appears on screen.", fix: SETTINGS }
  }
  return { state: "ready", path, message: "AgentX Helper posts banners with the AgentX icon." }
}
