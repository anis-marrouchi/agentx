import type { NativeBanner } from "../types"
import { helperBannerStatus } from "../macos/banner"
import { capture as defaultCapture, run as defaultRun, type Capture, type Run } from "../macos/run"
import { POWERSHELL, psArgs, psString } from "./powershell"

// A Windows toast. The AgentX Windows helper posts it when installed, so it
// carries the helper's name; without it, PowerShell posts it and Windows
// shows it as coming from Windows PowerShell. The helper answers the same
// `notify` / `notify-status` verbs as the macOS one (computer-use/contract.ts).

/** Windows PowerShell's own app id, which may post toasts with no setup. */
export const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

/** The PowerShell that shows one toast with a title line and a message line. */
export function toastScript(title: string, message: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x = $t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode(${psString(title)})) | Out-Null`,
    `$x.Item(1).AppendChild($t.CreateTextNode(${psString(message)})) | Out-Null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
  ].join("\n")
}

export interface WindowsBannerIo {
  run?: Run
  capture?: Capture
  /** The helper binary; null means none. */
  helper: () => string | null
}

export function windowsBanner(io: WindowsBannerIo): NativeBanner {
  const exec = io.run ?? defaultRun
  return {
    async post({ title, message }) {
      const helper = io.helper()
      if (helper && await exec(helper, ["notify", "--title", title, "--message", message])) return "posted"
      return (await exec(POWERSHELL, psArgs(toastScript(title, message)))) ? "posted" : "failed"
    },
    status: () => helperBannerStatus(io.helper(), io.capture ?? defaultCapture),
  }
}
