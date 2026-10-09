// --- Who may send a stop or resume signal, and the loop brake (#857) ---
//
// "Signal" here is a stop or resume addressed to a running agent task. It
// is unrelated to workflow signals (src/workflows/signals.ts: SignalBus,
// `signal.emit` / `signal.wait`); on the event bus both are kind `signal`,
// told apart by type (`emitted` vs `signal:stop`, `signal:stopped`,
// `signal:resume`, `signal:resume-failed`).
//
// Pure: given who is asking, the task and the settings, allow or refuse.
// Rules, in order:
//   - the owner (dashboard, CLI, operator HTTP) may always signal;
//   - a mesh peer may signal only when `allowPeers` names it, and then only
//     as itself or as one of its agents that the rules below would allow;
//   - an agent may signal a task it dispatched (the task's sender is
//     `agent:<id>`), or any task when `allowAgents` names it;
//   - an agent never signals its own running task (it can just stop).
// Agents' and peers' signals are counted per root id, and past `maxPerRoot`
// in a day the next one is refused: a stop that wakes an agent that resumes
// it that wakes … stops there, whatever the subscriptions say. The owner is
// never counted or refused.

export interface SignalSettings {
  enabled: boolean
  /** How long the agent gets to write its resume plan before it is stopped
   *  and a plan is built from its trace instead. */
  windDownSeconds: number
  /** Agents that may stop or resume any agent's task on this node. */
  allowAgents: string[]
  /** Mesh peers (node names) whose signals this node accepts. */
  allowPeers: string[]
  /** Most signals one root id may carry in a day. */
  maxPerRoot: number
}

export const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  enabled: true,
  windDownSeconds: 120,
  allowAgents: [],
  allowPeers: [],
  maxPerRoot: 6,
}

export type SignalKind = "stop" | "resume"

/** Who sent a signal. `owner` is the operator; `agent` an agent on this
 *  node (or on `peer` when set); `peer` a mesh node acting for its owner. */
export type SignalSender =
  | { kind: "owner"; name?: string }
  | { kind: "agent"; agentId: string; peer?: string }
  | { kind: "peer"; peer: string }

export interface SignalTarget {
  agentId: string
  /** The task's sender as its context named it ("agent:<id>", a user…). */
  sender?: string
}

export type SignalDecision = { ok: true } | { ok: false; reason: string }

/** The agent that dispatched a task, from its sender (`agent:<id>`). */
export function dispatcherOf(sender: string | undefined): string | null {
  const m = String(sender ?? "").match(/^agent:([^\s]+)$/)
  return m ? m[1] : null
}

export function describeSender(s: SignalSender): string {
  if (s.kind === "owner") return s.name ? `owner (${s.name})` : "owner"
  if (s.kind === "peer") return `peer ${s.peer}`
  return s.peer ? `${s.agentId}@${s.peer}` : s.agentId
}

export function canSignal(sender: SignalSender, target: SignalTarget, settings: SignalSettings): SignalDecision {
  if (!settings.enabled) return { ok: false, reason: "signals are turned off on this node (signals.enabled)" }
  if (sender.kind === "owner") return { ok: true }
  const peer = sender.kind === "peer" ? sender.peer : sender.peer
  if (peer && !settings.allowPeers.map((p) => p.toLowerCase()).includes(peer.toLowerCase())) {
    return { ok: false, reason: `mesh peer "${peer}" is not in signals.allowPeers` }
  }
  // A named peer acts for its owner.
  if (sender.kind === "peer") return { ok: true }
  if (sender.agentId === target.agentId) {
    return { ok: false, reason: "an agent cannot signal its own task" }
  }
  if (dispatcherOf(target.sender) === sender.agentId) return { ok: true }
  if (settings.allowAgents.includes(sender.agentId) || settings.allowAgents.includes("*")) return { ok: true }
  return { ok: false, reason: `${sender.agentId} did not dispatch this task and is not in signals.allowAgents` }
}

const DAY_MS = 24 * 60 * 60 * 1000
const ROOTS_CAP = 5000

/** Per-root signal count over a sliding day. */
export class SignalBudget {
  private roots = new Map<string, number[]>()

  constructor(private now: () => number = Date.now) {}

  /** Count a signal under `rootId`; false when the budget is spent (and
   *  the signal is not counted). */
  take(rootId: string, max: number): boolean {
    const t = this.now()
    const recent = (this.roots.get(rootId) ?? []).filter((at) => t - at < DAY_MS)
    if (recent.length >= max) { this.roots.set(rootId, recent); return false }
    recent.push(t)
    this.roots.delete(rootId)
    this.roots.set(rootId, recent)
    if (this.roots.size > ROOTS_CAP) this.roots.delete(this.roots.keys().next().value as string)
    return true
  }
}
