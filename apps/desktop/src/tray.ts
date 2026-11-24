// The top-bar (macOS) / notification-area (Windows, Ubuntu) icon.
//
// Adapted from Orca's src/main/tray/system-tray.ts
// (https://github.com/stablyai/orca), Copyright (c) 2026 Lovecast Inc.,
// MIT licence: see ../LICENSE.orca. Taken: one live module-level reference
// so the icon is not garbage-collected, a template image with a 2x
// representation on macOS, and the 16px app image on the other systems.

import { Menu, Tray, nativeImage, type NativeImage } from "electron"
import { join } from "path"

export interface TrayActions {
  onOpen: () => void
  onReload: () => void
  onQuit: () => void
}

// Keep a live reference or Electron's GC removes the tray icon.
let tray: Tray | null = null

// Windows' notification-area slot is 16px.
const TRAY_ICON_SIZE = 16

function trayImage(resources: string): NativeImage {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromPath(join(resources, "trayTemplate.png"))
    const retina = nativeImage.createFromPath(join(resources, "trayTemplate@2x.png"))
    if (!retina.isEmpty()) image.addRepresentation({ scaleFactor: 2, dataURL: retina.toDataURL() })
    // Template: macOS draws it black or white to match the menu bar.
    image.setTemplateImage(true)
    return image
  }
  return nativeImage.createFromPath(join(resources, "tray.png")).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
}

export function createTray(resources: string, actions: TrayActions): Tray {
  if (tray && !tray.isDestroyed()) return tray
  tray = new Tray(trayImage(resources))
  tray.setToolTip("AgentX")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open AgentX", click: actions.onOpen },
      { label: "Reload", click: actions.onReload },
      { type: "separator" },
      { label: "Quit AgentX", click: actions.onQuit },
    ]),
  )
  // Windows and Ubuntu: a left click opens the window; the menu is on right click.
  if (process.platform !== "darwin") tray.on("click", actions.onOpen)
  return tray
}
