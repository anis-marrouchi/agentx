// AgentX desktop app: the daemon's Hub in a window, with a top-bar icon.
//
// The window loads the dashboard's /hub page. On this machine's loopback
// address the dashboard signs the page in by itself, so the app holds no
// token. The Hub's own voice controls work here because the window may use
// the microphone, for the dashboard's pages only.

import { app, BrowserWindow, dialog, Menu, session, shell, systemPreferences, type Rectangle } from "electron"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { allowsMedia, dashboardUrl, hubUrl, isDashboardOrigin, opensOutside } from "./hub.js"
import { offlinePage } from "./offline.js"
import { cliArgs, daemonTarget, readStatus, runCli, stopDaemon, type DaemonStatus } from "./daemon.js"
import type { TrayActions, TrayState } from "./menu.js"
import { loadSettings, saveSettings, type AppSettings } from "./settings.js"
import { createTray, updateTray } from "./tray.js"

const BASE = dashboardUrl()
const HUB = hubUrl(BASE)
// Packaged: resources sit next to app.asar; from a checkout: apps/desktop/resources.
const RESOURCES = app.isPackaged ? join(process.resourcesPath, "resources") : join(__dirname, "..", "resources")

let win: BrowserWindow | null = null
let quitting = false
let settings: AppSettings
const DAEMON = daemonTarget()
// Open at login: Electron sets it on macOS and Windows only.
const LOGIN_ITEM_SUPPORTED = process.platform === "darwin" || process.platform === "win32"
let daemonStatus: DaemonStatus | null = null
let daemonBusy: string | null = null

function log(message: string, err?: unknown): void {
  process.stderr.write(`[agentx-desktop] ${message}${err ? `: ${String(err)}` : ""}\n`)
}

// --- Window size and place, kept between launches ---

const stateFile = (): string => join(app.getPath("userData"), "window-state.json")

function savedBounds(): Partial<Rectangle> {
  try {
    if (!existsSync(stateFile())) return {}
    const b = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Rectangle>
    return typeof b.width === "number" && typeof b.height === "number" ? b : {}
  } catch (err) {
    log("window state unreadable, using the default size", err)
    return {}
  }
}

function saveBounds(w: BrowserWindow): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(w.getNormalBounds()))
  } catch (err) {
    log("could not save the window state", err)
  }
}

// --- The Hub window ---

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    ...savedBounds(),
    title: "AgentX",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: process.platform === "linux" ? join(RESOURCES, "tray.png") : undefined,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  w.on("show", refreshTray)
  w.on("hide", refreshTray)

  // Other sites open in the browser; the window stays on the dashboard.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (opensOutside(url, BASE)) void shell.openExternal(url)
    else if (isDashboardOrigin(url, BASE)) void w.loadURL(url)
    return { action: "deny" }
  })
  w.webContents.on("will-navigate", (event, url) => {
    if (isDashboardOrigin(url, BASE)) return
    event.preventDefault()
    if (opensOutside(url, BASE)) void shell.openExternal(url)
  })

  // Dashboard down: say so, with a Try again link back to the Hub.
  w.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: a navigation replaced this one */) return
    log(`could not load ${url} (${code} ${desc})`)
    void w.loadURL(offlinePage(HUB))
  })

  // Closing hides the window to the tray, or quits, as the tray menu says.
  w.on("close", (event) => {
    saveBounds(w)
    if (quitting) return
    if (settings.closeAction === "quit") {
      app.quit()
      return
    }
    event.preventDefault()
    w.hide()
  })

  void w.loadURL(HUB)
  return w
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow()
}

// --- Tray: window, daemon and settings ---

const trayActions: TrayActions = {
  onToggleWindow: toggleWindow,
  onQuit: () => app.quit(),
  onDaemon: (action) => void daemonAction(action),
  onSetting: changeSetting,
}

function trayState(): TrayState {
  return {
    windowVisible: !!win && !win.isDestroyed() && win.isVisible(),
    daemon: daemonStatus,
    busy: daemonBusy,
    settings,
    loginItemSupported: LOGIN_ITEM_SUPPORTED,
  }
}

function refreshTray(): void {
  updateTray(trayActions, trayState())
}

function changeSetting(change: Partial<AppSettings>): void {
  settings = { ...settings, ...change }
  if ("openAtLogin" in change && !applyLoginItem()) {
    // The system kept its own value: show that, not the wish.
    settings.openAtLogin = !settings.openAtLogin
    dialog.showErrorBox("Open at login was not changed", "The system refused it. On macOS this needs a signed copy of the app.")
  }
  try {
    saveSettings(app.getPath("userData"), settings)
  } catch (err) {
    log("could not save the settings", err)
  }
  refreshTray()
}

/** Sets the system's login item to the saved choice; false when the system refused. */
function applyLoginItem(): boolean {
  if (!LOGIN_ITEM_SUPPORTED) return true
  try {
    if (app.getLoginItemSettings().openAtLogin === settings.openAtLogin) return true
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin })
    if (app.getLoginItemSettings().openAtLogin === settings.openAtLogin) return true
    log(`Open at login: the system kept ${!settings.openAtLogin}`)
  } catch (err) {
    log("could not change Open at login", err)
  }
  return false
}

async function pollDaemon(): Promise<void> {
  if (daemonBusy) return
  const next = await readStatus(DAEMON)
  const changed = JSON.stringify(next) !== JSON.stringify(daemonStatus)
  daemonStatus = next
  if (changed) refreshTray()
}

const BUSY_LABEL = { start: "starting", stop: "stopping", restart: "restarting" } as const

async function daemonAction(action: "start" | "stop" | "restart"): Promise<void> {
  if (daemonBusy) return
  daemonBusy = BUSY_LABEL[action]
  refreshTray()
  log(`daemon ${action} (${DAEMON.url})`)
  try {
    if (action === "stop") {
      stopDaemon(await readStatus(DAEMON)) // throws with the reason when Stop is not allowed
      await waitFor(async () => !(await readStatus(DAEMON)).running)
    } else {
      await runCli(DAEMON, cliArgs(action, DAEMON.config))
      await waitFor(async () => (await readStatus(DAEMON)).running)
    }
  } catch (err) {
    log(`daemon ${action} failed`, err)
    dialog.showErrorBox(`Could not ${action} the daemon`, err instanceof Error ? err.message : String(err))
  } finally {
    daemonBusy = null
    daemonStatus = null
    await pollDaemon()
    if (action !== "stop" && win && !win.isDestroyed()) void win.loadURL(HUB)
  }
}

/** Waits up to 6 min (the daemon finishes running tasks before it stops). */
async function waitFor(ok: () => Promise<boolean>, limitMs = 6 * 60_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("the daemon did not answer as expected in time; check it with: agentx daemon status")
}

// --- Microphone: dashboard pages only, audio only ---

function guardDevices(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== "media") return callback(false)
    const origin = details.requestingUrl || wc.getURL()
    const ok = allowsMedia(origin, BASE, (details as { mediaTypes?: string[] }).mediaTypes)
    if (!ok || process.platform !== "darwin") return callback(ok)
    // macOS asks the person once; the answer is kept in System Settings.
    systemPreferences
      .askForMediaAccess("microphone")
      .then(callback)
      .catch((err) => {
        log("microphone access request failed", err)
        callback(false)
      })
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && isDashboardOrigin(origin, BASE))
}

// --- Menus ---

function appMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Open Hub", accelerator: "CmdOrCtrl+1", click: () => (showWindow(), void win?.loadURL(HUB)) },
          { role: "reload" },
          { role: "togglefullscreen" },
          { type: "separator" },
          { role: "toggleDevTools" },
        ],
      },
      { role: "windowMenu" },
    ]),
  )
}

// --- Start ---

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => showWindow())
  app.on("activate", showWindow) // macOS: Dock click
  app.on("before-quit", () => {
    quitting = true
  })
  app.on("window-all-closed", () => {
    // Stay in the top bar; Quit is in the tray menu and the app menu.
  })
  app
    .whenReady()
    .then(() => {
      settings = loadSettings(app.getPath("userData"), (err) => log("settings unreadable, using the defaults", err))
      // The menu shows what the system holds, even when it refused the saved choice.
      if (!applyLoginItem()) settings.openAtLogin = app.getLoginItemSettings().openAtLogin
      guardDevices()
      appMenu()
      createTray(RESOURCES, trayActions, trayState())
      void pollDaemon()
      setInterval(() => void pollDaemon(), 5000)
      // Off: the app starts in the tray only; the window loads on first Show.
      if (settings.showOnLaunch) showWindow()
    })
    .catch((err) => {
      log("start failed", err)
      app.exit(1)
    })
}
