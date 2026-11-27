// The orb page's only link to the app (sandboxed preload): it may size and
// drag its own window and receive the state to show. Nothing else.

import { contextBridge, ipcRenderer } from "electron"

export interface OrbView {
  state: "idle" | "listening" | "thinking" | "speaking" | "callback"
  title?: string
  text?: string
  unread?: number
  level?: number
}

contextBridge.exposeInMainWorld("agentxOrb", {
  resize: (width: number, height: number) => ipcRenderer.send("orb:resize", width, height),
  dragStart: () => ipcRenderer.send("orb:drag", "start"),
  dragMove: (dx: number, dy: number) => ipcRenderer.send("orb:drag", "move", dx, dy),
  dragEnd: () => ipcRenderer.send("orb:drag", "end"),
  onState: (cb: (view: OrbView) => void) => {
    ipcRenderer.on("orb:state", (_e, view: OrbView) => cb(view))
  },
})
