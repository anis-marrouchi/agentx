// The tray menu as plain data: what it shows for the window, the daemon and
// the settings. Electron types only, so it can be tested with plain Node
// (test/menu.test.mjs).

import type { MenuItemConstructorOptions } from "electron"
import { canStop, type DaemonStatus } from "./daemon.js"
import type { AppSettings, CloseAction } from "./settings.js"

/** What the menu shows; the menu is built again whenever it changes. */
export interface TrayState {
  windowVisible: boolean
  daemon: DaemonStatus | null // null: not checked yet
  /** A Start / Stop / Restart is under way. */
  busy: string | null
  settings: AppSettings
  /** Open at login is not offered where Electron cannot set it (Linux). */
  loginItemSupported: boolean
}

export interface TrayActions {
  onToggleWindow: () => void
  onQuit: () => void
  onDaemon: (action: "start" | "stop" | "restart") => void
  onSetting: (change: Partial<AppSettings>) => void
}

function daemonLine(s: TrayState): string {
  if (s.busy) return `Daemon: ${s.busy}…`
  if (!s.daemon) return "Daemon: checking…"
  if (!s.daemon.running) return "Daemon: stopped"
  const by = s.daemon.service && s.daemon.service !== "none" ? ` (kept by ${s.daemon.service})` : ""
  return `Daemon: running${by}`
}

/** The menu, as plain data (no Electron calls), so its shape is easy to check. */
export function menuTemplate(s: TrayState, a: TrayActions): MenuItemConstructorOptions[] {
  const d = s.daemon
  const idle = !s.busy && d !== null
  const stopHint = !d?.running ? "Stop" : d.remote ? "Stop (on another machine)" : d.service && d.service !== "none" ? `Stop (kept running by ${d.service})` : "Stop"
  const close = (value: CloseAction): MenuItemConstructorOptions => ({
    label: value === "hide" ? "Hide to the tray" : "Quit the app",
    type: "radio",
    checked: s.settings.closeAction === value,
    click: () => a.onSetting({ closeAction: value }),
  })
  return [
    { label: s.windowVisible ? "Hide AgentX" : "Show AgentX", click: a.onToggleWindow },
    { type: "separator" },
    { label: daemonLine(s), enabled: false },
    { label: "Start", enabled: idle && !d?.running, click: () => a.onDaemon("start") },
    // A daemon under launchd/systemd comes straight back from a stop; Restart covers it.
    // A daemon on another machine: its pid is not a process here.
    { label: stopHint, enabled: idle && !!d && canStop(d), click: () => a.onDaemon("stop") },
    { label: "Restart", enabled: idle && !!d?.running, click: () => a.onDaemon("restart") },
    { type: "separator" },
    {
      label: "Open at login",
      type: "checkbox",
      checked: s.settings.openAtLogin,
      enabled: s.loginItemSupported,
      sublabel: s.loginItemSupported ? undefined : "Not available on Linux",
      click: (item) => a.onSetting({ openAtLogin: item.checked }),
    },
    {
      label: "Show the window at launch",
      type: "checkbox",
      checked: s.settings.showOnLaunch,
      click: (item) => a.onSetting({ showOnLaunch: item.checked }),
    },
    { label: "Closing the window", submenu: [close("hide"), close("quit")] },
    { type: "separator" },
    { label: "Quit AgentX", click: a.onQuit },
  ]
}
