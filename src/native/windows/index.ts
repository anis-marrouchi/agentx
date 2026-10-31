import { existsSync, readdirSync } from "fs"
import { win32 } from "path"
import { findHelper } from "@/desktop/install"
import type { NativeAdapter } from "../types"
import type { Capture, Run } from "../macos/run"
import { windowsBanner } from "./banner"
import { windowsIdle } from "./idle"
import { windowsSound } from "./sound"

// --- Windows (#1594) ---
//
// Only what Windows does with nothing installed: toasts, system sounds and
// idle time. Tasks, notes and Focus have no adapter here yet, so callers see
// them as absent and keep their own fallbacks; describe() says so.

/** Programs and files the adapter touches, so tests can stand in for them. */
export interface WindowsIo {
  run?: Run
  capture?: Capture
  /** The desktop helper binary; null means none. Unset: looked up on use. */
  helper?: string | null
  /** %WINDIR%\Media; defaults from WINDIR. */
  media?: string
  exists?: (path: string) => boolean
  list?: (dir: string) => string[]
}

export function windowsAdapter(_cfg: unknown = {}, io: WindowsIo = {}): NativeAdapter {
  const helper = () => (io.helper === undefined ? findHelper() : io.helper)
  const media = io.media ?? win32.join(process.env.WINDIR || process.env.SystemRoot || "C:\\Windows", "Media")
  const exists = io.exists ?? existsSync
  const list = io.list ?? ((dir: string) => readdirSync(dir))
  return {
    os: "windows",
    banner: windowsBanner({ run: io.run, capture: io.capture, helper }),
    sound: windowsSound({ run: io.run, media, exists, list }),
    idle: windowsIdle({ capture: io.capture }),
    async describe() {
      const problems = ["Tasks, notes and Focus: AgentX has no Windows adapter for these yet."]
      if (!helper()) problems.push("Banners come from Windows PowerShell until the AgentX Windows helper is installed.")
      return { os: "windows", tasks: false, notes: false, banner: true, sound: true, focus: false, problems }
    },
  }
}
