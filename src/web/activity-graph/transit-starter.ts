// The map's first column: who or what started a piece of work (#432).
// The server resolves it (daemon/activity-graph-starter.ts); this is the
// client's view of it.

import type { FleetDispatch, Starter } from "./api"

const AGENTX: Starter = { kind: "agentx", id: "agentx", name: "AgentX" }
const UNKNOWN: Starter = { kind: "person", id: "unknown", name: "Unknown" }
export const STARTER_KIND: Record<Starter["kind"], string> = { person: "Person", agentx: "AgentX", external: "External system" }

const AGENTX_CHANNELS = new Set(["cron", "workflow", "mesh", "a2a", "mcp"])

/** A run's initiator. A mesh peer on an older version sends none; then only
 *  what the channel itself says is used, and a person is never guessed. */
export function starterOf(d: FleetDispatch): Starter {
  return d.starter ?? (AGENTX_CHANNELS.has(d.root?.channel ?? d.channelId) ? AGENTX : UNKNOWN)
}
