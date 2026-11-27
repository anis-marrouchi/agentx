// The orb page's only link to the app (sandboxed preload): it may size and
// drag its own window, hand over what it recorded, and receive the state to
// show and the answer to play. Nothing else.

import { contextBridge, ipcRenderer } from "electron"

export interface OrbView {
  state: "idle" | "listening" | "thinking" | "speaking" | "callback"
  title?: string
  text?: string
  unread?: number
  level?: number
}

/** The answer to say: audio from the node, or text for the system's own voice. */
export interface OrbPlay {
  audio?: ArrayBuffer
  type?: string
  text?: string
  system?: boolean
}

contextBridge.exposeInMainWorld("agentxOrb", {
  resize: (width: number, height: number) => ipcRenderer.send("orb:resize", width, height),
  dragStart: () => ipcRenderer.send("orb:drag", "start"),
  dragMove: (dx: number, dy: number) => ipcRenderer.send("orb:drag", "move", dx, dy),
  dragEnd: () => ipcRenderer.send("orb:drag", "end"),
  begin: () => ipcRenderer.send("orb:begin"),
  partial: (bytes: ArrayBuffer, type: string, ms: number, id: number) => ipcRenderer.send("orb:partial", bytes, type, ms, id),
  final: (bytes: ArrayBuffer, type: string, ms: number) => ipcRenderer.send("orb:final", bytes, type, ms),
  cancel: () => ipcRenderer.send("orb:cancel"),
  played: () => ipcRenderer.send("orb:played"),
  onState: (cb: (view: OrbView) => void) => {
    ipcRenderer.on("orb:state", (_e, view: OrbView) => cb(view))
  },
  /** The talk key from the app: "start" or "stop". */
  onTalk: (cb: (edge: "start" | "stop") => void) => {
    ipcRenderer.on("orb:talk", (_e, edge: "start" | "stop") => cb(edge))
  },
  /** Words of a rolling pass, or null when it was dropped or failed, with the pass id it answers. */
  onPartial: (cb: (text: string | null, id: number) => void) => {
    ipcRenderer.on("orb:partial", (_e, text: string | null, id: number) => cb(text, id))
  },
  onPlay: (cb: (play: OrbPlay) => void) => {
    ipcRenderer.on("orb:play", (_e, play: OrbPlay) => cb(play))
  },
})
