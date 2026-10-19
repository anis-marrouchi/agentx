import { existsSync, readdirSync } from "fs"
import type { NativeSound } from "../types"
import { run as defaultRun, type Run } from "./run"

const SOUNDS = "/System/Library/Sounds"

/** The system sound file for a name, or null when there is none. Names
 *  only: a path in the config must not reach afplay. */
export function soundPath(name: string): string | null {
  if (!/^[\w -]+$/.test(name)) return null
  const path = `${SOUNDS}/${name}.aiff`
  return existsSync(path) ? path : null
}

export function macosSound(io: { run?: Run } = {}): NativeSound {
  const exec = io.run ?? defaultRun
  return {
    async play(name, volume) {
      const path = soundPath(name)
      if (!path) return
      await exec("/usr/bin/afplay", ["-v", String(Math.min(1, Math.max(0, volume))), path])
    },
    has: (name) => soundPath(name) !== null,
    async names() {
      try {
        return readdirSync(SOUNDS).filter((f) => f.endsWith(".aiff")).map((f) => f.slice(0, -5)).sort()
      } catch {
        return []
      }
    },
  }
}
