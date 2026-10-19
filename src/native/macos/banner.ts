import { findHelper } from "@/desktop/install"
import type { BannerStatus, NativeBanner } from "../types"
import { capture as defaultCapture, run as defaultRun, type Capture, type Run } from "./run"

// The banner is posted by the AgentX Helper app when it is installed, so it
// carries the helper's icon (the AgentX logo by default). Without the
// helper, or before macOS has allowed it to notify, osascript posts it, and
// macOS shows it as coming from Script Editor.

export interface BannerIo {
  run?: Run
  capture?: Capture
  /** The helper binary; null means none. Unset: looked up on each use. */
  helper?: string | null
}

const helperOf = (io: BannerIo): string | null => (io.helper === undefined ? findHelper() : io.helper)

/** What the helper reports about its notification permission. Never shows
 *  the macOS "allow notifications" prompt and never posts a banner. */
export async function helperBannerStatus(path: string | null, capture: Capture = defaultCapture): Promise<BannerStatus> {
  if (!path) return "missing"
  const out = await capture(path, ["notify-status"])
  let status: { authorization?: string; alertStyle?: string } | null = null
  try { status = out ? JSON.parse(out) : null } catch { status = null }
  if (!status) return "outdated"
  if (status.authorization === "notDetermined") return "not-asked"
  if (status.authorization === "denied") return "not-allowed"
  if (status.alertStyle === "none") return "hidden"
  return "ready"
}

export function macosBanner(io: BannerIo = {}): NativeBanner {
  const exec = io.run ?? defaultRun
  return {
    async post({ title, message }) {
      const helper = helperOf(io)
      // A non-zero exit is usually "not allowed to notify yet" (the first
      // banner asks), so this one goes through osascript instead.
      if (helper && await exec(helper, ["notify", "--title", title, "--message", message])) return "posted"
      // Title and message travel as argv, never spliced into the script,
      // so a quote in either cannot turn into AppleScript.
      const ok = await exec("/usr/bin/osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title, message,
      ])
      return ok ? "posted" : "failed"
    },
    status: () => helperBannerStatus(helperOf(io), io.capture),
  }
}
