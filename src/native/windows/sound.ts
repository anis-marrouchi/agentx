import { win32 } from "path"
import type { NativeSound } from "../types"
import { run as defaultRun, type Run } from "../macos/run"
import { POWERSHELL, psArgs, psString } from "./powershell"

// Windows keeps its system sounds as .wav files in %WINDIR%\Media
// ("Windows Notify System Generic", "chimes", "tada" and so on). PowerShell's
// SoundPlayer plays one with nothing installed. It has no volume control,
// so the volume only decides whether the sound plays at all.

export interface WindowsSoundIo {
  run?: Run
  /** The Media folder; defaults to %WINDIR%\Media. */
  media: string
  exists: (path: string) => boolean
  list: (dir: string) => string[]
}

/** The .wav for a sound name, or null. Names only: a path in the config
 *  must not reach the player. */
export function windowsSoundPath(name: string, io: Pick<WindowsSoundIo, "media" | "exists">): string | null {
  if (!/^[\w -]+$/.test(name)) return null
  const path = win32.join(io.media, `${name}.wav`)
  return io.exists(path) ? path : null
}

export function windowsSound(io: WindowsSoundIo): NativeSound {
  const exec = io.run ?? defaultRun
  return {
    async play(name, volume) {
      const path = windowsSoundPath(name, io)
      if (!path || !(volume > 0)) return
      await exec(POWERSHELL, psArgs(`(New-Object Media.SoundPlayer ${psString(path)}).PlaySync()`))
    },
    has: (name) => windowsSoundPath(name, io) !== null,
    async names() {
      try {
        return io.list(io.media).filter((f) => /\.wav$/i.test(f)).map((f) => f.slice(0, -4)).sort()
      } catch {
        return []
      }
    },
  }
}
