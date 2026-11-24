// AgentX desktop app: the daemon's Hub in a window, with a top-bar icon.
//
// The window loads the dashboard's /hub page. On this machine's loopback
// address the dashboard signs the page in by itself, so the app holds no
// token. The Hub's own voice controls work here because the window may use
// the microphone, for the dashboard's pages only.

import { app, BrowserWindow, Menu, session, shell, systemPreferences, type Rectangle } from "electron"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { allowsMedia, dashboardUrl, hubUrl, isDashboardOrigin, opensOutside } from "./hub.js"
import { offlinePage } from "./offline.js"
import { createTray } from "./tray.js"

const BASE = dashboardUrl()
const HUB = hubUrl(BASE)
// Packaged: resources sit next to app.asar; from a checkout: apps/desktop/resources.
const RESOURCES = app.isPackaged ? join(process.resourcesPath, "resources") : join(__dirname, "..", "resources")

let win: BrowserWindow | null = null
let quitting = false

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
  w.once("ready-to-show", () => w.show())

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

  // Closing hides the window; the app stays in the top bar until Quit.
  w.on("close", (event) => {
    saveBounds(w)
    if (quitting) return
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
  app.on("second-instance", showWindow)
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
      guardDevices()
      appMenu()
      createTray(RESOURCES, {
        onOpen: showWindow,
        onReload: () => (showWindow(), void win?.loadURL(HUB)),
        onQuit: () => app.quit(),
      })
      showWindow()
    })
    .catch((err) => {
      log("start failed", err)
      app.exit(1)
    })
}
