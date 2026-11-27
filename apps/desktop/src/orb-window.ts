// The floating orb window (#2265 PR 2): frameless, transparent, above other
// windows and on every workspace (full-screen apps too on macOS), out of the
// taskbar, dragged by the orb itself. Its place is kept in orb-state.json.
//
// The page is a local file (resources/orb) and holds no token. It records
// and plays; orb-voice.ts talks to the dashboard (#2265 PR 3).

import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { orbPlace, parsePlace, regrow, type Point } from "./orb-place.js"
import type { OrbView } from "./orb-preload.js"

export type { OrbView }

// The idle orb with its margins; the page sends its real size once loaded.
const START_SIZE = { width: 88, height: 88 }

export interface OrbOptions {
  resources: string
  userData: string
  log: (message: string, err?: unknown) => void
  /** Called when the window is shown or closed, so the tray can follow. */
  onChange: () => void
}

let win: BrowserWindow | null = null
let opts: OrbOptions
let dragFrom: Point | null = null

const placeFile = (): string => join(opts.userData, "orb-state.json")

function savedPlace(): Point | null {
  try {
    return existsSync(placeFile()) ? parsePlace(JSON.parse(readFileSync(placeFile(), "utf8"))) : null
  } catch (err) {
    opts.log("orb place unreadable, using the default place", err)
    return null
  }
}

function savePlace(w: BrowserWindow): void {
  const [x, y] = w.getPosition()
  try {
    writeFileSync(placeFile(), JSON.stringify({ x, y }))
  } catch (err) {
    opts.log("could not save the orb place", err)
  }
}

/** Messages from any page but the orb's are ignored. */
function fromOrb(e: IpcMainEvent): BrowserWindow | null {
  return win && !win.isDestroyed() && e.sender === win.webContents ? win : null
}

export function setupOrb(o: OrbOptions): void {
  opts = o
  ipcMain.on("orb:resize", (e, width: unknown, height: unknown) => {
    const w = fromOrb(e)
    // C4: NaN and Infinity are numbers too.
    if (!w || typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return
    const now = w.getBounds()
    // C2: kept on the work area of the screen it is on.
    const area = screen.getDisplayMatching(now).workArea
    w.setBounds(regrow(now, Math.min(width, 480), Math.min(height, 480), area))
  })
  ipcMain.on("orb:drag", (e, step: unknown, dx: unknown, dy: unknown) => {
    const w = fromOrb(e)
    if (!w) return
    if (step === "start") {
      const [x, y] = w.getPosition()
      dragFrom = { x, y }
    } else if (step === "move" && dragFrom && typeof dx === "number" && typeof dy === "number") {
      w.setPosition(Math.round(dragFrom.x + dx), Math.round(dragFrom.y + dy))
    } else if (step === "end") {
      dragFrom = null
      savePlace(w)
    }
  })
}

function createOrb(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  const at = orbPlace(savedPlace(), START_SIZE, areas, display.workArea)
  const w = new BrowserWindow({
    ...START_SIZE,
    ...at,
    title: "AgentX orb",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false, // the page draws its own shadow around the orb
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, "orb-preload.js"),
    },
  })
  // 'floating' keeps it above normal windows without covering menus and the Dock.
  w.setAlwaysOnTop(true, "floating")
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // The orb page never opens other pages.
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  w.webContents.on("will-navigate", (event) => event.preventDefault())
  w.webContents.on("did-fail-load", (_e, code, desc) => opts.log(`orb page did not load (${code} ${desc})`))
  w.once("ready-to-show", () => w.showInactive())
  w.on("show", opts.onChange)
  w.on("closed", () => {
    win = null
    opts.onChange()
  })
  void w.loadFile(join(opts.resources, "orb", "orb.html"))
  return w
}

export function orbVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible()
}

export function showOrb(): void {
  if (!win || win.isDestroyed()) win = createOrb()
  else win.showInactive()
}

export function hideOrb(): void {
  if (!win || win.isDestroyed()) return
  savePlace(win)
  win.close()
}

/** What the orb shows. */
export function showOrbState(view: OrbView): void {
  sendToOrb("orb:state", view)
}

/** A message to the orb page; dropped when the orb is closed. */
export function sendToOrb(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** True for the orb page's own contents (its microphone and its messages). */
export function isOrbContents(wc: Electron.WebContents): boolean {
  return !!win && !win.isDestroyed() && wc === win.webContents
}
