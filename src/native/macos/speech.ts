import type { NativeSpeech } from "../types"
import { capture as defaultCapture, type Capture } from "./run"

// --- Is something else speaking on this Mac? (#1126) ---
//
// A script that narrates with `say`, or plays a recording with `afplay`,
// talks to the person at this Mac without going through AgentX's speaking
// queue. Before AgentX speaks or chimes, it looks at the process list:
// one such program running, not started by AgentX itself, means wait.

/** Programs that speak or play sound, and how the owner would say it. */
const SPEAKERS: Record<string, string> = { say: "a spoken line (say)", afplay: "a sound playing (afplay)" }

/** "pid ppid command" lines from ps, the speakers among them. */
export function speakersIn(ps: string, exceptParents: number[], self = process.pid): string | null {
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
    if (!m) continue
    const [pid, ppid, comm] = [Number(m[1]), Number(m[2]), m[3]]
    const name = comm.slice(comm.lastIndexOf("/") + 1)
    if (!(name in SPEAKERS) || pid === self || exceptParents.includes(ppid)) continue
    return SPEAKERS[name]
  }
  return null
}

export function macosSpeech(io: { capture?: Capture } = {}): NativeSpeech {
  const capture = io.capture ?? defaultCapture
  return {
    async othersSpeaking(opts = {}) {
      const ps = await capture("/bin/ps", ["-axo", "pid=,ppid=,comm="])
      return ps ? speakersIn(ps, opts.exceptParents ?? []) : null
    },
  }
}
