// --- An agent's presence on screen: its own drawn cursor ---
//
// apps/mac-helper `presence` draws a click-through cursor in the agent's
// colour with its initial and name, glides it to what the agent means,
// highlights it, and shows the line being spoken in a bubble. The
// person's real mouse is never moved; only presence mode "act", with
// actions allowed, touches it, and that goes through the helper's own
// point/click/type verbs, not through this overlay.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { DaemonConfig } from "@/daemon/config"

type AgentConfig = DaemonConfig["agents"][string]

export interface PresenceLook {
  name: string
  initial: string
  color: string
  allowActions: boolean
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Distinct, readable on light and dark UIs, none of them system blue. */
const PALETTE = ["#7C3AED", "#DB2777", "#EA580C", "#0D9488", "#2563EB", "#65A30D", "#C026D3", "#0891B2"]

export function presenceLook(agentId: string, agent?: Partial<AgentConfig>): PresenceLook {
  const p = agent?.presence
  const name = p?.label || agent?.name || agentId
  let h = 0
  for (const c of agentId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return {
    name,
    initial: (p?.initial || name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1) || "?").toUpperCase(),
    color: p?.color || PALETTE[h % PALETTE.length],
    allowActions: p?.allowActions === true,
  }
}

/** What a presence can be told to do. The overlay implements it on macOS;
 *  tests and headless hosts use a recorder. */
export interface Presence {
  moveTo(rect: Rect, opts?: { highlight?: boolean }): void
  say(text: string): void
  clear(): void
  park(): void
  close(): void
  /** Keep-alive: the overlay fades out after IDLE_SECONDS without a command. */
  ping?(): void
  /** False once the overlay's process has gone. */
  readonly alive?: boolean
}

/** The helper fades out and exits after this long with no command, so an
 *  overlay whose owner forgot it cannot stay on screen. Owners that hold
 *  one on purpose ping it well inside this. */
export const IDLE_SECONDS = 60

// --- One overlay per agent, machine-wide ---
//
// The daemon, `agentx teach --live` and a daemon from before a restart can
// all draw the same agent. Each overlay's pid is recorded in
// ~/.agentx/presence/<agentId>.pid; whoever draws next ends the previous
// one first, so an agent is never on screen twice.

export const presenceDir = () => process.env.AGENTX_PRESENCE_DIR || join(homedir(), ".agentx", "presence")
const safeId = (agentId: string) => agentId.replace(/[^\w.-]/g, "_")
const pidFile = (dir: string, agentId: string) => join(dir, `${safeId(agentId)}.pid`)
/** Where the person dragged this agent's name tag. The helper reads and
 *  writes it; it outlives every overlay, so the tag stays where it was put. */
export const posFile = (dir: string, agentId: string) => join(dir, `${safeId(agentId)}.pos`)

/** Swapped in tests: the process table and signals. */
export interface ProcessOps {
  command(pid: number): string | null
  kill(pid: number): void
  /** Presence helpers whose parent has died (re-parented to launchd). */
  orphans(): number[]
}

const isPresenceHelper = (cmd: string | null) => !!cmd && /agentx-mac-helper\S*\s+presence\b/.test(cmd)

export const systemProcesses: ProcessOps = {
  command(pid) {
    try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null } catch { return null }
  },
  kill(pid) {
    try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
  },
  orphans() {
    try {
      return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && m[2] === "1" && isPresenceHelper(m[3]))
        .map((m) => Number(m[1]))
    } catch { return [] }
  },
}

/** End the overlay recorded for this agent, if it is still a presence helper. */
export function endRecorded(agentId: string, dir = presenceDir(), ps: ProcessOps = systemProcesses): void {
  const file = pidFile(dir, agentId)
  let pid: number
  try { pid = Number(readFileSync(file, "utf8").trim()) } catch { return }
  if (pid > 0 && pid !== process.pid && isPresenceHelper(ps.command(pid))) ps.kill(pid)
  try { unlinkSync(file) } catch { /* raced */ }
}

/**
 * On daemon start: end every recorded overlay (their owner is gone or
 * about to redraw) and every presence helper whose parent has died.
 * Returns how many were ended.
 */
export function reapPresence(dir = presenceDir(), ps: ProcessOps = systemProcesses): number {
  let n = 0
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => f.endsWith(".pid")) } catch { /* none yet */ }
  for (const f of files) {
    const pid = Number(readFileSync(join(dir, f), "utf8").trim())
    if (pid > 0 && isPresenceHelper(ps.command(pid))) { ps.kill(pid); n++ }
    try { unlinkSync(join(dir, f)) } catch { /* raced */ }
  }
  for (const pid of ps.orphans()) { ps.kill(pid); n++ }
  return n
}

/** The mac-helper overlay process for one agent, the only one on this machine. */
export class PresenceOverlay implements Presence {
  private child: ChildProcessWithoutNullStreams | null

  constructor(look: PresenceLook, helper: string, agentId: string, dir = presenceDir()) {
    if (!existsSync(helper)) { this.child = null; return }
    endRecorded(agentId, dir)
    const child = spawn(helper, [
      "presence", "--name", look.name, "--initial", look.initial, "--color", look.color,
      // The helper also exits on its own when this process dies or goes quiet.
      "--parent", String(process.pid), "--idle", String(IDLE_SECONDS),
      "--pos-file", posFile(dir, agentId),
    ]) as ChildProcessWithoutNullStreams
    this.child = child
    const file = pidFile(dir, agentId)
    if (child.pid) {
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, String(child.pid)) } catch { /* registry is best effort */ }
    }
    const gone = () => {
      if (this.child === child) this.child = null
      try { if (readFileSync(file, "utf8").trim() === String(child.pid)) unlinkSync(file) } catch { /* not ours */ }
    }
    child.on("error", gone)
    child.on("exit", gone)
    child.stdin.on("error", () => {})
  }

  get alive(): boolean { return this.child !== null }

  moveTo(r: Rect, opts: { highlight?: boolean } = {}): void {
    this.send({ cmd: "move", x: r.x, y: r.y, w: r.width, h: r.height, highlight: !!opts.highlight })
  }
  say(text: string): void { this.send({ cmd: "say", text }) }
  clear(): void { this.send({ cmd: "clear" }) }
  park(): void { this.send({ cmd: "park" }) }
  ping(): void { this.send({ cmd: "ping" }) }
  /** EOF: the helper fades out and exits. */
  close(): void { this.child?.stdin.end(); this.child = null }

  private send(o: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(o) + "\n")
  }
}
