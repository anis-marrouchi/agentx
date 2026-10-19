import { accessSync, constants } from "fs"
import { findOnPath } from "@/desktop/install"
import { readSystemFocus } from "@/notify/focus"
import type { NativeAdapter, NativeFocus } from "../types"
import { macosBanner } from "./banner"
import { macosNotes } from "./notes"
import type { Capture, Output, Run } from "./run"
import { macosSound } from "./sound"
import { macosTasks } from "./tasks"

/** Programs the adapter runs, so tests can stand in for them. */
export interface MacosIo {
  run?: Run
  capture?: Capture
  output?: Output
  /** The AgentX Helper binary; null means none. Unset: looked up on use. */
  helper?: string | null
  /** Is this file an executable? Used to find remindctl. */
  isExecutable?: (file: string) => boolean
}

const executable = (file: string): boolean => {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
}

/** System Focus from the private Focus database (notify/focus.ts). That
 *  reader answers "not in Focus" when it can't read the file, so here
 *  anything but a clean answer is null: the OS could not tell. */
const focus: NativeFocus = {
  async active() {
    const s = readSystemFocus()
    if (s.active) return true
    return s.reason === "no active Focus assertion" ? false : null
  },
}

export function macosAdapter(cfg: { reminders?: { command?: string } } = {}, io: MacosIo = {}): NativeAdapter {
  const command = cfg.reminders?.command || "remindctl"
  return {
    os: "macos",
    tasks: macosTasks(command, io.output),
    notes: macosNotes(io.output),
    banner: macosBanner(io),
    sound: macosSound(io),
    focus,
    async describe() {
      const problems: string[] = []
      const isExec = io.isExecutable ?? executable
      const found = command.includes("/") ? isExec(command) : !!findOnPath(command, process.env.PATH || "", isExec)
      if (!found) problems.push(`Reminders: ${command} not found (brew install steipete/tap/remindctl, or set reminders.command).`)
      return { os: "macos", tasks: true, notes: true, banner: true, sound: true, focus: true, problems }
    },
  }
}
