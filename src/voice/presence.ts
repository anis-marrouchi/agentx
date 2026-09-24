// --- An agent's presence on screen: its own drawn cursor ---
//
// apps/mac-helper `presence` draws a click-through cursor in the agent's
// colour with its initial and name, glides it to what the agent means,
// highlights it, and shows the line being spoken in a bubble. The
// person's real mouse is never moved; only presence mode "act", with
// actions allowed, touches it, and that goes through the helper's own
// point/click/type verbs, not through this overlay.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { existsSync } from "fs"
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
}

/** The mac-helper overlay process for one agent. */
export class PresenceOverlay implements Presence {
  private child: ChildProcessWithoutNullStreams | null

  constructor(look: PresenceLook, helper: string) {
    this.child = existsSync(helper)
      ? (spawn(helper, ["presence", "--name", look.name, "--initial", look.initial, "--color", look.color]) as ChildProcessWithoutNullStreams)
      : null
    this.child?.on("error", () => { this.child = null })
    this.child?.on("exit", () => { this.child = null })
    this.child?.stdin.on("error", () => {})
  }

  get alive(): boolean { return this.child !== null }

  moveTo(r: Rect, opts: { highlight?: boolean } = {}): void {
    this.send({ cmd: "move", x: r.x, y: r.y, w: r.width, h: r.height, highlight: !!opts.highlight })
  }
  say(text: string): void { this.send({ cmd: "say", text }) }
  clear(): void { this.send({ cmd: "clear" }) }
  park(): void { this.send({ cmd: "park" }) }
  close(): void { this.child?.stdin.end(); this.child = null }

  private send(o: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(o) + "\n")
  }
}
