import { createHmac, randomBytes, timingSafeEqual } from "crypto"

// --- A secret per agent turn (#1892 phase 7) ---
//
// A running task's id is public on this machine (GET /agents lists
// runningTasks[].id), so it cannot prove which agent calls a daemon route.
// Each agent process gets, in its environment, a secret derived from the
// turn it runs: an HMAC of the task id (or, for a warm process kept per
// chat, of the agent and chat) under a key that exists only in this
// daemon's memory. A route that guards private data asks for it next to
// the usual proof headers. A daemon restart changes the key: old secrets
// stop working, which is the safe side.
//
// Limit: agents run as the same macOS user, so one agent's shell can read
// another agent process's environment (`ps eww`). This stops callers that
// only know public ids, not an agent that reads other processes.

const KEY = randomBytes(32)

export const TURN_SECRET_ENV = "AGENTX_TURN_SECRET"
export const TURN_SECRET_HEADER = "X-AgentX-Turn-Secret"

function mac(scope: string): string {
  return createHmac("sha256", KEY).update(scope).digest("hex").slice(0, 40)
}

/** The secret of a run with this task id. */
export function taskSecret(taskId: string): string {
  return mac(`task:${taskId}`)
}

/** The secret of a warm process kept for this agent and chat. */
export function chatSecret(agentId: string, channel: string, chatId: string): string {
  return mac(`chat:${agentId}:${channel}:${chatId}`)
}

/** Constant-time compare; false for anything missing. */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
